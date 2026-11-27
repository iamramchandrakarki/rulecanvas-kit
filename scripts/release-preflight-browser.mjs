// Browser stage of the release preflight: serves the Staging_Directory on loopback under
// two base paths and checks the hub, hub <-> app navigation, and both workbenches in Chromium
// with real worker verification.
import { createServer } from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BASE_PATHS = ['/', '/rulecanvas-kit/'];
const VERDICT_TIMEOUT_MS = 30_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const APPS = [
  {
    app: 'agent-gate',
    sibling: 'interlock-sim',
    verdict: 'section.ag-verdict',
    verifyButton: /^Verify(?: Policy)?$/,
    siblingVerdict: 'section.is-verdict',
    presets: [
      { id: 'broken', status: 'VIOLATED', texts: ['Step 5 of 5', 'inv_no_confidential_publish'], nav: true },
      { id: 'principled-fix', status: 'VERIFIED', texts: ['Goal reachable: Yes'] },
    ],
  },
  {
    app: 'interlock-sim',
    sibling: 'agent-gate',
    verdict: 'section.is-verdict',
    verifyButton: /^Verify(?: Interlock Model)?$/,
    siblingVerdict: 'section.ag-verdict',
    presets: [
      { id: 'broken', status: 'VIOLATED', texts: ['Step 6 of 6', 'inv_containment_seal'], nav: true },
      { id: 'fixed', status: 'VERIFIED', texts: ['Goal reachable: Yes'] },
    ],
  },
];

const HUB_APPS = [
  { app: 'agent-gate', verdict: 'section.ag-verdict', presets: ['broken', 'vacuous-fix', 'principled-fix'] },
  { app: 'interlock-sim', verdict: 'section.is-verdict', presets: ['broken', 'vacuous', 'fixed'] },
];

