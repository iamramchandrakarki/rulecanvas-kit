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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
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
        if (!full.startsWith(mount.dir + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        if (!existsSync(full) || !statSync(full).isFile()) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const ext = path.extname(full);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
        res.end(readFileSync(full));
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

  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const externalRequests = [];
  const axeAudits = [];
  context.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  context.on('weberror', (error) => pageErrors.push(error.error().message));
  context.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(baseUrl) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      externalRequests.push(url);
    }
  });
  context.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url()}`);
  });
  const page = await context.newPage();

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
        const ruleNav = el.closest('.ag-rule-nav');
        if (ruleNav && getComputedStyle(ruleNav).overflowX === 'auto') continue;
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

  const installScrollSpy = async () => {
    await page.evaluate(() => {
      if (!window.__rcOrigScrollIntoView) {
        window.__rcOrigScrollIntoView = Element.prototype.scrollIntoView;
      }
      window.__rcScrollCalls = [];
      Element.prototype.scrollIntoView = function (options) {
        window.__rcScrollCalls.push({
          id: this.id || null,
          className: typeof this.className === 'string' ? this.className : '',
          options: options && typeof options === 'object' ? { behavior: options.behavior, block: options.block } : options ?? null,
        });
        return window.__rcOrigScrollIntoView.apply(this, arguments);
      };
    });
  };

  const clearScrollSpy = async () => {
    await page.evaluate(() => {
      window.__rcScrollCalls = [];
    });
  };

  const readScrollSpy = async () => page.evaluate(() => window.__rcScrollCalls ?? []);

  const waitForVisibleFocus = async (selector) => {
    await page.waitForFunction((targetSelector) => {
      const target = document.querySelector(targetSelector);
      if (target === null || document.activeElement !== target) return false;
      const { top, bottom } = target.getBoundingClientRect();
      const header = document.querySelector('header');
      const headerBottom = header && getComputedStyle(header).position === 'sticky'
        ? Math.max(0, header.getBoundingClientRect().bottom)
        : 0;
      return top >= headerBottom && bottom <= innerHeight;
    }, selector, { timeout: 5_000 });
  };

  const uninstallScrollSpy = async () => {
    await page.evaluate(() => {
      if (window.__rcOrigScrollIntoView) {
        Element.prototype.scrollIntoView = window.__rcOrigScrollIntoView;
        delete window.__rcOrigScrollIntoView;
      }
      delete window.__rcScrollCalls;
    });
  };

  const assertTelemetryGridEdgeToEdge = async (label) => {
    const metrics = await page.evaluate(() => {
      const grid = document.querySelector('.is-telemetry-grid');
      if (!grid) return { found: false };
      const gridRect = grid.getBoundingClientRect();
      const cells = [...grid.querySelectorAll('.is-telemetry-cell')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
      });
      return {
        found: true,
        vw: window.innerWidth,
        gridLeft: gridRect.left,
        gridRight: gridRect.right,
        cells,
      };
    });
    assert(metrics.found, `Missing .is-telemetry-grid at ${label}`);
    assert(metrics.cells.length === 7, `Expected 7 telemetry cells at ${label}, got ${metrics.cells.length}`);
    const rows = [];
    for (const cell of metrics.cells) {
      assert(cell.width > 0 && cell.height > 0, `Hidden telemetry cell at ${label}`);
      assert(
        cell.left >= -1 && cell.right <= metrics.vw + 1,
        `Telemetry cell overflows viewport at ${label}: [${cell.left}..${cell.right}] vs ${metrics.vw}`,
      );
      const row = rows.find((r) => Math.abs(r.top - cell.top) <= 2);
      if (row) {
        row.cells.push(cell);
      } else {
        rows.push({ top: cell.top, cells: [cell] });
      }
    }
    for (const row of rows) {
      row.cells.sort((a, b) => a.left - b.left);
      const first = row.cells[0];
      const last = row.cells[row.cells.length - 1];
      assert(
        Math.abs(first.left - metrics.gridLeft) <= 2,
        `Telemetry row left edge not flush at ${label}: ${first.left} vs ${metrics.gridLeft}`,
      );
      assert(
        Math.abs(last.right - metrics.gridRight) <= 2,
        `Telemetry row right edge not flush at ${label}: ${last.right} vs ${metrics.gridRight}`,
      );
      for (let i = 1; i < row.cells.length; i += 1) {
        const gap = Math.abs(row.cells[i].left - row.cells[i - 1].right);
        assert(gap <= 2, `Telemetry row gap/overlap (${gap}px) at ${label}`);
      }
    }
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
  const agFontsLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      count: document.fonts.size,
      sans: document.fonts.check('500 13px "IBM Plex Sans"'),
      mono: document.fonts.check('500 12px "IBM Plex Mono"'),
    };
  });
  assert(
    agFontsLoaded.count >= 6 && agFontsLoaded.sans && agFontsLoaded.mono,
    `Self-hosted IBM Plex fonts failed to load on AgentGate: ${JSON.stringify(agFontsLoaded)}`,
  );
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-desktop-1280.png') });

  // Theme switching (Light / Dark / System) + WCAG AA in Dark theme
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  assert(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
    'AgentGate Dark theme button did not set data-theme="dark"',
  );
  assert(
    (await page.evaluate(() => localStorage.getItem('rulecanvas-theme'))) === 'dark',
    'AgentGate Dark theme preference not persisted in localStorage',
  );
  await checkAxeWcagAA('AgentGate broken Dark 1280x800');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  assert(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
    'AgentGate Light theme button did not set data-theme="light"',
  );
  await page.getByRole('button', { name: 'System', exact: true }).click();

  // Persistent desktop vertical rule navigator, single-rule mounting, & balanced pane alignment
  const agEditorTablist = page.getByRole('tablist', { name: 'Policy editor sections' });
  const agInspectorTablist = page.getByRole('tablist', { name: 'Verification inspector sections' });
  const agRuleNavBtns = page.locator('.ag-rule-nav .ag-rule-nav-btn');
  assert((await agRuleNavBtns.count()) >= 4, 'Expected persistent AgentGate rule navigator buttons');
  const navBox0 = await agRuleNavBtns.nth(0).boundingBox();
  const navBox1 = await agRuleNavBtns.nth(1).boundingBox();
  assert(
    navBox0 !== null && navBox1 !== null && navBox1.y >= navBox0.y + navBox0.height - 2,
    'Expected vertical desktop layout in .ag-rule-nav',
  );
  assert(
    (await page.locator('.ag-item-row.ag-rule-detail').count()) === 1,
    'Expected only the single selected rule detail row mounted in DOM',
  );
  const editorPaneBox = await page.locator('#ag-editor-pane').boundingBox();
  const verdictPaneBox = await page.locator('#ag-verdict-pane').boundingBox();
  assert(
    editorPaneBox !== null &&
      verdictPaneBox !== null &&
      Math.abs(editorPaneBox.y - verdictPaneBox.y) <= 2 &&
      editorPaneBox.height < 1400,
    `Expected aligned compact desktop panes without forced multi-rule vertical gap (editor=${JSON.stringify(editorPaneBox)}, verdict=${JSON.stringify(verdictPaneBox)})`,
  );

  // Switch active rule via persistent navigator and verify persistence across editor tabs
  await page.locator('.ag-rule-nav-btn[data-rule-id="draft_public_notes"]').click();
  assert(
    (await page.locator('.ag-item-row.ag-rule-detail').count()) === 1 &&
      (await page.locator('.ag-item-row.ag-rule-detail[data-rule-id="draft_public_notes"]').count()) === 1,
    'Clicking .ag-rule-nav-btn did not switch single mounted rule detail to draft_public_notes',
  );
  assert(
    (await page.locator('.ag-rule-nav-btn[data-rule-id="draft_public_notes"]').getAttribute('aria-pressed')) ===
      'true',
    'Selected .ag-rule-nav-btn missing aria-pressed="true"',
  );
  await agEditorTablist.getByRole('tab', { name: 'Schema & State' }).click();
  assert(
    await page.locator('.ag-rule-nav').isVisible(),
    'Persistent .ag-rule-nav should remain visible when switching editor tabs on desktop',
  );

  // Candidate repair discoverability jumps to publish_release_notes and focuses Rule ID input
  const publishRuleInputSelector =
    '.ag-item-row.ag-rule-detail[data-rule-id="publish_release_notes"] input[id^="rule-id-"]';
  const candidateRepairBtn = page.locator('.ag-verdict-repair').getByRole('button', {
    name: 'Inspect candidate repair',
  });
  await candidateRepairBtn.waitFor({ state: 'visible' });
  await candidateRepairBtn.click();
  await waitForVisibleFocus(publishRuleInputSelector);
  assert(
    (await agEditorTablist.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')) === 'true',
    'Inspect candidate repair did not activate Rules tab',
  );
  const quickClauseControl = page.locator('.ag-quick-clause summary');
  await quickClauseControl.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Quick clause boolean variable' }).waitFor();
  assert(
    (await page.getByRole('button', { name: '+ Add !modifiedSinceApproval' }).count()) === 1 &&
      (await page.getByRole('button', { name: '+ Append !modifiedSinceApproval' }).count()) === 0,
    'Opening the quick-clause helper duplicated the candidate guard action',
  );
  await page.keyboard.press('Enter');

  // Cross-pane Inspect rule jump from counterexample trace step 5 -> publish_release_notes
  // Verify cross-tab focus & reduced-motion scrollIntoView, including repeated same-target jump
  const agStep5Item = page.locator('.ag-timeline .ag-timeline-item', {
    hasText: 'publish_release_notes',
  });
  assert((await agStep5Item.count()) === 1, 'Expected unique AgentGate trace item for publish_release_notes');
  const step5JumpBtn = agStep5Item.getByRole('button', { name: 'Inspect rule' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installScrollSpy();
  await agEditorTablist.getByRole('tab', { name: 'Schema & State' }).click();
  await clearScrollSpy();
  await step5JumpBtn.click();
  await waitForVisibleFocus(publishRuleInputSelector);
  assert(
    (await agEditorTablist.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')) === 'true',
    'Cross-tab Inspect rule jump did not activate Rules tab',
  );
  assert(
    (await page
      .locator('.ag-rule-nav-btn[data-rule-id="publish_release_notes"]')
      .getAttribute('data-selected')) === 'true',
    'Inspect rule on Step 5 did not select publish_release_notes in rule navigator',
  );
  const agFirstScrolls = await readScrollSpy();
  assert(
    agFirstScrolls.some((c) => c.options?.behavior === 'auto' && c.options?.block === 'center'),
    `Expected centered reduced-motion scroll on AgentGate jump, got ${JSON.stringify(agFirstScrolls)}`,
  );
  // Repeated same-target cross-tab jump
  await agEditorTablist.getByRole('tab', { name: 'Schema & State' }).click();
  await clearScrollSpy();
  await step5JumpBtn.click();
  await waitForVisibleFocus(publishRuleInputSelector);
  const agRepeatScrolls = await readScrollSpy();
  assert(
    agRepeatScrolls.some((c) => c.options?.behavior === 'auto' && c.options?.block === 'center'),
    `Expected reduced-motion scrollIntoView on repeated AgentGate jump, got ${JSON.stringify(agRepeatScrolls)}`,
  );
  await uninstallScrollSpy();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Inspector tabs default to Trace and use roving keyboard selection.
  const traceInspectorTab = agInspectorTablist.getByRole('tab', { name: 'Trace' });
  const stateInspectorTab = agInspectorTablist.getByRole('tab', { name: 'State & Diff' });
  const checksInspectorTab = agInspectorTablist.getByRole('tab', { name: 'Invariants & Goal' });
  const assumptionsInspectorTab = agInspectorTablist.getByRole('tab', { name: 'Assumptions' });
  assert(
    (await traceInspectorTab.getAttribute('aria-selected')) === 'true' &&
      (await page.locator('#ag-inspector-panel-trace').isVisible()) &&
      !(await page.locator('#ag-inspector-panel-state').isVisible()) &&
      !(await page.locator('#ag-inspector-panel-checks').isVisible()) &&
      !(await page.locator('#ag-inspector-panel-assumptions').isVisible()),
    'Expected only Trace inspector panel visible by default',
  );
  await focusViaKeyboard(traceInspectorTab, 'AgentGate inspector Trace tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await stateInspectorTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight in inspector tablist did not activate State & Diff tab',
  );
  await checkAxeWcagAA('AgentGate State & Diff inspector tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await checksInspectorTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight in inspector tablist did not activate Invariants & Goal tab',
  );
  await page.keyboard.press('End');
  assert(
    (await assumptionsInspectorTab.getAttribute('aria-selected')) === 'true',
    'End key in inspector tablist did not activate Assumptions tab',
  );

  // AgentGate assumptions disclosure inside Assumptions inspector tab
  await page
    .getByText('Modeling Assumptions & Scope Disclosure (4)', { exact: true })
    .waitFor({ state: 'visible' });
  assert(
    (await page.locator('.ag-assumptions-list').first().innerText()).includes(
      'asm_synthetic_capability_abstraction',
    ),
    'AgentGate missing declared assumption asm_synthetic_capability_abstraction',
  );
  await page.keyboard.press('Home');
  assert(
    (await traceInspectorTab.getAttribute('aria-selected')) === 'true',
    'Home key in inspector tablist did not return to Trace tab',
  );

  // AgentGate 5-step counterexample trace + violated invariants + keyboard stepping across tabs
  await page.getByText('Step 5 of 5').first().waitFor({ state: 'visible' });
  assert(
    (await agBrokenVerdict.innerText()).includes('inv_no_confidential_publish'),
    'AgentGate broken verdict missing violated invariant inv_no_confidential_publish',
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
  await stateInspectorTab.click();
  await assertBadgeHasIconAndText(
    page.locator('tr[data-var="stage"][data-changed="true"] .ag-badge'),
    'Modified',
    'AgentGate Step 1 modified stage variable',
  );
  // Step forward to Step 5 via keyboard and verify violated invariant row under Invariants & Goal tab
  await agNextBtn.focus();
  for (let step = 2; step <= 5; step += 1) {
    await page.keyboard.press('Enter');
    await page.getByText(`Step ${step} of 5`).first().waitFor({ state: 'visible' });
  }
  await checksInspectorTab.click();
  await assertBadgeHasIconAndText(
    page.locator('tr[data-changed="true"] .ag-badge[data-tone="danger"]'),
    'VIOLATED',
    'AgentGate Step 5 invariant row',
  );

  // Manual rule execution on AgentGate (from Step 0 under State & Diff tab)
  await stateInspectorTab.click();
  await agResetBtn.click();
  await page.getByText('Step 0 of 5').first().waitFor({ state: 'visible' });
  await page.locator('.ag-transition-btn', { hasText: 'draft_public_notes' }).click();
  await page.getByText('Manual simulation').first().waitFor({ state: 'visible' });
  await page.getByText('Step 1 of 1').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Restore Counterexample Trace' }).click();
  await page.getByText('Step 5 of 5').first().waitFor({ state: 'visible' });
  await traceInspectorTab.click();

  // Keyboard-only tablist navigation & persistent rule navigator selection across PolicyEditorPane
  const rulesTab = agEditorTablist.getByRole('tab', { name: 'Rules' });
  await focusViaKeyboard(rulesTab, 'AgentGate Rules tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await agEditorTablist.getByRole('tab', { name: 'Invariants & Goal' }).getAttribute('aria-selected')) ===
      'true',
    'ArrowRight from Rules tab did not activate Invariants & Goal tab',
  );
  await page.keyboard.press('End');
  assert(
    (await agEditorTablist.getByRole('tab', { name: 'JSON' }).getAttribute('aria-selected')) === 'true',
    'End key in tablist did not activate JSON tab',
  );
  await page.keyboard.press('Home');
  assert(
    (await agEditorTablist.getByRole('tab', { name: 'Schema & State' }).getAttribute('aria-selected')) ===
      'true',
    'Home key in tablist did not activate Schema & State tab',
  );
  await checkAxeWcagAA('AgentGate Schema & State tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await rulesTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight from Schema & State did not activate Rules tab',
  );

  // Keyboard selection in persistent rule navigator
  const draftNavBtn = page.locator('.ag-rule-nav-btn[data-rule-id="draft_public_notes"]');
  await draftNavBtn.focus();
  await page.keyboard.press('Enter');
  assert(
    (await draftNavBtn.getAttribute('data-selected')) === 'true' &&
      (await page.locator('.ag-item-row.ag-rule-detail[data-rule-id="draft_public_notes"]').count()) === 1,
    'Keyboard Enter on .ag-rule-nav-btn did not select draft_public_notes',
  );
  const publishNavBtn = page.locator('.ag-rule-nav-btn[data-rule-id="publish_release_notes"]');
  await publishNavBtn.focus();
  await page.keyboard.press('Enter');
  assert(
    (await publishNavBtn.getAttribute('data-selected')) === 'true' &&
      (await page.locator('.ag-item-row.ag-rule-detail[data-rule-id="publish_release_notes"]').count()) === 1,
    'Keyboard Enter on .ag-rule-nav-btn did not restore publish_release_notes',
  );

  // Stale AgentGate removes step tags, shows snapshot guard on active step with distinct draft action,
  // and removing a snapshot rule disables the misleading jump
  assert(
    (await page.locator('.ag-rule-step-tag').count()) > 0,
    'Expected step tags on fresh AgentGate trace',
  );
  await page.getByRole('button', { name: '+ Add !modifiedSinceApproval' }).click();
  assert(
    (await page.locator('.ag-rule-step-tag').count()) === 0,
    'Stale AgentGate did not remove step tags',
  );
  await page
    .locator('.ag-timeline .ag-timeline-item[data-active="true"]', { hasText: 'Snapshot guard:' })
    .waitFor({ state: 'visible' });
  const agEditDraftRuleBtn = agStep5Item.getByRole('button', { name: 'Edit draft rule' });
  await agEditDraftRuleBtn.waitFor({ state: 'visible' });
  assert(
    (await agEditDraftRuleBtn.getAttribute('aria-label')) === 'Edit draft rule publish_release_notes in editor',
    'Stale AgentGate trace jump aria-label missing exact Edit draft rule + ruleId',
  );
  await page.getByRole('button', { name: 'Remove rule publish_release_notes' }).click();
  assert(
    (await agStep5Item.getByRole('button', { name: /Edit draft rule|Inspect rule/ }).count()) === 0,
    'Removed snapshot rule still rendered misleading jump button in AgentGate trace',
  );
  await agStep5Item.getByText('Removed in draft', { exact: true }).waitFor({ state: 'visible' });

  // Keyboard preset switch + keyboard verification trigger -> principled-fix VERIFIED
  const agPresetSelect = page.locator('#preset-select');
  await focusViaKeyboard(agPresetSelect, 'AgentGate preset select');
  await page.keyboard.press('p');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard & Continue' }).click();
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
  assert(
    (await page.locator('#max-states-input').getAttribute('aria-invalid')) === 'true',
    'AgentGate maxStates range error missing aria-invalid',
  );
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installScrollSpy();
  await page.getByRole('button', { name: 'Jump to Verdict & Trace' }).click();
  assert(
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'ag-verdict-pane',
    'AgentGate mobile Jump to Verdict & Trace did not focus #ag-verdict-pane',
  );
  await page.getByRole('button', { name: 'Jump to Editor' }).click();
  assert(
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'ag-editor-pane',
    'AgentGate mobile Jump to Editor did not focus #ag-editor-pane',
  );
  const agMobileScrolls = await readScrollSpy();
  assert(
    agMobileScrolls.filter((c) => c.options?.behavior === 'auto' && c.options?.block === 'start').length >= 2,
    `Expected reduced-motion scrollIntoView on AgentGate mobile pane shortcuts, got ${JSON.stringify(agMobileScrolls)}`,
  );
  await uninstallScrollSpy();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await checkAxeWcagAA('AgentGate mobile 375x812');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-mobile-375.png') });
  await page.setViewportSize({ width: 360, height: 800 });
  await checkNoOverflow('AgentGate mobile 360x800');
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkNoOverflow('AgentGate desktop 1440x900');

  // Persist Dark theme before navigating AgentGate -> InterlockSim
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.locator('nav a', { hasText: 'InterlockSim' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/interlock-sim/**');

  // --- 2. InterlockSim under /suite/interlock-sim/ ---
  const isBrokenVerdict = page.locator('section.is-verdict[data-status="VIOLATED"]');
  await isBrokenVerdict.waitFor({ state: 'visible' });
  assert(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
    'Dark theme preference did not persist across AgentGate -> InterlockSim navigation',
  );
  await checkAxeWcagAA('InterlockSim broken Dark 1280x800');
  await page.getByRole('button', { name: 'System', exact: true }).click();
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

  // InterlockSim 6-step override violation trace stepping + manual airlock transitions + unified tabs
  assert(
    (await isBrokenVerdict.innerText()).includes('inv_containment_seal'),
    'InterlockSim broken verdict missing inv_containment_seal',
  );
  const isTablist = page.getByRole('tablist', { name: 'Verification and interlock inspector sections' });
  const traceGuardTab = isTablist.getByRole('tab', { name: 'Counterexample & Guard' });
  const stateInvariantsTab = isTablist.getByRole('tab', { name: 'State & Invariants' });
  const isAssumptionsTab = isTablist.getByRole('tab', { name: 'Assumptions' });
  const isJsonTab = isTablist.getByRole('tab', { name: 'JSON' });
  assert(
    (await traceGuardTab.getAttribute('aria-selected')) === 'true' &&
      (await page.locator('#is-panel-trace-guard').isVisible()) &&
      !(await page.locator('#is-panel-state-invariants').isVisible()) &&
      !(await page.locator('#is-panel-assumptions').isVisible()) &&
      !(await page.locator('#is-panel-json').isVisible()),
    'Expected only Counterexample & Guard panel visible by default in InterlockSim',
  );

  // Keyboard tablist navigation in unified InterlockSim inspector
  await focusViaKeyboard(traceGuardTab, 'InterlockSim Counterexample & Guard tab');
  await page.keyboard.press('ArrowRight');
  assert(
    (await stateInvariantsTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight from Counterexample & Guard tab did not activate State & Invariants tab',
  );
  assert(
    (await page.locator('#is-panel-state-invariants').innerText()).includes('inv_containment_seal'),
    'InterlockSim State & Invariants tab missing inv_containment_seal row',
  );
  await page.keyboard.press('ArrowRight');
  assert(
    (await isAssumptionsTab.getAttribute('aria-selected')) === 'true',
    'ArrowRight from State & Invariants tab did not activate Assumptions tab',
  );
  assert(
    (await page.locator('#is-panel-assumptions').innerText()).includes('assumption_educational_scope'),
    'InterlockSim missing assumption_educational_scope disclosure',
  );
  await checkAxeWcagAA('InterlockSim Assumptions inspector tab');
  await page.keyboard.press('End');
  assert(
    (await isJsonTab.getAttribute('aria-selected')) === 'true',
    'End in InterlockSim tablist did not activate JSON tab',
  );
  await page.keyboard.press('Home');
  assert(
    (await traceGuardTab.getAttribute('aria-selected')) === 'true',
    'Home in InterlockSim tablist did not activate Counterexample & Guard tab',
  );

  const isStepBackBtn = page.getByRole('button', { name: 'Step Back', exact: true });
  await focusViaKeyboard(isStepBackBtn, 'InterlockSim Step Back button');
  await page.keyboard.press('Enter');
  await page.getByText('Step 5 of 6').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByText('Step 0 of 6').first().waitFor({ state: 'visible' });
  const isStepForwardBtn = page.getByRole('button', { name: 'Step Forward', exact: true });
  await isStepForwardBtn.focus();
  for (let step = 1; step <= 6; step += 1) {
    await page.keyboard.press('Enter');
    await page.getByText(`Step ${step} of 6`).first().waitFor({ state: 'visible' });
  }

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

  // Guided repair -> VERIFIED (29 states, Goal reachable: Yes)
  const guidedRepairBtn = page.getByRole('button', { name: 'Apply Principled Repair' });
  const jsonBeforeRepair = page.locator('#interlock-json-textarea');
  await isJsonTab.click();
  const savedJsonBeforeRepair = await jsonBeforeRepair.inputValue();
  await jsonBeforeRepair.fill(`${savedJsonBeforeRepair}\n `);
  assert(await guidedRepairBtn.isDisabled(), 'Candidate repair could overwrite an unsaved JSON draft');
  await jsonBeforeRepair.fill(savedJsonBeforeRepair);
  await traceGuardTab.click();
  await guidedRepairBtn.click();
  await waitForVisibleFocus('#inspector-rule-select');
  await page.getByText('OUTDATED: VIOLATED').first().waitFor({ state: 'visible' });
  await page
    .locator('.is-schematic-status-strip .is-badge', { hasText: 'OUTDATED SNAPSHOT' })
    .waitFor({ state: 'visible' });
  await page.getByText('Snapshot guard:', { exact: false }).first().waitFor({ state: 'visible' });
  const isOpenInnerItem = page.locator('.is-timeline .is-timeline-item', {
    hasText: 'open_inner_door',
  });
  assert((await isOpenInnerItem.count()) === 1, 'Expected unique InterlockSim trace item for open_inner_door');
  const editDraftGuardBtn = isOpenInnerItem.getByRole('button', { name: 'Edit draft guard' });
  await editDraftGuardBtn.waitFor({ state: 'visible' });
  assert(
    (await editDraftGuardBtn.getAttribute('aria-label')) === 'Edit draft guard for open_inner_door',
    'Stale InterlockSim trace jump aria-label missing exact Edit draft guard + ruleId',
  );

  // Unsaved numeric draft in Guard Inspector is preserved across tab switches and guard jump under reduced motion,
  // including repeated same-target jumps, and restores the existing valid number
  const guardIntInput = page.locator('.is-guard-tree-scroll input[inputmode="numeric"]').first();
  const originalGuardInt = await guardIntInput.inputValue();
  await guardIntInput.fill('1x');
  assert(
    (await guardIntInput.getAttribute('aria-invalid')) === 'true',
    'Invalid numeric guard draft missing aria-invalid before jump',
  );
  await isAssumptionsTab.click();
  await traceGuardTab.click();
  assert(
    (await guardIntInput.inputValue()) === '1x' &&
      (await guardIntInput.getAttribute('aria-invalid')) === 'true',
    'Switching tabs wiped unsaved invalid numeric draft',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installScrollSpy();
  await clearScrollSpy();
  await editDraftGuardBtn.click();
  await waitForVisibleFocus('#inspector-rule-select');
  assert(
    (await traceGuardTab.getAttribute('aria-selected')) === 'true',
    'Edit draft guard jump did not keep Counterexample & Guard tab active',
  );
  const isFirstScrolls = await readScrollSpy();
  assert(
    isFirstScrolls.some((c) => c.options?.behavior === 'auto' && c.options?.block === 'center'),
    `Expected centered reduced-motion scroll on InterlockSim jump, got ${JSON.stringify(isFirstScrolls)}`,
  );
  assert(
    (await guardIntInput.inputValue()) === '1x' &&
      (await guardIntInput.getAttribute('aria-invalid')) === 'true',
    'Guard jump wiped unsaved invalid numeric draft',
  );
  // Repeated same-target jump
  await page.locator('#is-verdict-pane').focus();
  await clearScrollSpy();
  await editDraftGuardBtn.click();
  await waitForVisibleFocus('#inspector-rule-select');
  const isRepeatScrolls = await readScrollSpy();
  assert(
    isRepeatScrolls.some((c) => c.options?.behavior === 'auto' && c.options?.block === 'center'),
    `Expected reduced-motion scrollIntoView on repeated InterlockSim jump, got ${JSON.stringify(isRepeatScrolls)}`,
  );
  await page.getByRole('button', { name: 'Edit draft guard for equalize_pressure', exact: true }).click();
  await waitForVisibleFocus('#inspector-rule-select');
  assert(
    (await page.locator('#inspector-rule-select').inputValue()) === 'equalize_pressure',
    'Jumping to a different guard did not update the inspector selection',
  );
  await editDraftGuardBtn.click();
  await waitForVisibleFocus('#inspector-rule-select');
  assert(
    (await guardIntInput.inputValue()) === '1x',
    'Jumping to a different guard discarded the original numeric draft',
  );
  await uninstallScrollSpy();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await guardIntInput.fill(originalGuardInt);

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
  assert(
    (await page.locator('#max-states-input').getAttribute('aria-invalid')) === 'true',
    'InterlockSim maxStates range error missing aria-invalid',
  );
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
  // Verify Tab and Shift+Tab trap focus strictly inside aria-modal="true" alertdialog
  await page.keyboard.press('Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')) ===
      'Discard & Continue',
    'Tab from Stay Here did not move to Discard & Continue inside alertdialog',
  );
  await page.keyboard.press('Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')) === 'Stay Here',
    'Tab from last alertdialog control escaped modal focus trap',
  );
  await page.keyboard.press('Shift+Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')) ===
      'Discard & Continue',
    'Shift+Tab from first alertdialog control escaped modal focus trap',
  );
  await page.keyboard.press('Shift+Tab');
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
  await assertTelemetryGridEdgeToEdge('InterlockSim mobile 375x812');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installScrollSpy();
  await page.getByRole('button', { name: 'Jump to Schematic' }).click();
  assert(
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'is-schematic-pane',
    'InterlockSim mobile Jump to Schematic did not focus #is-schematic-pane',
  );
  await page.getByRole('button', { name: 'Jump to Verdict & Guard' }).click();
  assert(
    (await page.evaluate(() => document.activeElement?.id ?? '')) === 'is-verdict-pane',
    'InterlockSim mobile Jump to Verdict & Guard did not focus #is-verdict-pane',
  );
  const isMobileScrolls = await readScrollSpy();
  assert(
    isMobileScrolls.filter((c) => c.options?.behavior === 'auto' && c.options?.block === 'start').length >= 2,
    `Expected reduced-motion scrollIntoView on InterlockSim mobile pane shortcuts, got ${JSON.stringify(isMobileScrolls)}`,
  );
  await uninstallScrollSpy();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await checkAxeWcagAA('InterlockSim mobile 375x812');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-mobile-375.png') });
  await page.setViewportSize({ width: 360, height: 800 });
  await checkNoOverflow('InterlockSim mobile 360x800');
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkNoOverflow('InterlockSim desktop 1440x900');
  await assertTelemetryGridEdgeToEdge('InterlockSim desktop 1440x900');

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
    await faultPage.getByRole('button', { name: 'Dark', exact: true }).click();
    await faultPage.getByRole('button', { name: verifyButton }).click();
    const cancelBtn = faultPage.getByRole('button', { name: 'Cancel Verification' });
    await cancelBtn.hover();
    assert(
      await cancelBtn.evaluate((el) => el.matches(':hover')),
      `Cancel Verification button was not in :hover state on ${app}`,
    );
    const hoverAxe = await new AxeBuilder({ page: faultPage })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const hoverBlocking = hoverAxe.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    assert(
      hoverBlocking.length === 0,
      `Dark hover WCAG AA violation on ${app} Cancel Verification: ${hoverBlocking.map((v) => v.id).join(', ')}`,
    );
    axeAudits.push(`${app} Dark Cancel Verification hover`);
    await cancelBtn.click();
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

  // A document reload retires the old route session. Fragment visits preserve the
  // current draft, while Back to a different pre-reload preset still asks.
  const reloadPage = await context.newPage();
  await reloadPage.goto(`${baseUrl}/suite/agent-gate/?preset=broken`);
  await reloadPage.selectOption('#preset-select', 'principled-fix');
  await reloadPage.waitForURL('**/?preset=principled-fix');
  const priorSession = await reloadPage.evaluate(() => history.state.sessionId);
  await reloadPage.reload();
  await reloadPage.waitForFunction((session) => history.state.sessionId !== session, priorSession);
  await reloadPage.getByRole('tab', { name: 'JSON' }).click();
  const reloadedJson = reloadPage.locator('#model-json-textarea');
  const dirtyJson = `${await reloadedJson.inputValue()}\n `;
  await reloadedJson.fill(dirtyJson);
  await reloadPage.evaluate(() => { location.hash = 'details'; });
  await reloadPage.waitForURL('**/?preset=principled-fix#details');
  await reloadPage.goBack();
  await reloadPage.waitForURL('**/?preset=principled-fix');
  assert((await reloadedJson.inputValue()) === dirtyJson, 'Fragment Back lost the reloaded draft');
  assert((await reloadPage.getByRole('alertdialog').count()) === 0, 'Fragment Back opened a discard prompt');
  await reloadPage.goBack();
  await reloadPage.getByRole('alertdialog').waitFor();
  await reloadPage.getByRole('button', { name: 'Stay Here' }).click();
  await reloadPage.waitForURL('**/?preset=principled-fix');
  assert((await reloadedJson.inputValue()) === dirtyJson, 'Pre-reload preset Back lost the draft');
  await reloadPage.close();

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
  assert(
    externalRequests.length === 0,
    `Unexpected external network/CDN requests: ${externalRequests.join('; ')}`,
  );

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
