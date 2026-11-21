import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT_DIR, 'worker', 'schema.sql');
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function createSqliteD1Database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              const row = stmt.get(...params);
              return row === undefined ? null : row;
            },
            async run() {
              const info = stmt.run(...params);
              return { success: true, meta: { changes: Number(info.changes) || 0 } };
            }
          };
        }
      };
    },
    queryRaw(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    close() {
      db.close();
    }
  };
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function attachExternalRoutes(context, appOrigin) {
  await context.route('https://github.com/login/oauth/authorize**', async (route) => {
    const reqUrl = new URL(route.request().url());
    assert.equal(reqUrl.searchParams.get('scope'), null, 'GitHub OAuth authorize URL must omit scope');
    assert.ok(reqUrl.searchParams.get('client_id'));
    const state = reqUrl.searchParams.get('state');
    const redirectUri = reqUrl.searchParams.get('redirect_uri');
    assert.ok(state && redirectUri);

    const callbackTarget = `${redirectUri}?code=code_alice&state=${encodeURIComponent(state)}`;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><script>window.location.replace(${JSON.stringify(callbackTarget)});</script>`
    });
  });

  await context.route('https://raw.githubusercontent.com/alice/cd-metadata/main/index.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        schemaVersion: 1,
        catalogs: [{ title: 'Alice E2E List', url: `${appOrigin}/docs/sample-catalog.json` }]
      })
    });
  });

  await context.route('https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ schemaVersion: 1, catalogs: [] })
    });
  });

  await context.route(/https:\/\/(?:musicbrainz\.org|coverartarchive\.org|itunes\.apple\.com)\/.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ releases: [], images: [], results: [] })
    });
  });

  await context.route('https://custom.e2e.example/cover.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: ONE_BY_ONE_PNG
    });
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  assert.ok(
    dims.scrollWidth <= dims.innerWidth,
    `${label}: horizontal overflow detected (${dims.scrollWidth} > ${dims.innerWidth})`
  );
}

async function main() {
  const { default: worker } = await import('../worker/index.mjs');
  const db = createSqliteD1Database();

  const staticServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const relPath = decodeURIComponent(reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname);
    const resolved = path.resolve(ROOT_DIR, '.' + relPath);
    if (!resolved.startsWith(ROOT_DIR) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  });

  const mockGithubServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && reqUrl.pathname === '/login/oauth/access_token') {
      const payload = JSON.parse(bodyText);
      if (payload.code !== 'code_alice') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'gho_e2e_alice', token_type: 'bearer', scope: '' }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/user') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (token !== 'gho_e2e_alice') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1001, login: 'alice', avatar_url: 'https://avatars.example/alice.png' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const [appOrigin, githubBaseUrl] = await Promise.all([
    listenServer(staticServer),
    listenServer(mockGithubServer)
  ]);

  let workerBaseUrl = '';
  const workerEnv = {
    DB: db,
    ALLOWED_ORIGINS: appOrigin,
    ALLOW_LOCALHOST: 'true',
    APP_REDIRECT_URL: `${appOrigin}/index.html`,
    GITHUB_CLIENT_ID: 'gh-e2e-client',
    GITHUB_CLIENT_SECRET: 'gh-e2e-secret',
    JWT_SECRET: 'e2e-browser-jwt-secret-0123456789abcdef',
    GITHUB_OAUTH_TOKEN_URL: `${githubBaseUrl}/login/oauth/access_token`,
    GITHUB_USER_API_URL: `${githubBaseUrl}/user`,
    DAILY_REQ_LIMIT: '80000',
    DAILY_WRITE_LIMIT: '80000',
    USER_HOURLY_WRITE_LIMIT: '60',
    MAX_PAYLOAD_BYTES: '131072',
    PAUSE_SYNC: 'false'
  };

  const workerServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, workerBaseUrl);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else if (v !== undefined) {
        headers.set(k, v);
      }
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyBuf;

    const workerRes = await worker.fetch(new Request(reqUrl.toString(), init), workerEnv);
    res.statusCode = workerRes.status;
    for (const [k, v] of workerRes.headers.entries()) res.setHeader(k, v);
    res.end(Buffer.from(await workerRes.arrayBuffer()));
  });
  workerBaseUrl = await listenServer(workerServer);

  const browser = await chromium.launch({ headless: true });
  const appUrlWithSync = `${appOrigin}/index.html?syncApi=${encodeURIComponent(workerBaseUrl)}`;

  try {
    // Device A: Desktop + Mobile layout + full OAuth login + edits + reload persistence
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await attachExternalRoutes(ctxA, appOrigin);
    const pageA = await ctxA.newPage();
    const pageAErrors = [];
    pageA.on('pageerror', (err) => pageAErrors.push(err.message));

    await pageA.goto(appUrlWithSync);
    await pageA.waitForSelector('#githubAuthBtn:not(.hidden)');
    await assertNoHorizontalOverflow(pageA, 'Signed-out desktop');
    await pageA.setViewportSize({ width: 375, height: 812 });
    await assertNoHorizontalOverflow(pageA, 'Signed-out mobile');
    await pageA.setViewportSize({ width: 1280, height: 800 });

    await pageA.click('#githubAuthBtn');
    await pageA.waitForSelector('#githubSignOutBtn:not(.hidden)');
    await pageA.waitForFunction(() => {
      const pill = document.getElementById('syncStatusPill');
      return pill && pill.textContent.includes('@alice') && !pill.textContent.includes('Syncing');
    });
    assert.equal(await pageA.evaluate(() => window.location.hash), '');

    await pageA.waitForSelector('[data-action="load-preset"]');
    assert.ok((await pageA.textContent('#catalogPresetsList')).includes('Alice E2E List'));
    await pageA.click('[data-action="load-preset"]');
    await pageA.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '0 / 1');

    // Toggle sample-01 acquired, switch to 1-Col view, add custom cover in Crate Flip, wait for Synced
    await pageA.click('.check-btn[data-action="toggle-acq"][data-id="sample-01"]');
    await pageA.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 1');

    await pageA.click('#viewModeBtn');
    await pageA.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent === 'Grid View');

    await pageA.click('#openCrateFlipBtn');
    await pageA.waitForSelector('#lightboxModal.open');
    await pageA.click('#lbToggleCustomBtn');
    await pageA.selectOption('#customCoverLabel', 'Custom Jacket');
    await pageA.fill('#customCoverInput', 'https://custom.e2e.example/cover.png');
    await pageA.click('#saveCustomCoverBtn');
    await pageA.waitForFunction(() => document.getElementById('lbVariantsList')?.textContent.includes('Custom Jacket'));
    await pageA.click('#closeLightboxBtn');

    await pageA.waitForFunction(() => document.getElementById('syncStatusPill')?.textContent.includes('Synced'));

    // Reload Device A and confirm state survives in real localStorage + sync pull
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 1');
    await pageA.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent === 'Grid View');
    await pageA.waitForFunction(() => document.getElementById('syncStatusPill')?.textContent.includes('Synced'));
    await pageA.waitForSelector('img[src="https://custom.e2e.example/cover.png"]');
    assert.equal(pageAErrors.length, 0, `Unexpected Device A page errors: ${pageAErrors.join('; ')}`);
    await ctxA.close();

    // Device B: Separate clean context at 375x812 mobile viewport -> signs in -> restores SQLite state
    const ctxB = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await attachExternalRoutes(ctxB, appOrigin);
    const pageB = await ctxB.newPage();
    const pageBErrors = [];
    pageB.on('pageerror', (err) => pageBErrors.push(err.message));

    await pageB.goto(appUrlWithSync);
    await pageB.waitForSelector('#githubAuthBtn:not(.hidden)');
    await pageB.click('#githubAuthBtn');
    await pageB.waitForFunction(() => document.getElementById('syncStatusPill')?.textContent.includes('Synced'));
    await pageB.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 1');
    await pageB.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent === 'Grid View');
    await pageB.waitForSelector('img[src="https://custom.e2e.example/cover.png"]');
    await assertNoHorizontalOverflow(pageB, 'Signed-in mobile 375px');

    // Verify immediate visibilitychange keepalive flush beats the 2500ms debounce
    await pageB.click('.check-btn[data-action="toggle-acq"][data-id="sample-01"]');
    await pageB.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '0 / 1');
    await pageB.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const deadline = Date.now() + 1200;
    let persistedUncheck = false;
    while (Date.now() < deadline) {
      const rows = db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
      if (rows.length === 1) {
        const parsed = JSON.parse(rows[0].state_json);
        const catEntry = Object.values(parsed.catalogs || {})[0];
        if (catEntry && !catEntry.checklist['sample-01']) {
          persistedUncheck = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(persistedUncheck, true, 'Expected keepalive flush on visibilitychange to persist within 1200ms');
    assert.equal(pageBErrors.length, 0, `Unexpected Device B page errors: ${pageBErrors.join('; ')}`);
    await ctxB.close();

    console.log('✓ Browser E2E checks passed (desktop + 375px mobile, OAuth, multi-device SQLite sync, keepalive flush)');
  } finally {
    await browser.close();
    await Promise.all([closeServer(staticServer), closeServer(mockGithubServer), closeServer(workerServer)]);
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
