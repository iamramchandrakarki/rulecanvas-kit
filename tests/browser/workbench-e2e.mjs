import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const mod = await import(spec);
      if (mod?.chromium) return mod;
    } catch {
      // try next
    }
  }
  throw new Error('Playwright module not found. Set PLAYWRIGHT_MODULE or install playwright.');
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
        const target = existsSync(full) && statSync(full).isFile() ? full : path.join(mount.dir, 'index.html');
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
const { chromium } = await loadPlaywright();
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url()}`);
  });

  const checkNoOverflow = async (label) => {
    const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(ok, `Horizontal overflow detected at ${label}`);
  };

  // --- 1. AgentGate under /suite/agent-gate/ ---
  await page.goto(`${baseUrl}/suite/agent-gate/`, { waitUntil: 'networkidle' });
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });
  assert(
    (await page.locator('nav a[aria-current="page"]').innerText()).includes('AgentGate'),
    'AgentGate nav link missing aria-current="page"',
  );
  await checkNoOverflow('AgentGate desktop 1280x800');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-desktop-1280.png') });

  // Preset URL handling & comparison matrix
  await page.selectOption('#preset-select', 'principled-fix');
  await page.getByText('Goal reachable: Yes').first().waitFor({ state: 'visible' });
  assert(!(await page.getByText('OUTDATED:', { exact: false }).first().isVisible()),
    'Fresh AgentGate verdict marked outdated');
  assert(page.url().includes('preset=principled-fix'), `Expected preset=principled-fix in URL: ${page.url()}`);

  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();
  await page.locator('.ag-comparison-section').getByText('Naive Patch A').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Compare All 5 Presets' }).click();

  // Dirty-edit Back/Forward guard on AgentGate
  await page.selectOption('#preset-select', 'broken');
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Schema & State' }).click();
  await page.fill('#model-name-input', 'Custom Dirty Policy');
  await page.goBack();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    (await page.locator('#model-name-input').inputValue()) === 'Custom Dirty Policy',
    'Dirty AgentGate editor state lost after declining Back navigation',
  );

  // Tablet & Mobile AgentGate
  await page.setViewportSize({ width: 768, height: 1024 });
  await checkNoOverflow('AgentGate tablet 768x1024');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-tablet-768.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkNoOverflow('AgentGate mobile 390x844');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'agent-gate-mobile-390.png') });

  // Reciprocal cross-workbench navigation from AgentGate -> InterlockSim (with dirty prompt approval)
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('nav a', { hasText: 'InterlockSim' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard & Continue' }).click();
  await page.waitForURL('**/suite/interlock-sim/**');

  // --- 2. InterlockSim under /suite/interlock-sim/ ---
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByText('Step 6 of 6').first().waitFor({ state: 'visible' });
  assert(
    (await page.locator('nav a[aria-current="page"]').innerText()).includes('InterlockSim'),
    'InterlockSim nav link missing aria-current="page"',
  );
  await checkNoOverflow('InterlockSim desktop 1280x800');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-desktop-1280.png') });

  // Guided repair -> VERIFIED (29 states, Goal reachable: Yes)
  await page.getByRole('button', { name: 'Apply Principled Repair' }).click();
  await page.getByText('OUTDATED: VIOLATED').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Verify Interlock Model' }).click();
  await page.getByText('Goal reachable: Yes').first().waitFor({ state: 'visible' });
  assert(!(await page.getByText('OUTDATED:', { exact: false }).first().isVisible()),
    'Fresh InterlockSim verdict marked outdated');
  assert((await page.locator('body').innerText()).includes('29'), 'Expected 29 states after repair');

  // Preset URL direct load (?preset=vacuous)
  await page.goto(`${baseUrl}/suite/interlock-sim/?preset=vacuous`, { waitUntil: 'networkidle' });
  await page.getByText('VERIFIED (GOAL UNREACHABLE)').first().waitFor({ state: 'visible' });

  // Tablet & Mobile InterlockSim
  await page.setViewportSize({ width: 768, height: 1024 });
  await checkNoOverflow('InterlockSim tablet 768x1024');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-tablet-768.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkNoOverflow('InterlockSim mobile 390x844');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'interlock-sim-mobile-390.png') });

  // Clean reciprocal link back to AgentGate
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('nav a', { hasText: 'AgentGate' }).click();
  await page.waitForURL('**/suite/agent-gate/**');
  await page.getByText('VIOLATED', { exact: false }).first().waitFor({ state: 'visible' });

  // --- 3. Dirty JSON draft protection + alertdialog focus management ---
  await page.getByRole('tab', { name: 'JSON' }).click();
  const jsonArea = page.locator('#model-json-textarea');
  await jsonArea.waitFor({ state: 'visible' });
  const originalJson = await jsonArea.inputValue();
  await jsonArea.fill(`${originalJson}\n `);
  await page.locator('#preset-select').selectOption('naive-patch-a');
  await page.getByRole('alertdialog').waitFor({ state: 'visible' });
  const focusedInDialog = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  assert(
    focusedInDialog === 'Stay Here',
    `Expected alertdialog to focus "Stay Here" button, got "${focusedInDialog}"`,
  );
  await page.getByRole('button', { name: 'Stay Here' }).click();
  assert(
    (await jsonArea.inputValue()) === `${originalJson}\n `,
    'Dirty JSON draft was lost after declining discard prompt',
  );

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
        screenshotDir: SCREENSHOT_DIR,
        screenshots: [
          'agent-gate-desktop-1280.png',
          'agent-gate-tablet-768.png',
          'agent-gate-mobile-390.png',
          'interlock-sim-desktop-1280.png',
          'interlock-sim-tablet-768.png',
          'interlock-sim-mobile-390.png',
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
