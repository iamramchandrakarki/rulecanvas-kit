import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT_GATE_DIST = path.join(REPO_ROOT, 'apps/agent-gate/dist');
const INTERLOCK_SIM_DIST = path.join(REPO_ROOT, 'apps/interlock-sim/dist');
const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'rulecanvas-browser-qa-screenshots');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function assert(cond, msg) {
  if (!cond) throw new Error(`Browser E2E failed: ${msg}`);
}

async function loadBrowserTools() {
  const pwCandidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs',
  ].filter(Boolean);

  let playwrightMod = null;
  let resolvedPwCandidate = null;
  for (const candidate of pwCandidates) {
    try {
      const spec = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(spec);
      if (mod?.chromium) {
        playwrightMod = mod;
        resolvedPwCandidate = candidate;
        break;
      }
    } catch {
      // try next
    }
  }
  if (playwrightMod === null) {
    throw new Error('Playwright module not found. Set PLAYWRIGHT_MODULE or install playwright.');
  }

  const axeCandidates = [process.env.AXE_PLAYWRIGHT_MODULE].filter(Boolean);
  if (resolvedPwCandidate?.startsWith('/')) {
    try {
      const req = createRequire(resolvedPwCandidate);
      axeCandidates.push(req.resolve('@axe-core/playwright'));
    } catch {
      // ignore
    }
  }
  axeCandidates.push('@axe-core/playwright');

  let AxeBuilder = null;
  for (const candidate of axeCandidates) {
    try {
      const spec = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(spec);
      const ctor = mod?.default ?? mod?.AxeBuilder;
      if (typeof ctor === 'function') {
        AxeBuilder = ctor;
        break;
      }
    } catch {
      // try next
    }
  }
  if (AxeBuilder === null) {
    throw new Error(
      '@axe-core/playwright module not found. Set AXE_PLAYWRIGHT_MODULE or install @axe-core/playwright.',
    );
  }

  return { chromium: playwrightMod.chromium, AxeBuilder };
}

