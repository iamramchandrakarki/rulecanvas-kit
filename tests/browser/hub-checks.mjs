// Hub (site/) and starter-template browser journeys for pnpm test:browser.
// Serves the same layout as a release: hub at <base>, apps at <base>agent-gate/ and
// <base>interlock-sim/, for base '/' and '/rulecanvas-kit/'. The packed starter build
// (STARTER_FIXTURE_DIST, or BOOKING_FIXTURE_DIST for older callers) is served at /starter/.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const APP_DIRS = {
  'agent-gate': path.join(REPO_ROOT, 'apps/agent-gate/dist'),
  'interlock-sim': path.join(REPO_ROOT, 'apps/interlock-sim/dist'),
};
export const HUB_BASE_PATHS = ['/', '/rulecanvas-kit/'];
const TIMEOUT_MS = 30_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const PRESET_LINKS = {
  'agent-gate': ['broken', 'vacuous-fix', 'principled-fix'],
  'interlock-sim': ['broken', 'vacuous', 'fixed'],
};

function assert(cond, msg) {
  if (!cond) throw new Error(`Hub E2E failed: ${msg}`);
}

function resolveFile(pathname, starterDir) {
  let rest = pathname;
  if (starterDir !== null && (rest === '/starter' || rest.startsWith('/starter/'))) {
    return { root: starterDir, rel: rest.slice('/starter'.length) };
  }
  if (rest.startsWith('/rulecanvas-kit/') || rest === '/rulecanvas-kit') rest = rest.slice('/rulecanvas-kit'.length);
  const [first, ...more] = rest.replace(/^\/+/, '').split('/');
  if (first !== undefined && Object.hasOwn(APP_DIRS, first)) {
    return { root: APP_DIRS[first], rel: `/${more.join('/')}`, bare: more.length === 0 };
  }
  return { root: SITE_DIR, rel: rest };
}

function startServer(starterDir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const { root, rel, bare } = resolveFile(pathname, starterDir);
    if (bare || (rel === '' && root === starterDir)) {
      res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    let full = path.resolve(root, `.${rel}`);
    if (full !== root && !full.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(full) && statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(full)] ?? 'application/octet-stream' });
    res.end(readFileSync(full));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Records the theme attribute at the moment <body> is inserted, before first paint. */
const THEME_AT_BODY_SCRIPT = () => {
  const record = () => {
    if (window.__rcThemeAtBody === undefined && document.body !== null) {
      window.__rcThemeAtBody = document.documentElement.getAttribute('data-theme');
    }
  };
  new MutationObserver(record).observe(document, { childList: true, subtree: true });
};