// Hub at <base>: HTTP 200, preset links resolve under <base>, and each "Open Broken Scenario"
// link reaches a VIOLATED verdict whose brand link returns to the hub.
async function checkHub(context, origin, basePath, failures) {
  const hubUrl = `${origin}${basePath}`;
  const label = `${basePath} hub`;
  const page = await context.newPage();
  try {
    const response = await page.goto(hubUrl, { waitUntil: 'load' });
    if (response?.status() !== 200) {
      failures.push(`${label}: expected HTTP 200, got ${response?.status() ?? 'no response'}`);
      return;
    }
    if ((await page.locator('h1').count()) !== 1) {
      failures.push(`${label}: expected one h1`);
      return;
    }
    for (const spec of HUB_APPS) {
      await page.goto(hubUrl, { waitUntil: 'load' });
      const hrefs = await page
        .locator(`[data-app="${spec.app}"] a[data-preset]`)
        .evaluateAll((links) => links.map((a) => a.href));
      const expected = spec.presets.map((preset) => `${hubUrl}${spec.app}/?preset=${preset}`);
      if (JSON.stringify(hrefs) !== JSON.stringify(expected)) {
        failures.push(`${label}: ${spec.app} links resolve to ${JSON.stringify(hrefs)}, expected ${JSON.stringify(expected)}`);
        continue;
      }
      try {
        await page.locator(`[data-app="${spec.app}"] a[data-preset="broken"]`).click({ timeout: VERDICT_TIMEOUT_MS });
        await page.waitForURL(expected[0], { timeout: VERDICT_TIMEOUT_MS });
        await page
          .locator(`${spec.verdict}[data-status="VIOLATED"]`)
          .first()
          .waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS });
      } catch {
        failures.push(`${label}: Open Broken Scenario did not render a VIOLATED ${spec.app} verdict`);
        continue;
      }
      const brand = page.locator('a[data-rc-brand-link="true"]').first();
      const brandHref = (await brand.count()) === 1 ? await brand.evaluate((a) => a.href) : null;
      if (brandHref !== hubUrl) {
        failures.push(`${label}: ${spec.app} brand link resolves to ${brandHref}, expected ${hubUrl}`);
        continue;
      }
      try {
        await brand.click({ timeout: VERDICT_TIMEOUT_MS });
        await page.waitForURL(hubUrl, { timeout: VERDICT_TIMEOUT_MS });
        await page.locator('h1').first().waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS });
      } catch {
        failures.push(`${label}: ${spec.app} brand link did not return to the hub`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function startServer(stagingDir, errors) {
  const root = path.resolve(stagingDir);
  const server = createServer((req, res) => {
    const reject = (status) => {
      errors.push({ basePath: '-', app: '-', url: req.url ?? '', text: `server responded ${status}` });
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(status));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(405);
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      return reject(400);
    }
    if (pathname.includes('\0')) return reject(400);
    const prefix = pathname.startsWith('/rulecanvas-kit/') ? '/rulecanvas-kit/' : '/';
    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) return reject(403);
    let st;
    try {
      st = lstatSync(target);
    } catch {
      return reject(404);
    }
    if (st.isDirectory()) {
      res.writeHead(301, { location: `${pathname}/` });
      return res.end();
    }
    if (!st.isFile()) return reject(403);
    const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(target));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function checkPreset(context, origin, basePath, spec, preset, failures) {
  const label = `${basePath} ${spec.app} ?preset=${preset.id}`;
  const page = await context.newPage();
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  try {
    const entry = `${origin}${basePath}${spec.app}/`;
    await page.goto(`${entry}?preset=${preset.id}`, { waitUntil: 'load' });
    const verdict = page.locator(`${spec.verdict}[data-status="${preset.status}"]`);
    // The initial render verifies synchronously; an explicit run exercises the worker path.
    const workerMode = page.getByText('Execution: Background Web Worker', { exact: true });
    try {
      await verdict.first().waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS });
      const hasWorkerApi = await page.evaluate(() => typeof Worker === 'function');
      await page.getByRole('button', { name: spec.verifyButton }).first().click({ timeout: VERDICT_TIMEOUT_MS });
      if (hasWorkerApi) {
        await workerMode.first().waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS }).catch(() => {});
      }
      await verdict.first().waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS });
    } catch {
      failures.push(`${label}: ${preset.status} verdict did not render within 30 seconds`);
      return;
    }
    const body = await page.locator('body').innerText();
    for (const text of [...preset.texts, 'Execution: Background Web Worker']) {
      if (!body.includes(text)) failures.push(`${label}: missing text "${text}"`);
    }
    const workerPrefix = `${origin}${basePath}`;
    if (!workers.some((url) => url.startsWith(workerPrefix))) {
      failures.push(`${label}: no Worker under ${workerPrefix} (observed: ${workers.join(', ') || 'none'})`);
    }
    if (!preset.nav) return;
    const link = page.locator('nav a:not([aria-current="page"])').first();
    const href = await link.getAttribute('href');
    const siblingEntry = `${origin}${basePath}${spec.sibling}/`;
    const resolved = href === null ? null : new URL(href, page.url()).href;
    if (resolved !== siblingEntry) {
      failures.push(`${label}: nav link resolves to ${resolved}, expected ${siblingEntry}`);
      return;
    }
    await link.click();
    const discard = page.getByRole('button', { name: 'Discard & Continue' });
    const arrived = page.waitForURL((url) => url.href.startsWith(siblingEntry), { timeout: VERDICT_TIMEOUT_MS });
    const dialog = discard.waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS }).then(() => discard.click());
    await Promise.race([arrived, dialog.then(() => arrived)]).catch(() => {});
    try {
      await page.locator(spec.siblingVerdict).first().waitFor({ state: 'visible', timeout: VERDICT_TIMEOUT_MS });
    } catch {
      failures.push(`${label}: following nav link did not render the ${spec.sibling} workbench`);
    }
    dialog.catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
}

export async function runBrowserChecks({ chromium, stagingDir }) {
  const errors = [];
  const failures = [];
  const server = await startServer(stagingDir, errors);
  let browser = null;
  try {
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    for (const basePath of BASE_PATHS) {
      const context = await browser.newContext();
      let current = { app: '-' };
      const record = (url, text) => errors.push({ basePath, app: current.app, url, text });
      await context.route('**/*', (route) => {
        const url = route.request().url();
        let allowed = false;
        try {
          allowed = new URL(url).origin === origin;
        } catch {
          allowed = false;
        }
        if (allowed) return route.continue();
        record(url, 'request to non-loopback origin blocked');
        return route.abort('blockedbyclient');
      });
      context.on('weberror', (err) => record(err.page()?.url() ?? '-', `page error: ${err.error().message}`));
      context.on('console', (msg) => {
        if (msg.type() === 'error') record(msg.page()?.url() ?? '-', `console error: ${msg.text()}`);
      });
      context.on('requestfailed', (req) => record(req.url(), `request failed: ${req.failure()?.errorText ?? 'unknown'}`));
      context.on('response', (res) => {
        if (res.status() >= 400) record(res.url(), `HTTP ${res.status()}`);
      });
      try {
        current = { app: 'hub' };
        await checkHub(context, origin, basePath, failures);
        for (const spec of APPS) {
          current = spec;
          for (const preset of spec.presets) {
            await checkPreset(context, origin, basePath, spec, preset, failures);
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  const lines = [
    ...failures,
    ...errors.map((e) => `Browser_Error base=${e.basePath} app=${e.app} url=${e.url}: ${e.text}`),
  ];
  if (lines.length > 0) throw new Error(lines.join('\n  '));
}