function startStaticSubpathServer() {
  assert(existsSync(AGENT_GATE_DIST), 'apps/agent-gate/dist missing — run pnpm build first');
  assert(existsSync(INTERLOCK_SIM_DIST), 'apps/interlock-sim/dist missing — run pnpm build first');

  const mounts = [
    { prefix: '/suite/agent-gate/', dir: AGENT_GATE_DIST },
    { prefix: '/suite/interlock-sim/', dir: INTERLOCK_SIM_DIST },
  ];
  if (process.env.BOOKING_FIXTURE_DIST) {
    const dir = path.resolve(process.env.BOOKING_FIXTURE_DIST);
    assert(existsSync(path.join(dir, 'index.html')), 'Packed booking production fixture is missing');
    mounts.push({ prefix: '/booking-demo/', dir });
  }

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    for (const mount of mounts) {
      if (pathname === mount.prefix.slice(0, -1)) {
        res.writeHead(302, { Location: `${mount.prefix}${reqUrl.search}` });
        res.end();
        return;
      }
      if (pathname.startsWith(mount.prefix)) {
        const rel = pathname.slice(mount.prefix.length) || 'index.html';
        const full = path.resolve(mount.dir, rel);
        if (!full.startsWith(mount.dir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const target =
          existsSync(full) && statSync(full).isFile() ? full : path.join(mount.dir, 'index.html');
        const ext = path.extname(target);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
        res.end(readFileSync(target));
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

mkdirSync(SCREENSHOT_DIR, { recursive: true });
const { chromium, AxeBuilder } = await loadBrowserTools();
const { server, baseUrl } = await startStaticSubpathServer();

let browser = null;
try {
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const axeAudits = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url()}`);
  });

  const checkNoOverflow = async (label) => {
    const report = await page.evaluate(() => {
      const vw = window.innerWidth;
      const docOverflow = document.documentElement.scrollWidth > vw;
      const clippedControls = [];
      const els = document.querySelectorAll(
        'header button, header select, header input, header a, nav a, main button, main input, main select, main textarea, .ag-badge, .is-badge',
      );
      for (const el of els) {
        if (el.closest('.ag-table-wrap, .is-table-wrap')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > vw + 1 || rect.left < -1) {
          clippedControls.push(
            `${el.tagName}.${el.className} [${Math.round(rect.left)}..${Math.round(rect.right)} > ${vw}]`,
          );
        }
      }

      const overlaps = [];
      const rowContainers = document.querySelectorAll(
        '.ag-topbar-controls, .ag-wb-nav-list, .ag-replay-toolbar, .is-topbar-controls, .is-wb-nav-list, .is-replay-toolbar',
      );
      for (const container of rowContainers) {
        const items = [...container.querySelectorAll('a, button, input, select')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        for (let i = 0; i < items.length; i += 1) {
          const a = items[i].getBoundingClientRect();
          for (let j = i + 1; j < items.length; j += 1) {
            const b = items[j].getBoundingClientRect();
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 2 && overlapY > 2) {
              overlaps.push(
                `${items[i].textContent?.trim() || items[i].id} overlaps ${items[j].textContent?.trim() || items[j].id}`,
              );
            }
          }
        }
      }

      const unfocusableTables = [];
      for (const wrap of document.querySelectorAll('.ag-table-wrap, .is-table-wrap')) {
        const rect = wrap.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && wrap.tabIndex !== 0) {
          unfocusableTables.push(wrap.getAttribute('aria-label') ?? 'unnamed-table-wrap');
        }
      }

      return { docOverflow, scrollWidth: document.documentElement.scrollWidth, vw, clippedControls, overlaps, unfocusableTables };
    });

    assert(!report.docOverflow, `Horizontal overflow detected at ${label} (${report.scrollWidth} > ${report.vw})`);
    assert(
      report.clippedControls.length === 0,
      `Clipped controls at ${label}: ${report.clippedControls.join('; ')}`,
    );
    assert(
      report.overlaps.length === 0,
      `Overlapping controls at ${label}: ${report.overlaps.join('; ')}`,
    );
    assert(
      report.unfocusableTables.length === 0,
      `Scrollable tables missing tabIndex=0 at ${label}: ${report.unfocusableTables.join('; ')}`,
    );
  };

  const checkAxeWcagAA = async (label) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    assert(
      blocking.length === 0,
      `WCAG AA axe violations at ${label}: ${blocking
        .map((v) => `[${v.impact}] ${v.id} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
        .join('; ')}`,
    );
    axeAudits.push(label);
  };

  const assertVisibleFocusIndicator = async (label) => {
    const focusInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { hasElement: false };
      const style = getComputedStyle(el);
      const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
      const hasShadow = style.boxShadow !== 'none';
      return {
        hasElement: true,
        tag: el.tagName,
        id: el.id,
        hasOutline,
        hasShadow,
      };
    });
    assert(focusInfo.hasElement, `No focused element at ${label}`);
    assert(
      focusInfo.hasOutline || focusInfo.hasShadow,
      `Focus indicator missing at ${label} on ${focusInfo.tag}#${focusInfo.id}`,
    );
  };

  const focusViaKeyboard = async (locator, label) => {
    await locator.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const isTargetFocused = await locator.evaluate((el) => el === document.activeElement);
    assert(isTargetFocused, `Control not reachable via Tab/Shift+Tab at ${label}`);
    await assertVisibleFocusIndicator(label);
  };

  const assertBadgeHasIconAndText = async (badgeLocator, expectedText, label) => {
    await badgeLocator.waitFor({ state: 'visible' });
    const text = (await badgeLocator.innerText()).trim();
    assert(text.includes(expectedText), `Expected badge "${expectedText}" at ${label}, got "${text}"`);
    const iconCount = await badgeLocator.locator('span[aria-hidden="true"]').count();
    assert(iconCount > 0, `Status badge "${expectedText}" at ${label} missing icon span`);
    const iconText = (await badgeLocator.locator('span[aria-hidden="true"]').first().innerText()).trim();
    assert(iconText.length > 0, `Status badge "${expectedText}" at ${label} has empty icon`);
  };

  // --- 1. AgentGate under /suite/agent-gate/ ---
  await page.goto(`${baseUrl}/suite/agent-gate/`, { waitUntil: 'networkidle' });
  const agBrokenVerdict = page.locator('section.ag-verdict[data-status="VIOLATED"]');
  await agBrokenVerdict.waitFor({ state: 'visible' });
  assert(
    (await agBrokenVerdict.getAttribute('aria-live')) === 'polite',
    'AgentGate verdict panel missing aria-live="polite"',
  );
  await assertBadgeHasIconAndText(
    agBrokenVerdict.locator('.ag-badge[data-status="VIOLATED"]'),
    'VIOLATED',
    'AgentGate broken verdict',
  );
  assert(
    (await page.locator('nav a[aria-current="page"]').innerText()).includes('AgentGate'),
    'AgentGate nav link missing aria-current="page"',
  );
  await checkNoOverflow('AgentGate desktop 1280x800');
  await checkAxeWcagAA('AgentGate broken 1280x800');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-desktop-1280.png') });

  // AgentGate 5-step counterexample trace + violated invariants + assumptions + keyboard stepping
  await page.getByText('Step 5 of 5').first().waitFor({ state: 'visible' });
  assert(
    (await agBrokenVerdict.innerText()).includes('inv_no_confidential_publish'),
    'AgentGate broken verdict missing violated invariant inv_no_confidential_publish',
  );
  await page
    .getByText('Modeling Assumptions & Scope Disclosure (4)', { exact: true })
    .waitFor({ state: 'visible' });
  assert(
    (await page.locator('.ag-assumptions-list').first().innerText()).includes(
      'asm_synthetic_capability_abstraction',
    ),
    'AgentGate missing declared assumption asm_synthetic_capability_abstraction',
  );

  const agPrevBtn = page.getByRole('button', { name: 'Previous', exact: true });
  await focusViaKeyboard(agPrevBtn, 'AgentGate Previous step button');
  await page.keyboard.press('Enter');
  await page.getByText('Step 4 of 5').first().waitFor({ state: 'visible' });
  const agResetBtn = page.getByRole('button', { name: 'Reset', exact: true });
  await agResetBtn.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Step 0 of 5').first().waitFor({ state: 'visible' });
  const agNextBtn = page.getByRole('button', { name: 'Next', exact: true });
  await agNextBtn.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Step 1 of 5').first().waitFor({ state: 'visible' });
  await assertBadgeHasIconAndText(
    page.locator('tr[data-var="stage"][data-changed="true"] .ag-badge'),
    'Modified',
    'AgentGate Step 1 modified stage variable',
  );
  // Step forward to Step 5 via keyboard and verify violated invariant row
  for (let s = 1; s < 5; s += 1) {
    await page.keyboard.press('Enter');
  }
  await page.getByText('Step 5 of 5').first().waitFor({ state: 'visible' });
  await assertBadgeHasIconAndText(
    page.locator('tr[data-changed="true"] .ag-badge[data-tone="danger"]'),
    'VIOLATED',
    'AgentGate Step 5 invariant row',
  );

  // Manual rule execution on AgentGate (from Step 0)
  await agResetBtn.click();
  await page.getByText('Step 0 of 5').first().waitFor({ state: 'visible' });
  await page.locator('.ag-transition-btn', { hasText: 'draft_public_notes' }).click();
  await page.getByText('Mode: Manual').first().waitFor({ state: 'visible' });
  await page.getByText('Step 1 of 1').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Restore Counterexample Trace' }).click();
  await page.getByText('Step 5 of 5').first().waitFor({ state: 'visible' });

  // Keyboard-only tablist navigation & disclosure toggle across PolicyEditorPane
  const rulesTab = page.getByRole('tab', { name: 'Rules' });
  await focusViaKeyboard(rulesTab, 'AgentGate Rules tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await page.getByRole('tab', { name: 'Invariants & Goal' }).getAttribute('aria-selected')) ===
      'true',
    'ArrowRight from Rules tab did not activate Invariants & Goal tab',
  );
  await page.keyboard.press('End');
  assert(
    (await page.getByRole('tab', { name: 'JSON' }).getAttribute('aria-selected')) === 'true',
    'End key in tablist did not activate JSON tab',
  );
  await page.keyboard.press('Home');
  assert(
    (await page.getByRole('tab', { name: 'Schema & State' }).getAttribute('aria-selected')) ===
      'true',
    'Home key in tablist did not activate Schema & State tab',
  );
  await checkAxeWcagAA('AgentGate Schema & State tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await rulesTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight from Schema & State did not activate Rules tab',
  );

  // Keyboard disclosure toggle on Rules tab
  const firstDisclosure = page
    .locator('.ag-disclosure-btn', { hasText: 'Edit rule definition, guard AST, and atomic updates' })
    .first();
  const initialExpanded = await firstDisclosure.getAttribute('aria-expanded');
  await firstDisclosure.focus();
  await page.keyboard.press('Enter');
  assert(
    (await firstDisclosure.getAttribute('aria-expanded')) !== initialExpanded,
    'Keyboard Enter did not toggle rule disclosure state',
  );
  await page.keyboard.press('Enter');

  // Keyboard preset switch + keyboard verification trigger -> principled-fix VERIFIED
  const agPresetSelect = page.locator('#preset-select');
  await focusViaKeyboard(agPresetSelect, 'AgentGate preset select');
  await agPresetSelect.selectOption('principled-fix');
  await page.getByText('Goal reachable: Yes').first().waitFor({ state: 'visible' });
  assert(!(await page.getByText('OUTDATED:', { exact: false }).first().isVisible()),
    'Fresh AgentGate verdict marked outdated');
  assert(page.url().includes('preset=principled-fix'), `Expected preset=principled-fix in URL: ${page.url()}`);
  await assertBadgeHasIconAndText(
    page.locator('section.ag-verdict .ag-badge[data-status="VERIFIED"]'),
    'VERIFIED',
    'AgentGate principled-fix VERIFIED badge',
  );
  await checkAxeWcagAA('AgentGate principled-fix VERIFIED');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-principled-verified-1280.png') });

  // Verify Policy button via keyboard
  const agVerifyBtn = page.getByRole('button', { name: 'Verify Policy' });
  await focusViaKeyboard(agVerifyBtn, 'AgentGate Verify Policy button');
  await page.keyboard.press('Enter');
  await page.locator('section.ag-verdict[data-status="VERIFIED"]').waitFor({ state: 'visible' });

  // Comparison matrix covering naive-patch-a, naive-patch-b, vacuous-fix, principled-fix
  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();
  const agCompSection = page.locator('.ag-comparison-section');
  await agCompSection.getByText('Naive Patch A').first().waitFor({ state: 'visible' });
  assert(
    (await agCompSection.locator('tbody tr', { hasText: 'Naive Patch A' }).innerText()).includes(
      'VIOLATED',
    ),
    'Comparison missing Naive Patch A VIOLATED verdict',
  );
  assert(
    (await agCompSection.locator('tbody tr', { hasText: 'Naive Patch B' }).innerText()).includes(
      'VIOLATED',
    ),
    'Comparison missing Naive Patch B VIOLATED verdict',
  );
  assert(
    (await agCompSection.locator('tbody tr', { hasText: 'Vacuous Fix' }).innerText()).includes(
      'No (Vacuous)',
    ),
    'Comparison missing Vacuous Fix No (Vacuous) indicator',
  );
  assert(
    (await agCompSection.locator('tbody tr', { hasText: 'Principled Fix' }).innerText()).includes(
      'VERIFIED',
    ),
    'Comparison missing Principled Fix VERIFIED verdict',
  );
  await checkAxeWcagAA('AgentGate comparison matrix');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-comparison-1280.png') });
  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();

  // INCONCLUSIVE & INVALID states + axe + icon+text checks in AgentGate
  await page.fill('#max-states-input', '2');
  await agVerifyBtn.click();
  const agInconclusive = page.locator('section.ag-verdict[data-status="INCONCLUSIVE"]');
  await agInconclusive.waitFor({ state: 'visible' });
  await assertBadgeHasIconAndText(
    agInconclusive.locator('.ag-badge[data-status="INCONCLUSIVE"]'),
    'INCONCLUSIVE',
    'AgentGate INCONCLUSIVE verdict',
  );
  await checkAxeWcagAA('AgentGate INCONCLUSIVE');

  await page.fill('#max-states-input', '0');
  await agVerifyBtn.click();
  const agTopInvalidBadge = page.locator('header .ag-badge[data-status="INVALID"]');
  await assertBadgeHasIconAndText(agTopInvalidBadge, 'INVALID', 'AgentGate topbar INVALID badge');
  await checkAxeWcagAA('AgentGate INVALID');
  await page.fill('#max-states-input', '10000');

  // Malformed JSON import validation on AgentGate
  await page.selectOption('#preset-select', 'broken');
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'JSON' }).click();
  const agJsonTextarea = page.locator('#model-json-textarea');
  await agJsonTextarea.fill('{ "malformed": ');
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.getByText('JSON Import Validation Failed', { exact: false }).waitFor({ state: 'visible' });
  await checkAxeWcagAA('AgentGate malformed JSON error');

  // Reload clean broken preset and test dirty-edit Back/Forward guard + Escape dismissal
  await page.goto(`${baseUrl}/suite/agent-gate/?preset=broken`, { waitUntil: 'networkidle' });
  await page.locator('#preset-select').selectOption('principled-fix');
  await page.waitForURL('**/suite/agent-gate/?preset=principled-fix');
  await page.selectOption('#preset-select', 'broken');
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Schema & State' }).click();
  await page.fill('#model-name-input', 'Custom Dirty Policy');
  await page.goBack();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert(
    (await page.getByRole('alertdialog').count()) === 0,
    'Escape key did not dismiss AgentGate alertdialog',
  );
  assert(
    (await page.locator('#model-name-input').inputValue()) === 'Custom Dirty Policy',
    'Dirty AgentGate editor state lost after Escape on alertdialog',
  );
  await page.goBack();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    (await page.locator('#model-name-input').inputValue()) === 'Custom Dirty Policy',
    'Dirty AgentGate editor state lost after declining Back navigation',
  );

  // Tablet & Mobile AgentGate (768x1024, 390x844, and 375x812)
  await page.setViewportSize({ width: 768, height: 1024 });
  await checkNoOverflow('AgentGate tablet 768x1024');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-tablet-768.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkNoOverflow('AgentGate mobile 390x844');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-mobile-390.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await checkNoOverflow('AgentGate mobile 375x812 (Schema tab)');
  await page.getByRole('tab', { name: 'Rules' }).click();
  await checkNoOverflow('AgentGate mobile 375x812 (Rules tab)');
  await checkAxeWcagAA('AgentGate mobile 375x812');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-mobile-375.png') });

  // Reciprocal cross-workbench navigation from AgentGate -> InterlockSim (with dirty prompt approval)
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('nav a', { hasText: 'InterlockSim' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/interlock-sim/**');

  // --- 2. InterlockSim under /suite/interlock-sim/ ---
  const isBrokenVerdict = page.locator('section.is-verdict[data-status="VIOLATED"]');
  await isBrokenVerdict.waitFor({ state: 'visible' });
  assert(
    (await isBrokenVerdict.getAttribute('aria-live')) === 'polite',
    'InterlockSim verdict panel missing aria-live="polite"',
  );
  await assertBadgeHasIconAndText(
    isBrokenVerdict.locator('.is-badge[data-status="VIOLATED"]'),
    'VIOLATED',
    'InterlockSim broken verdict',
  );
  await page.getByText('Step 6 of 6').first().waitFor({ state: 'visible' });
  assert(
    (await page.locator('nav a[aria-current="page"]').innerText()).includes('InterlockSim'),
    'InterlockSim nav link missing aria-current="page"',
  );
  await checkNoOverflow('InterlockSim desktop 1280x800');
  await checkAxeWcagAA('InterlockSim broken 1280x800');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-desktop-1280.png') });

  // InterlockSim 6-step override violation trace stepping + manual airlock transitions
  assert(
    (await isBrokenVerdict.innerText()).includes('inv_containment_seal'),
    'InterlockSim broken verdict missing inv_containment_seal',
  );
  assert(
    (await page.locator('body').innerText()).includes('assumption_educational_scope'),
    'InterlockSim missing assumption_educational_scope disclosure',
  );
  const isStepBackBtn = page.getByRole('button', { name: 'Step Back', exact: true });
  await focusViaKeyboard(isStepBackBtn, 'InterlockSim Step Back button');
  await page.keyboard.press('Enter');
  await page.getByText('Step 5 of 6').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByText('Step 0 of 6').first().waitFor({ state: 'visible' });
  const isStepForwardBtn = page.getByRole('button', { name: 'Step Forward', exact: true });
  await isStepForwardBtn.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Step 1 of 6').first().waitFor({ state: 'visible' });

  // Manual airlock transitions via OperatorConsole
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByText('Step 0 of 6').first().waitFor({ state: 'visible' });
  await page.locator('button.is-actuator-btn[data-rule-id="equalize_pressure"]').click();
  await page.getByText('Mode: Manual Simulation').first().waitFor({ state: 'visible' });
  await page.getByText('Step 1 of 1').first().waitFor({ state: 'visible' });
  await page
    .locator('.is-telemetry-cell[data-var="pressure"][data-changed="true"]')
    .waitFor({ state: 'visible' });
  await page.locator('button.is-actuator-btn[data-rule-id="open_outer_door"]').click();
  await page.getByText('Step 2 of 2').first().waitFor({ state: 'visible' });
  await page
    .locator('[data-blocked-rule-id="open_inner_door"]')
    .waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Restore Counterexample' }).click();
  await page.getByText('Step 6 of 6').first().waitFor({ state: 'visible' });

  // Keyboard tablist navigation in InterlockRuleEditor
  const guardTab = page.getByRole('tab', { name: 'Guard Inspector' });
  await focusViaKeyboard(guardTab, 'InterlockSim Guard Inspector tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await page.getByRole('tab', { name: 'Assumptions' }).getAttribute('aria-selected')) === 'true',
    'ArrowRight from Guard Inspector tab did not activate Assumptions tab',
  );
  await page.keyboard.press('End');
  assert(
    (await page.getByRole('tab', { name: 'JSON' }).getAttribute('aria-selected')) === 'true',
    'End in InterlockSim tablist did not activate JSON tab',
  );
  await page.keyboard.press('Home');
  assert(
    (await guardTab.getAttribute('aria-selected')) === 'true',
    'Home in InterlockSim tablist did not activate Guard Inspector tab',
  );

  // Guided repair -> VERIFIED (29 states, Goal reachable: Yes)
  await page.getByRole('button', { name: 'Apply Principled Repair' }).click();
  await page.getByText('OUTDATED: VIOLATED').first().waitFor({ state: 'visible' });
  await assertBadgeHasIconAndText(
    page.locator('header .is-badge[data-tone="warning"]'),
    'OUTDATED: VIOLATED',
    'InterlockSim outdated badge',
  );
  await page.getByRole('button', { name: 'Verify Interlock Model' }).click();
  await page.getByText('Goal reachable: Yes').first().waitFor({ state: 'visible' });
  assert(!(await page.getByText('OUTDATED:', { exact: false }).first().isVisible()),
    'Fresh InterlockSim verdict marked outdated');
  assert((await page.locator('body').innerText()).includes('29'), 'Expected 29 states after repair');
  await checkAxeWcagAA('InterlockSim repaired VERIFIED');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-repaired-verified-1280.png') });

  // InterlockSim INCONCLUSIVE & INVALID + malformed JSON import validation
  const isVerifyHeaderBtn = page.locator('header').getByRole('button', { name: 'Verify Interlock Model' });
  await page.fill('#max-states-input', '2');
  await isVerifyHeaderBtn.click();
  const isInconclusive = page.locator('section.is-verdict[data-status="INCONCLUSIVE"]');
  await isInconclusive.waitFor({ state: 'visible' });
  await assertBadgeHasIconAndText(
    isInconclusive.locator('.is-badge[data-status="INCONCLUSIVE"]'),
    'INCONCLUSIVE',
    'InterlockSim INCONCLUSIVE verdict',
  );
  await checkAxeWcagAA('InterlockSim INCONCLUSIVE');

  await page.fill('#max-states-input', '0');
  await isVerifyHeaderBtn.click();
  await assertBadgeHasIconAndText(
    page.locator('header .is-badge[data-status="INVALID"]'),
    'INVALID',
    'InterlockSim topbar INVALID badge',
  );
  await checkAxeWcagAA('InterlockSim INVALID');
  await page.fill('#max-states-input', '10000');
  await isVerifyHeaderBtn.click();
  await page.getByText('Goal reachable: Yes').first().waitFor({ state: 'visible' });

  // Dirty JSON draft protection + malformed JSON check + alertdialog focus management + focus restoration on InterlockSim
  await page.getByRole('tab', { name: 'JSON' }).click();
  const interlockJsonArea = page.locator('#interlock-json-textarea');
  await interlockJsonArea.waitFor({ state: 'visible' });
  const originalInterlockJson = await interlockJsonArea.inputValue();
  await interlockJsonArea.fill('{ "bad": ');
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.getByText('JSON Import Validation Failed', { exact: false }).waitFor({ state: 'visible' });
  await checkAxeWcagAA('InterlockSim malformed JSON error');

  await interlockJsonArea.fill(`${originalInterlockJson}\n `);
  await page.locator('#preset-select').focus();
  await page.locator('#preset-select').selectOption('vacuous');
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  const interlockDialogFocus = await page.evaluate(
    () => document.activeElement?.textContent?.trim() ?? '',
  );
  assert(
    interlockDialogFocus === 'Stay Here',
    `Expected InterlockSim alertdialog to focus "Stay Here", got "${interlockDialogFocus}"`,
  );
  await page.getByRole('button', { name: 'Stay Here' }).click();
  const interlockRestoredFocus = await page.evaluate(() => document.activeElement?.id ?? '');
  assert(
    interlockRestoredFocus === 'preset-select',
    `Expected InterlockSim focus return to "preset-select", got "${interlockRestoredFocus}"`,
  );
  assert(
    (await interlockJsonArea.inputValue()) === `${originalInterlockJson}\n `,
    'Dirty InterlockSim JSON draft lost after declining discard prompt',
  );

  // ComparisonPanel Load preset obeys discard guard and updates live URL in InterlockSim
  await page.getByRole('button', { name: 'Compare Presets (3)' }).click();
  await checkAxeWcagAA('InterlockSim comparison matrix');
  const isCompareRow = page.locator('.is-comparison-section tbody tr', {
    hasText: 'Vacuous Lockout',
  });
  await isCompareRow.getByRole('button', { name: 'Load preset' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    !page.url().includes('preset=vacuous'),
    `InterlockSim ComparisonPanel stay-here unexpectedly changed URL: ${page.url()}`,
  );
  assert(
    (await interlockJsonArea.inputValue()) === `${originalInterlockJson}\n `,
    'InterlockSim ComparisonPanel stay-here lost dirty JSON draft',
  );
  await isCompareRow.getByRole('button', { name: 'Load preset' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/interlock-sim/?preset=vacuous');
  assert(
    page.url().includes('preset=vacuous'),
    `InterlockSim ComparisonPanel discard approval did not update URL: ${page.url()}`,
  );
  await page.getByRole('button', { name: 'Compare Presets (3)' }).click();

  // Preset URL direct load (?preset=vacuous)
  await page.goto(`${baseUrl}/suite/interlock-sim/?preset=vacuous`, { waitUntil: 'networkidle' });
  await page.getByText('VERIFIED (GOAL UNREACHABLE)').first().waitFor({ state: 'visible' });
  await checkAxeWcagAA('InterlockSim vacuous 1280x800');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-vacuous-1280.png') });

  // Tablet & Mobile InterlockSim (768x1024, 390x844, 375x812)
  await page.setViewportSize({ width: 768, height: 1024 });
  await checkNoOverflow('InterlockSim tablet 768x1024');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-tablet-768.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkNoOverflow('InterlockSim mobile 390x844');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-mobile-390.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await checkNoOverflow('InterlockSim mobile 375x812');
  await checkAxeWcagAA('InterlockSim mobile 375x812');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-mobile-375.png') });

  // Clean reciprocal link back to AgentGate
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('nav a', { hasText: 'AgentGate' }).click();
  await page.waitForURL('**/suite/agent-gate/**');
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });

  // --- 3. Dirty JSON draft protection + alertdialog focus management + same-preset Back/Reselect URL sync ---
  await page.getByRole('tab', { name: 'JSON' }).click();
  const jsonArea = page.locator('#model-json-textarea');
  await jsonArea.waitFor({ state: 'visible' });
  const originalJson = await jsonArea.inputValue();
  await jsonArea.fill(`${originalJson}\n `);
  await page.locator('#preset-select').focus();
  await page.locator('#preset-select').selectOption('naive-patch-a');
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  const focusedInDialog = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  assert(
    focusedInDialog === 'Stay Here',
    `Expected alertdialog to focus "Stay Here" button, got "${focusedInDialog}"`,
  );
  await page.getByRole('button', { name: 'Stay Here' }).click();
  const agentGateRestoredFocus = await page.evaluate(() => document.activeElement?.id ?? '');
  assert(
    agentGateRestoredFocus === 'preset-select',
    `Expected AgentGate focus return to "preset-select", got "${agentGateRestoredFocus}"`,
  );
  assert(
    (await jsonArea.inputValue()) === `${originalJson}\n `,
    'Dirty JSON draft was lost after declining discard prompt',
  );

  // Copy JSON clipboard-unavailable fallback synchronizes text and clears dirty flag
  await page.evaluate(() => {
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });
    } catch {
      // ignore if non-configurable
    }
  });
  await page.getByRole('button', { name: 'Copy JSON' }).click();
  await page
    .getByText('Synchronized current model JSON in the text area.', { exact: true })
    .waitFor({ state: 'visible' });
  await page.locator('#preset-select').selectOption('naive-patch-a');
  await page.waitForURL('**/suite/agent-gate/?preset=naive-patch-a');
  assert(
    (await page.getByRole('alertdialog').count()) === 0,
    'Copy JSON fallback left stale dirty flag and opened discard prompt',
  );

  // Back while dirty on principled-fix -> reselect principled-fix -> approve discard -> URL updates back to principled-fix
  await page.goto(`${baseUrl}/suite/agent-gate/?preset=broken`, { waitUntil: 'networkidle' });
  await page.locator('#preset-select').selectOption('principled-fix');
  await page.waitForURL('**/suite/agent-gate/?preset=principled-fix');
  await page.getByRole('tab', { name: 'Schema & State' }).click();
  await page.locator('#model-name-input').fill('Dirty Before Back');
  await page.goBack();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.locator('#preset-select').selectOption('principled-fix');
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/agent-gate/?preset=principled-fix');
  assert(
    page.url().includes('preset=principled-fix'),
    `Expected URL to restore preset=principled-fix after discard approval, got ${page.url()}`,
  );

  // ComparisonPanel Load preset obeys discard guard and updates live URL in AgentGate
  await page.getByRole('tab', { name: 'JSON' }).click();
  const curAgJson = await page.locator('#model-json-textarea').inputValue();
  await page.locator('#model-json-textarea').fill(`${curAgJson}\n `);
  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();
  const agCompareRow = page.locator('.ag-comparison-section tbody tr', {
    hasText: 'Naive Patch A',
  });
  await agCompareRow.getByRole('button', { name: 'Load preset' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    page.url().includes('preset=principled-fix'),
    `AgentGate ComparisonPanel stay-here unexpectedly changed URL: ${page.url()}`,
  );
  assert(
    (await page.locator('#model-json-textarea').inputValue()) === `${curAgJson}\n `,
    'AgentGate ComparisonPanel stay-here lost dirty JSON draft',
  );
  await agCompareRow.getByRole('button', { name: 'Load preset' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/agent-gate/?preset=naive-patch-a');
  assert(
    page.url().includes('preset=naive-patch-a'),
    `AgentGate ComparisonPanel discard approval did not update URL: ${page.url()}`,
  );
  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();

  // --- 4. No-Navigation-API fallback recovery (fresh-session replaceState) ---
  const fallbackPage = await context.newPage();
  fallbackPage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`fallback console: ${msg.text()}`);
  });
  fallbackPage.on('pageerror', (err) => pageErrors.push(`fallback pageerror: ${err.message}`));
  await fallbackPage.addInitScript(() => {
    try {
      Object.defineProperty(window, 'navigation', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } catch {
      // ignore
    }
  });
  await fallbackPage.goto(`${baseUrl}/suite/agent-gate/?preset=broken`, { waitUntil: 'networkidle' });
  await fallbackPage.locator('#preset-select').selectOption('naive-patch-a');
  await fallbackPage.waitForURL('**/suite/agent-gate/?preset=naive-patch-a');
  await fallbackPage.getByRole('tab', { name: 'Schema & State' }).click();
  await fallbackPage.locator('#model-name-input').fill('NoNavApi Dirty Edit');
  await fallbackPage.goBack();
  await fallbackPage.getByRole('alertdialog').waitFor({ state: 'visible' });
  await fallbackPage.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    fallbackPage.url().includes('preset=naive-patch-a'),
    `No-Navigation-API fallback failed to restore URL: ${fallbackPage.url()}`,
  );
  assert(
    (await fallbackPage.locator('#model-name-input').inputValue()) === 'NoNavApi Dirty Edit',
    'No-Navigation-API fallback lost dirty editor state',
  );
  await fallbackPage.close();

  // Check cancellation and no-Worker fallback through both production applications.
  for (const [app, verifyButton] of [
    ['agent-gate', 'Verify Policy'],
    ['interlock-sim', 'Verify Interlock Model'],
  ]) {
    const faultPage = await context.newPage();
    await faultPage.addInitScript(() => {
      window.Worker = class {
        postMessage() {}
        terminate() {}
      };
    });
    await faultPage.goto(`${baseUrl}/suite/${app}/`);
    await faultPage.getByRole('button', { name: verifyButton }).click();
    await faultPage.getByRole('button', { name: 'Cancel Verification' }).click();
    await faultPage.getByText('Verification Cancelled', { exact: false }).last().waitFor();
    await faultPage.close();

    const syncPage = await context.newPage();
    await syncPage.addInitScript(() => { window.Worker = undefined; });
    await syncPage.goto(`${baseUrl}/suite/${app}/`);
    await syncPage.getByRole('button', { name: verifyButton }).click();
    await syncPage.getByText('Execution: Main thread (Web Workers unavailable)', { exact: true }).waitFor();
    await syncPage.locator('section[data-status="VIOLATED"]').waitFor();
    await syncPage.close();
  }

  // Exercise the module worker built from the isolated tarball installation.
  if (process.env.BOOKING_FIXTURE_DIST) {
    await page.goto(`${baseUrl}/booking-demo/`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Room Booking Fixture' }).waitFor();
    assert(
      (await page.locator('main').getAttribute('data-export-ok')) === 'true',
      'Packed booking fixture could not export its model',
    );
    await page.getByRole('button', { name: 'Verify Booking Model' }).click();
    await page.locator('main[data-verification-revision="1"][data-execution-mode="worker"]').waitFor();
    await page.locator('main [data-status="VERIFIED"]').first().waitFor();
  }

  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);
  assert(httpErrors.length === 0, `HTTP errors: ${httpErrors.join('; ')}`);

  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        consoleErrors: 0,
        pageErrors: 0,
        httpErrors: 0,
        axeCriticalSeriousViolations: 0,
        axeAudits,
        screenshotDir: SCREENSHOT_DIR,
        screenshots: [
          'agent-gate-desktop-1280.png',
          'agent-gate-principled-verified-1280.png',
          'agent-gate-comparison-1280.png',
          'agent-gate-tablet-768.png',
          'agent-gate-mobile-390.png',
          'agent-gate-mobile-375.png',
          'interlock-sim-desktop-1280.png',
          'interlock-sim-repaired-verified-1280.png',
          'interlock-sim-vacuous-1280.png',
          'interlock-sim-tablet-768.png',
          'interlock-sim-mobile-390.png',
          'interlock-sim-mobile-375.png',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (browser !== null) {
    await browser.close().catch(() => {});
  }
  server.close();
}