function watchErrors(context, origin, label, errors) {
  context.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${label} console: ${msg.text()}`);
  });
  context.on('weberror', (err) => errors.push(`${label} page error: ${err.error().message}`));
  context.on('response', (res) => {
    if (res.status() >= 400) errors.push(`${label} HTTP ${res.status()} ${res.url()}`);
  });
  context.on('requestfailed', (req) => {
    if (req.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`${label} request failed ${req.url()}: ${req.failure()?.errorText}`);
    }
  });
  return context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === origin) {
      return route.continue();
    }
    errors.push(`${label} external request blocked: ${url}`);
    return route.abort('blockedbyclient');
  });
}

async function checkAxe(AxeBuilder, page, label, audits) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  assert(
    blocking.length === 0,
    `WCAG A/AA axe violations at ${label}: ${blocking
      .map((v) => `[${v.impact}] ${v.id} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
      .join('; ')}`,
  );
  audits.push(label);
}

async function assertFirstViewport(page, label) {
  const report = await page.evaluate(() => {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const required = [
      ...document.querySelectorAll('h1, .theme-switch, .panel h2, .panel .cta, .panel .quiet'),
    ].map((el) => ({ name: el.className || el.tagName, ...box(el) }));
    const panels = [...document.querySelectorAll('.panel')].map(box);
    return { vh, vw, required, panels, scrollWidth: document.documentElement.scrollWidth };
  });
  const outside = report.required.filter((r) => r.top < 0 || r.bottom > report.vh || r.right > report.vw);
  assert(outside.length === 0, `${label}: outside the first viewport: ${JSON.stringify(outside)}`);
  assert(report.required.length === 10, `${label}: expected 10 first-viewport elements, got ${report.required.length}`);
  const [a, b] = report.panels;
  assert(
    a !== undefined && b !== undefined && Math.abs(a.top - b.top) < 1 && b.left >= a.right,
    `${label}: workbench panels are not side by side: ${JSON.stringify(report.panels)}`,
  );
  assert(report.scrollWidth <= report.vw, `${label}: horizontal overflow ${report.scrollWidth} > ${report.vw}`);
}

async function checkHubAtBase({ browser, AxeBuilder, origin, basePath, screenshotDir, audits, errors }) {
  const hubUrl = `${origin}${basePath}`;
  const label = `hub ${basePath}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' });
  await watchErrors(context, origin, label, errors);
  await context.addInitScript(THEME_AT_BODY_SCRIPT);
  const page = await context.newPage();
  try {
    const response = await page.goto(hubUrl, { waitUntil: 'networkidle' });
    assert(response?.status() === 200, `${label}: expected HTTP 200, got ${response?.status()}`);
    await page.getByRole('heading', { level: 1, name: /compose across transitions/ }).waitFor();

    for (const [app, presets] of Object.entries(PRESET_LINKS)) {
      const hrefs = await page
        .locator(`.panel[data-app="${app}"] a[data-preset]`)
        .evaluateAll((links) => links.map((a) => a.href));
      assert(
        JSON.stringify(hrefs) === JSON.stringify(presets.map((p) => `${hubUrl}${app}/?preset=${p}`)),
        `${label}: ${app} preset links resolve to ${JSON.stringify(hrefs)}`,
      );
    }

    await assertFirstViewport(page, `${label} 1280x720`);
    if (basePath === '/') {
      await page.screenshot({ path: path.join(screenshotDir, 'hub-desktop-1280x720.png') });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await assertFirstViewport(page, `${label} 1440x900`);
    await checkAxe(AxeBuilder, page, `${label} Light 1440x900`, audits);

    // Dark preference persists and the next document paints dark from its first frame.
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', `${label}: Dark not applied`);
    assert(
      (await page.evaluate(() => localStorage.getItem('rulecanvas-theme'))) === 'dark',
      `${label}: Dark preference not stored`,
    );
    await checkAxe(AxeBuilder, page, `${label} Dark 1440x900`, audits);
    if (basePath === '/') {
      await page.screenshot({ path: path.join(screenshotDir, 'hub-desktop-1440x900-dark.png') });
    }

    // Hub -> AgentGate broken preset -> brand link back to the hub.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.panel[data-app="agent-gate"] .cta').click();
    await page.waitForURL(`${hubUrl}agent-gate/?preset=broken`, { timeout: TIMEOUT_MS });
    await page.locator('section.ag-verdict[data-status="VIOLATED"]').waitFor({ timeout: TIMEOUT_MS });
    assert(
      (await page.evaluate(() => window.__rcThemeAtBody)) === 'dark',
      `${label}: AgentGate painted before the dark theme was applied`,
    );
    const agBrand = page.locator('a[data-rc-brand-link="true"]');
    assert(
      (await agBrand.evaluate((a) => a.href)) === hubUrl,
      `${label}: AgentGate brand link does not resolve to the hub`,
    );

    // Unsaved edits: the brand link goes through the discard dialog.
    await page.getByRole('tab', { name: 'Schema & State' }).click();
    await page.fill('#model-name-input', 'Unsaved hub-return edit');
    await agBrand.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ state: 'visible' });
    assert(
      (await dialog.innerText()).includes('Opening "RuleCanvasKit hub" will discard'),
      `${label}: discard dialog does not name the hub`,
    );
    await page.getByRole('button', { name: 'Stay Here' }).click();
    assert(page.url().startsWith(`${hubUrl}agent-gate/`), `${label}: Stay Here left AgentGate`);
    assert(
      (await page.locator('#model-name-input').inputValue()) === 'Unsaved hub-return edit',
      `${label}: Stay Here lost the unsaved edit`,
    );
    await agBrand.click();
    await page.getByRole('button', { name: 'Discard & Continue' }).click();
    await page.waitForURL(hubUrl, { timeout: TIMEOUT_MS });
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert(
      (await page.evaluate(() => window.__rcThemeAtBody)) === 'dark',
      `${label}: hub painted before the dark theme was applied`,
    );

    // Hub -> InterlockSim broken preset -> clean brand link back.
    await page.locator('.panel[data-app="interlock-sim"] .cta').click();
    await page.waitForURL(`${hubUrl}interlock-sim/?preset=broken`, { timeout: TIMEOUT_MS });
    await page.locator('section.is-verdict[data-status="VIOLATED"]').waitFor({ timeout: TIMEOUT_MS });
    await page.locator('a[data-rc-brand-link="true"]').click();
    await page.waitForURL(hubUrl, { timeout: TIMEOUT_MS });

    // Quiet links open the fixes.
    await page.locator('.panel[data-app="agent-gate"] a[data-preset="principled-fix"]').click();
    await page.locator('section.ag-verdict[data-status="VERIFIED"]').waitFor({ timeout: TIMEOUT_MS });
    await page.goto(hubUrl, { waitUntil: 'networkidle' });
    await page.locator('.panel[data-app="interlock-sim"] a[data-preset="vacuous"]').click();
    await page.locator('section.is-verdict[data-status="VERIFIED"]').waitFor({ timeout: TIMEOUT_MS });

    await page.goto(hubUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Light', exact: true }).click();
  } finally {
    await context.close();
  }
}

async function checkHubResponsiveAndMotion({ browser, origin, screenshotDir, errors }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await watchErrors(context, origin, 'hub mobile', errors);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    for (const width of [390, 360, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `hub ${width}px: horizontal overflow of ${overflow}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'hub System theme ignored dark scheme');
    const motion = await page.evaluate(() => {
      const cta = document.querySelector('.cta');
      const rail = document.querySelector('.rail-steps');
      return {
        cta: getComputedStyle(cta).transitionDuration,
        rail: getComputedStyle(rail, '::after').transitionDuration,
      };
    });
    assert(
      motion.cta.split(',').every((d) => d.trim() === '0s') && motion.rail.split(',').every((d) => d.trim() === '0s'),
      `hub reduced motion still animates: ${JSON.stringify(motion)}`,
    );
    await page.screenshot({ path: path.join(screenshotDir, 'hub-mobile-390.png'), fullPage: true });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('.cta, .panel, .quiet, .theme-btn, .rail-steps')].flatMap((el) =>
        [getComputedStyle(el), getComputedStyle(el, '::after')].flatMap((s) =>
          s.transitionDuration.split(',').map((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 1 : 1000)),
        ),
      ),
    );
    const outOfScale = durations.filter((ms) => ms !== 0 && (ms < 90 || ms > 280));
    assert(outOfScale.length === 0, `hub transitions outside 90-280ms: ${outOfScale.join(', ')}`);
  } finally {
    await context.close();
  }
}

async function checkStarter({ browser, AxeBuilder, origin, screenshotDir, audits, errors }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await watchErrors(context, origin, 'starter', errors);
  const page = await context.newPage();
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  try {
    await page.goto(`${origin}/starter/`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'CI/CD Production Release Gate' }).waitFor();
    const main = page.locator('main');
    assert((await main.getAttribute('data-export-ok')) === 'true', 'starter could not export its model as JSON');
    await page.getByRole('button', { name: 'Verify model' }).click();
    await page.locator('main[data-verification-revision="1"][data-execution-mode="worker"]').waitFor({ timeout: TIMEOUT_MS });
    await page.locator('main .badge[data-status="VIOLATED"]').waitFor();
    const trace = await page.locator('main ol.trace').innerText();
    assert(trace.includes('open-hotfix-bypass') && trace.includes('promote-prod'), `starter trace: ${trace}`);
    assert((await page.locator('main').innerText()).includes('prod-requires-review'), 'starter missing invariant id');
    assert(
      workers.some((url) => url.startsWith(`${origin}/starter/`)),
      `starter worker not served under /starter/: ${workers.join(', ')}`,
    );
    await checkAxe(AxeBuilder, page, 'starter broken Light', audits);

    await page.getByRole('link', { name: 'Principled fix' }).click();
    await page.waitForURL(`${origin}/starter/?variant=principled`);
    await page.getByRole('button', { name: 'Verify model' }).click();
    await page.locator('main[data-verification-revision="1"][data-execution-mode="worker"]').waitFor({ timeout: TIMEOUT_MS });
    await page.locator('main .badge[data-status="VERIFIED"]').waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    await checkAxe(AxeBuilder, page, 'starter principled Dark', audits);
    await page.screenshot({ path: path.join(screenshotDir, 'starter-principled-1280.png') });

    // The strict codec rejects duplicate keys before anything is verified.
    await page.fill('#model-json', '{ "id": "a", "id": "b" }');
    await page.getByRole('button', { name: 'Verify model' }).click();
    await page.locator('#model-json-errors[role="alert"]').waitFor();
    assert(
      (await page.locator('main').getAttribute('data-verification-revision')) === '1',
      'starter verified a model with duplicate keys',
    );
  } finally {
    await context.close();
  }
}

/**
 * Runs every hub and starter journey. Returns the axe audit labels and screenshot names.
 * Throws with all collected console, network, and HTTP errors.
 */
export async function runHubChecks({ browser, AxeBuilder, screenshotDir, starterDist }) {
  assert(existsSync(path.join(SITE_DIR, 'index.html')), 'site/index.html missing');
  for (const [app, dir] of Object.entries(APP_DIRS)) {
    assert(existsSync(path.join(dir, 'index.html')), `apps/${app}/dist missing; run pnpm build first`);
  }
  const starterDir = starterDist ? path.resolve(starterDist) : null;
  if (starterDir !== null) {
    assert(existsSync(path.join(starterDir, 'index.html')), `starter build missing at ${starterDir}`);
  }
  const server = await startServer(starterDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const audits = [];
  const errors = [];
  const screenshots = ['hub-desktop-1280x720.png', 'hub-desktop-1440x900-dark.png', 'hub-mobile-390.png'];
  try {
    for (const basePath of HUB_BASE_PATHS) {
      await checkHubAtBase({ browser, AxeBuilder, origin, basePath, screenshotDir, audits, errors });
    }
    await checkHubResponsiveAndMotion({ browser, origin, screenshotDir, errors });
    if (starterDir !== null) {
      await checkStarter({ browser, AxeBuilder, origin, screenshotDir, audits, errors });
      screenshots.push('starter-principled-1280.png');
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  assert(errors.length === 0, `browser errors:\n  ${errors.join('\n  ')}`);
  return { audits, screenshots, starterChecked: starterDir !== null };
}
