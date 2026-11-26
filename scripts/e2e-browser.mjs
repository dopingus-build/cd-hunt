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
const SAMPLE_COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#38bdf8"/></svg>';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
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
            async all() {
              const results = stmt.all(...params);
              return { results, success: true };
            },
            async run() {
              const info = stmt.run(...params);
              return { success: true, meta: { changes: Number(info.changes) || 0 } };
            }
          };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) {
          out.push(await s.run());
        }
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
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

async function attachExternalRoutes(context, appOrigin, workerBaseUrl, opts = {}) {
  const authCode = opts.authCode || 'code_alice';
  const stateFlags = opts.stateFlags || {};
  const sampleSheetCsv = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'sample-catalog-sheet.csv'), 'utf8');
  const dupSheetCsv = opts.dupSheetCsv || '';

  await context.route(
    (url) => url.origin + url.pathname === `${workerBaseUrl}/auth/login`,
    async (route) => {
      // Execute real local Worker /auth/login without letting Chromium follow the 302 to live github.com
      const workerRes = await fetch(route.request().url(), { redirect: 'manual' });
      assert.equal(workerRes.status, 302, 'Expected Worker /auth/login to return 302');
      const ghAuthUrl = new URL(workerRes.headers.get('location'));
      assert.equal(ghAuthUrl.origin + ghAuthUrl.pathname, 'https://github.com/login/oauth/authorize');
      assert.equal(ghAuthUrl.searchParams.get('scope'), null, 'GitHub OAuth authorize URL must omit scope');
      assert.equal(ghAuthUrl.searchParams.get('client_id'), 'gh-e2e-client');
      const state = ghAuthUrl.searchParams.get('state');
      const redirectUri = ghAuthUrl.searchParams.get('redirect_uri');
      assert.ok(state && redirectUri);

      const callbackTarget = `${redirectUri}?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state)}`;
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><script>window.location.replace(${JSON.stringify(callbackTarget)});</script>`
      });
    }
  );

  await context.route(
    (url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    async (route) => {
      const reqUrl = new URL(route.request().url());

      if (reqUrl.href === 'https://raw.githubusercontent.com/alice/cd-metadata/main/index.json') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            schemaVersion: 1,
            catalogs: [{ title: 'Alice E2E List', url: `${appOrigin}/docs/sample-catalog.json` }]
          })
        });
        return;
      }

      if (reqUrl.href === 'https://raw.githubusercontent.com/bob/cd-metadata/main/index.json') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Not found' })
        });
        return;
      }

      if (reqUrl.href === 'https://docs.google.com/spreadsheets/d/e2eSheet01/export?format=csv') {
        if (stateFlags.sheetOffline) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/csv; charset=utf-8',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: sampleSheetCsv
        });
        return;
      }

      if (reqUrl.href === 'https://docs.google.com/spreadsheets/d/e2eDupSheet/export?format=csv') {
        if (stateFlags.dupSheetOffline) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/csv; charset=utf-8',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: dupSheetCsv
        });
        return;
      }

      if (reqUrl.href === 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ schemaVersion: 1, catalogs: [] })
        });
        return;
      }

      if (reqUrl.hostname === 'itunes.apple.com') {
        const term = reqUrl.searchParams.get('term') || '';
        const country = reqUrl.searchParams.get('country') || '';
        const results =
          country === 'jp' && term.includes('yama slash')
            ? [
                {
                  trackName: 'slash',
                  collectionName: 'slash (通常盤)',
                  artistName: 'yama',
                  artworkUrl100: 'https://custom.e2e.example/itunes-100x100bb.svg'
                }
              ]
            : [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ results })
        });
        return;
      }

      if (reqUrl.hostname === 'musicbrainz.org') {
        if (stateFlags.mbOffline) {
          await route.abort('failed');
          return;
        }
        const queryParam = reqUrl.searchParams.get('query') || '';
        if (reqUrl.pathname === '/ws/2/release/' && queryParam.includes('CPCA-1004')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
              releases: [
                {
                  id: '10040000-0000-4000-8000-000000000001',
                  title: 'Breath of Fire III OST',
                  status: 'Official',
                  'label-info': [{ 'catalog-number': 'CPCA-1004' }]
                }
              ]
            })
          });
          return;
        }
        if (reqUrl.pathname === '/ws/2/release/10040000-0000-4000-8000-000000000001') {
          stateFlags.mbTrackFetchCount = (stateFlags.mbTrackFetchCount || 0) + 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
              id: '10040000-0000-4000-8000-000000000001',
              title: 'Breath of Fire III OST',
              'label-info': [{ 'catalog-number': 'CPCA-1004' }],
              media: [
                {
                  position: 1,
                  format: 'CD',
                  tracks: [
                    { position: 1, title: "Ryu's Theme", length: 195000, 'artist-credit': [{ name: 'Capcom' }] },
                    { position: 2, title: 'To a Distant Place', length: 242000, 'artist-credit': [{ name: 'Yoshino Aoki' }] }
                  ]
                },
                {
                  position: 2,
                  format: 'CD',
                  tracks: [
                    { position: 1, title: 'Bonus Disk Track', length: 160000, 'artist-credit': [{ name: 'Capcom' }] }
                  ]
                }
              ]
            })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ releases: [] })
        });
        return;
      }

      if (/^(?:coverartarchive\.org|itunes\.apple\.com)$/.test(reqUrl.hostname)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ releases: [], images: [], results: [] })
        });
        return;
      }

      if (
        reqUrl.href === 'https://custom.e2e.example/itunes-600x600bb.svg' ||
        reqUrl.href === 'https://custom.e2e.example/owned-cover.svg'
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: SAMPLE_COVER_SVG
        });
        return;
      }

      if (reqUrl.href === 'https://custom.e2e.example/cover.png') {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: ONE_BY_ONE_PNG
        });
        return;
      }

      throw new Error(`Unexpected external browser request in offline E2E: ${reqUrl.href}`);
    }
  );
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
    if (reqUrl.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
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

  const e2eUsers = {
    code_alice: { id: 1001, login: 'alice', avatar_url: 'https://avatars.example/alice.png', token: 'gho_e2e_alice' },
    code_bob: { id: 2002, login: 'bob', avatar_url: 'https://avatars.example/bob.png', token: 'gho_e2e_bob' }
  };

  const mockGithubServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && reqUrl.pathname === '/login/oauth/access_token') {
      const payload = JSON.parse(bodyText);
      const u = e2eUsers[payload.code];
      if (!u) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: u.token, token_type: 'bearer', scope: '' }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/user') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const matched = Object.values(e2eUsers).find((u) => u.token === token);
      if (!matched) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: matched.id, login: matched.login, avatar_url: matched.avatar_url }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8B64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).toString('base64');
  const saPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  const saBotEmail = 'cd-hunt-e2e@e2e-project.iam.gserviceaccount.com';
  const sheetBatchUpdates = [];
  const dupSheetRows = [
    ['Got it?', 'Aisle / Category', 'Artist / Franchise', 'Title / Release Details', 'Catalog Number'],
    ['FALSE', 'Video Game Soundtracks', 'Capcom (カプコン)', 'Breath of Fire III OST', 'CPCA-1004'],
    ['TRUE', 'Video Game Soundtracks', 'Capcom', 'Breath of Fire III OST (Dup)', 'CPCA-1004'],
    ['FALSE', 'J-Rock', 'Asian Kung-Fu Generation', 'Sol-fa', 'KSCL-737']
  ];
  const dupSheetBatchUpdates = [];
  const e2eDupSheetCsv = [
    'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
    'FALSE,Video Game Soundtracks,Capcom (カプコン),Breath of Fire III OST,CPCA-1004,Look under ブ,"¥3,000",,',
    'TRUE,Video Game Soundtracks,Capcom,Breath of Fire III OST (Dup),CPCA-1004,Look under ブ,"¥3,500",High,Mandarake',
    'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
  ].join('\n');

  const mockGoogleServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'ya29.e2e-sheet-token', expires_in: 3600 }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/e2eSheet01/values/A1:I500') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          values: [
            ['CD Hunt Title'],
            ['Got it?', 'Aisle / Category', 'Artist / Franchise', 'Title / Release Details', 'Catalog Number'],
            ['FALSE', 'Video Game Soundtracks', 'Capcom (カプコン)', 'Breath of Fire III OST', 'CPCA-1004']
          ]
        })
      );
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/e2eSheet01/values:batchUpdate') {
      const body = JSON.parse(bodyText);
      sheetBatchUpdates.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalUpdatedCells: body.data.length }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/e2eDupSheet/values/A1:I500') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ values: dupSheetRows }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/e2eDupSheet/values:batchUpdate') {
      const body = JSON.parse(bodyText);
      dupSheetBatchUpdates.push(body);
      for (const item of body.data || []) {
        const m = String(item.range || '').match(/A(\d+)$/);
        if (m) {
          const rowIdx = Number(m[1]) - 1;
          if (dupSheetRows[rowIdx]) {
            dupSheetRows[rowIdx][0] = String(item.values[0][0]);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalUpdatedCells: (body.data || []).length }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const [appOrigin, githubBaseUrl, googleBaseUrl] = await Promise.all([
    listenServer(staticServer),
    listenServer(mockGithubServer),
    listenServer(mockGoogleServer)
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
    GOOGLE_OAUTH_TOKEN_URL: `${googleBaseUrl}/oauth/token`,
    GOOGLE_SHEETS_API_BASE_URL: googleBaseUrl,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: saBotEmail,
      private_key: saPem,
      token_uri: `${googleBaseUrl}/oauth/token`
    }),
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
    await attachExternalRoutes(ctxA, appOrigin, workerBaseUrl);
    const pageA = await ctxA.newPage();
    const pageAErrors = [];
    const requestFailedA = [];
    pageA.on('pageerror', (err) => pageAErrors.push(err.message));
    pageA.on('requestfailed', (req) => requestFailedA.push(`${req.url()}: ${req.failure()?.errorText}`));

    try {
      await pageA.goto(appUrlWithSync);
      await pageA.waitForSelector('#githubAuthBtn:not(.hidden)');
      await assertNoHorizontalOverflow(pageA, 'Signed-out desktop');
      await pageA.setViewportSize({ width: 375, height: 812 });
      await assertNoHorizontalOverflow(pageA, 'Signed-out mobile');
      await pageA.setViewportSize({ width: 1280, height: 800 });

      await pageA.click('#githubAuthBtn');
      await pageA.waitForSelector('#githubSignOutBtn:not(.hidden)');
      await pageA.waitForSelector('#copyAgentLinkBtn:not(.hidden)');
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
      assert.equal(pageAErrors.length, 0, `Unexpected Device A errors: ${pageAErrors.join('; ')}`);
    } catch (err) {
      console.error('Device A debug:', { url: pageA.url(), errors: pageAErrors, requestFailed: requestFailedA });
      throw err;
    } finally {
      await ctxA.close();
    }

    // Device B: Separate clean context at 375x812 mobile viewport -> signs in -> restores SQLite state
    const ctxB = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await attachExternalRoutes(ctxB, appOrigin, workerBaseUrl);
    const pageB = await ctxB.newPage();
    const pageBErrors = [];
    const requestFailedB = [];
    pageB.on('pageerror', (err) => pageBErrors.push(err.message));
    pageB.on('requestfailed', (req) => requestFailedB.push(`${req.url()}: ${req.failure()?.errorText}`));

    try {
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
      assert.equal(pageBErrors.length, 0, `Unexpected Device B errors: ${pageBErrors.join('; ')}`);
    } catch (err) {
      console.error('Device B debug:', { url: pageB.url(), errors: pageBErrors, requestFailed: requestFailedB });
      throw err;
    } finally {
      await ctxB.close();
    }

    // Device C: Standalone Google Sheet mode + Bot Email Banner + Write-Back + /api/share + Offline CSV Cache + Search/Filters + Crate Flip Swipe + Backup + Duplicate Sheets + Local CSV + Sign-out
    const stateFlags = { sheetOffline: false, dupSheetOffline: false, mbOffline: false, mbTrackFetchCount: 0 };
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    await attachExternalRoutes(ctxC, appOrigin, workerBaseUrl, {
      authCode: 'code_bob',
      stateFlags,
      dupSheetCsv: e2eDupSheetCsv
    });
    const pageC = await ctxC.newPage();
    const pageCErrors = [];
    let latestShareUrl = null;
    pageC.on('pageerror', (err) => pageCErrors.push(err.message));
    pageC.on('response', async (res) => {
      if (res.url().startsWith(`${workerBaseUrl}/api/state`) && res.status() === 200) {
        try {
          const data = await res.json();
          if (data && data.shareUrl) latestShareUrl = data.shareUrl;
        } catch (err) {}
      }
    });

    try {
      await pageC.goto(appUrlWithSync);
      await pageC.waitForSelector('#sheetSyncBotBanner:not(.hidden)');
      const botBannerText = await pageC.textContent('#sheetSyncBotText');
      assert.ok(botBannerText.includes(saBotEmail), `Expected #sheetSyncBotBanner to show ${saBotEmail}`);
      await assertNoHorizontalOverflow(pageC, 'Device C signed-out desktop with Bot Banner');
      await pageC.setViewportSize({ width: 375, height: 812 });
      await assertNoHorizontalOverflow(pageC, 'Device C signed-out mobile 375px with Bot Banner');
      await pageC.setViewportSize({ width: 1280, height: 800 });

      await pageC.click('#githubAuthBtn');
      await pageC.waitForSelector('#copyAgentLinkBtn:not(.hidden)');
      await pageC.waitForFunction(() => {
        const pill = document.getElementById('syncStatusPill');
        return pill && pill.textContent.includes('@bob') && !pill.textContent.includes('Syncing');
      });

      // Paste standalone Google Sheet /edit URL directly (zero JSON) and load it
      await pageC.fill('#catalogUrlInput', 'https://docs.google.com/spreadsheets/d/e2eSheet01/edit?usp=drivesdk');
      await pageC.click('#loadCatalogUrlBtn');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '0 / 3');

      // Switch to 1-Col view to verify Priority + Recommended Shops parsed from CSV render cleanly
      await pageC.click('#viewModeBtn');
      await pageC.waitForFunction(() => document.getElementById('albumGrid')?.textContent.includes('Mandarake Grandchaos'));

      // Check off CPCA-1004 -> waits for Synced -> verifies Service Account Sheet write-back + SQLite stripped sheetSync
      await pageC.click('.check-btn[data-action="toggle-acq"][data-id="sheet-cpca-1004"]');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 3');
      await pageC.waitForFunction(() => document.getElementById('syncStatusPill')?.textContent.includes('Synced'));

      assert.ok(sheetBatchUpdates.length >= 1, 'Expected Worker to batchUpdate Google Sheet Column A');
      assert.deepEqual(sheetBatchUpdates[sheetBatchUpdates.length - 1].data, [{ range: 'A3', values: [['TRUE']] }]);
      const bobRow = db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '2002'");
      assert.equal(bobRow.length, 1);
      assert.equal(JSON.parse(bobRow[0].state_json).sheetSync, undefined);

      // Click Agent Link & fetch /api/share/<token>?format=markdown from external origin without GitHub credentials
      await pageC.click('#copyAgentLinkBtn');
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Copied semi-private Agent status link'));
      assert.ok(latestShareUrl, 'Expected shareUrl from /api/state response');

      const shareMdRes = await fetch(`${latestShareUrl}?format=markdown`, { headers: { Origin: 'https://agent.example' } });
      assert.equal(shareMdRes.status, 200);
      assert.equal(shareMdRes.headers.get('access-control-allow-origin'), '*');
      const shareMd = await shareMdRes.text();
      assert.ok(shareMd.includes('# Disk Crate Live Status (@bob)'));
      assert.ok(shareMd.includes('`sheet-cpca-1004`'));

      // Search, clear, category pills, hunting-only toggle, and empty state reset
      await pageC.fill('#searchInput', 'Sol-fa');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('1 of 3'));
      await pageC.click('#clearSearchBtn');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 3 physical'));
      await pageC.click('[data-action="set-cat"][data-cat="J-Rock / J-Pop"]');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('1 of 3'));
      await pageC.click('[data-action="set-cat"][data-cat="All"]');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 3 physical'));
      await pageC.click('#huntingOnlyBtn');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 2 physical'));
      await pageC.fill('#searchInput', 'zzzz-no-match');
      await pageC.waitForSelector('#emptyState:not(.hidden)');
      await pageC.click('#resetFiltersBtn');
      await pageC.waitForSelector('#emptyState', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 3 physical'));

      // Mobile Crate Flip touch swipe scoping (cover area only, touch-action: pan-y), cleaned Jacket Search URL, & iTunes cover verification
      await pageC.setViewportSize({ width: 375, height: 812 });
      await pageC.click('#openCrateFlipBtn');
      await pageC.waitForSelector('#lightboxModal.open');
      await pageC.waitForFunction(() => document.getElementById('lbCounter')?.textContent === '1 / 4');

      const coverTouchAction = await pageC.evaluate(() => getComputedStyle(document.getElementById('lbCoverFrame')).touchAction);
      assert.equal(coverTouchAction, 'pan-y');

      const item1Href = await pageC.evaluate(() => decodeURIComponent(document.getElementById('lbGoogleSearchLink')?.href || ''));
      assert.ok(item1Href.includes('CPCA-1004 Capcom Breath of Fire III Original Soundtrack 通常盤 CD'));
      assert.equal(item1Href.includes('2-CD Set'), false);

      async function dispatchRealTouchSwipe(selector, dx, dy) {
        await pageC.evaluate(({ sel, deltaX, deltaY }) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error('Missing element for touch swipe: ' + sel);
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          const endX = startX + deltaX;
          const endY = startY + deltaY;
          const tStart = new Touch({
            identifier: 1,
            target: el,
            clientX: startX,
            clientY: startY,
            screenX: startX,
            screenY: startY,
            pageX: startX,
            pageY: startY
          });
          el.dispatchEvent(new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: [tStart],
            targetTouches: [tStart],
            changedTouches: [tStart]
          }));
          const tEnd = new Touch({
            identifier: 1,
            target: el,
            clientX: endX,
            clientY: endY,
            screenX: endX,
            screenY: endY,
            pageX: endX,
            pageY: endY
          });
          el.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: [],
            targetTouches: [],
            changedTouches: [tEnd]
          }));
        }, { sel: selector, deltaX: dx, deltaY: dy });
      }

      // Swiping horizontally outside cover (#lbFiling in .lb-details) must NOT flip Crate Flip
      await dispatchRealTouchSwipe('#lbFiling', -100, 0);
      assert.equal(await pageC.textContent('#lbCounter'), '1 / 4');

      // Vertical scroll gesture inside cover area (#lbArtBox) must NOT flip Crate Flip
      await dispatchRealTouchSwipe('#lbArtBox', -60, 140);
      assert.equal(await pageC.textContent('#lbCounter'), '1 / 4');

      // Horizontal swipe on #lbArtBox bubbles cleanly to #lbCoverFrame -> advances to yama (2 / 4) & resolves mocked iTunes SVG cover
      await dispatchRealTouchSwipe('#lbArtBox', -100, 4);
      await pageC.waitForFunction(() => document.getElementById('lbCounter')?.textContent === '2 / 4');
      await pageC.waitForSelector('#lbArtBox img[src="https://custom.e2e.example/itunes-600x600bb.svg"]');
      const item2Href = await pageC.evaluate(() => decodeURIComponent(document.getElementById('lbGoogleSearchLink')?.href || ''));
      assert.ok(item2Href.includes('SRCL-12539 yama slash 通常盤 CD'));
      assert.equal(item2Href.includes('Gundam'), false);

      // Horizontal swipe right on #lbArtBox returns to 1 / 4
      await dispatchRealTouchSwipe('#lbArtBox', 100, -4);
      await pageC.waitForFunction(() => document.getElementById('lbCounter')?.textContent === '1 / 4');

      // Lazy Track List fetch on 375px mobile viewport + horizontal overflow assertion
      await pageC.click('#lbTracksToggleBtn');
      await pageC.waitForFunction(() => document.getElementById('lbTrackSourceBadge')?.textContent === 'MusicBrainz · CPCA-1004');
      await pageC.waitForFunction(() => {
        const html = document.getElementById('lbTracksList')?.innerHTML || '';
        return html.includes("Ryu's Theme") && html.includes('Disc 2 · CD') && html.includes('Bonus Disk Track');
      });
      const mobileTracksOverflow = await pageC.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(mobileTracksOverflow, false, 'Mobile 375px Crate Flip with expanded tracks must not overflow horizontally');

      // Wrap backwards to digital-only Hanatan (4 / 4) and verify digital Jacket Search string
      await pageC.click('#lbPrevBtn');
      await pageC.waitForFunction(() => document.getElementById('lbCounter')?.textContent === '4 / 4');
      const digHref = await pageC.evaluate(() => decodeURIComponent(document.getElementById('lbGoogleSearchLink')?.href || ''));
      assert.ok(digHref.includes('Hanatan gradation ジャケット'));
      assert.equal(digHref.includes('通常盤 CD'), false);

      await pageC.click('#closeLightboxBtn');
      await pageC.waitForSelector('#lightboxModal', { state: 'hidden' });
      await pageC.setViewportSize({ width: 1280, height: 800 });

      // Backup & Restore modal export + import + SQLite sync
      await pageC.click('#backupBtn');
      await pageC.waitForSelector('#backupModal.open');
      const backupPayload = JSON.parse(await pageC.inputValue('#backupTextarea'));
      assert.equal(backupPayload.checklist['sheet-cpca-1004'], true);
      backupPayload.checklist['sheet-kscl-737'] = true;
      await pageC.fill('#backupTextarea', JSON.stringify(backupPayload));
      await pageC.click('#importBackupBtn');
      await pageC.waitForSelector('#backupModal', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '2 / 3');
      const backupDeadline = Date.now() + 4500;
      let syncedBackupKscl = false;
      while (Date.now() < backupDeadline) {
        const rows = db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '2002'");
        if (rows.length === 1) {
          const parsed = JSON.parse(rows[0].state_json);
          const hasKscl = Object.values(parsed.catalogs || {}).some((c) => c && c.checklist && c.checklist['sheet-kscl-737']);
          if (hasKscl) {
            syncedBackupKscl = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(syncedBackupKscl, true, 'Expected Backup import to sync sheet-kscl-737 to SQLite');

      // Flip Google Sheet + MusicBrainz offline and reload Chromium -> restores offline CSV cache + real IndexedDB tracklist without refetching
      stateFlags.sheetOffline = true;
      stateFlags.mbOffline = true;
      const mbFetchesBeforeReload = stateFlags.mbTrackFetchCount;
      await pageC.reload({ waitUntil: 'domcontentloaded' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '2 / 3');
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Loaded cached Google Sheet (offline)'));

      await pageC.click('#openCrateFlipBtn');
      await pageC.waitForSelector('#lightboxModal.open');
      await pageC.waitForFunction(() => document.getElementById('lbTrackSourceBadge')?.textContent === 'MusicBrainz · CPCA-1004');
      await pageC.waitForFunction(() => (document.getElementById('lbTracksList')?.innerHTML || '').includes("Ryu's Theme"));
      assert.equal(stateFlags.mbTrackFetchCount, mbFetchesBeforeReload, 'Offline reload must restore tracks from IndexedDB without network fetch');

      // Manual paste override -> Custom badge, IndexedDB persistence, & #searchInput track search match chip
      await pageC.click('#lbEditTracksBtn');
      await pageC.waitForSelector('#lbTrackEditorDrawer:not(.hidden)');
      await pageC.fill('#lbTrackEditorInput', '1. Custom E2E Track (3:33)\n2. Hidden B-Side Track (4:44)');
      await pageC.waitForFunction(() => document.getElementById('lbTrackEditorPreview')?.textContent === '2 tracks');
      await pageC.click('#saveManualTracksBtn');
      await pageC.waitForFunction(() => document.getElementById('lbTrackSourceBadge')?.textContent === 'Custom');
      await pageC.click('#closeLightboxBtn');
      await pageC.waitForSelector('#lightboxModal', { state: 'hidden' });

      await pageC.fill('#searchInput', 'Hidden B-Side Track');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 1'));
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('Hidden B-Side Track'));
      await pageC.click('#clearSearchBtn');
      await pageC.waitForFunction(() => document.getElementById('visibleCountText')?.textContent.includes('Showing 3 physical'));

      // Load duplicate Google Sheet e2eDupSheet -> auto-deduplicates 3 rows into 2 physical items & reconciles duplicate rows
      await pageC.click('#openCatalogLoaderBtn');
      await pageC.waitForSelector('#catalogLoaderScreen:not(.hidden)');
      await pageC.fill('#catalogUrlInput', 'https://docs.google.com/spreadsheets/d/e2eDupSheet/edit');
      await pageC.click('#loadCatalogUrlBtn');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 2');
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Merged 1 duplicate row (CPCA-1004)'));

      async function waitForDupBatchUpdateCount(minLen) {
        const dl = Date.now() + 4500;
        while (Date.now() < dl) {
          if (dupSheetBatchUpdates.length >= minLen) return;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error(`Timed out waiting for dupSheetBatchUpdates >= ${minLen} (got ${dupSheetBatchUpdates.length})`);
      }

      await waitForDupBatchUpdateCount(1);
      assert.equal(dupSheetRows[1][0], 'TRUE');
      assert.equal(dupSheetRows[2][0], 'TRUE');

      const beforeUncheck = dupSheetBatchUpdates.length;
      await pageC.click('.check-btn[data-action="toggle-acq"][data-id="sheet-cpca-1004"]');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '0 / 2');
      await waitForDupBatchUpdateCount(beforeUncheck + 1);
      assert.deepEqual(dupSheetBatchUpdates[dupSheetBatchUpdates.length - 1].data, [
        { range: 'A2', values: [['FALSE']] },
        { range: 'A3', values: [['FALSE']] }
      ]);

      const beforeRecheck = dupSheetBatchUpdates.length;
      await pageC.click('.check-btn[data-action="toggle-acq"][data-id="sheet-cpca-1004"]');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 2');
      await waitForDupBatchUpdateCount(beforeRecheck + 1);
      assert.deepEqual(dupSheetBatchUpdates[dupSheetBatchUpdates.length - 1].data, [
        { range: 'A2', values: [['TRUE']] },
        { range: 'A3', values: [['TRUE']] }
      ]);

      const dupShareMd = await (await fetch(`${latestShareUrl}?format=markdown`, { headers: { Origin: 'https://agent.example' } })).text();
      assert.ok(dupShareMd.includes('`sheet-cpca-1004`'));
      assert.equal(dupShareMd.includes('sheet-cpca-1004-2'), false);

      stateFlags.dupSheetOffline = true;
      await pageC.reload({ waitUntil: 'domcontentloaded' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 2');
      await pageC.waitForFunction(() => {
        const msg = document.getElementById('toast')?.textContent || '';
        return msg.includes('Loaded cached Google Sheet (offline)') && msg.includes('Merged 1 duplicate row (CPCA-1004)');
      });

      // ── Phase 2 Collection Mode, MB Lookup, Cross-Ref, Graduation, Custom Cover Keepalive, Merge, Quick Filters & Tombstones ──
      await pageC.click('#modeCollectionBtn');
      await pageC.waitForSelector('#addReleaseBtn:not(.hidden)');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '0 releases · 0 tracks');

      // MusicBrainz release lookup inside #releaseFormModal -> applies candidate catNo & tracks, then cancels cleanly
      stateFlags.mbOffline = false;
      await pageC.click('#addReleaseBtn');
      await pageC.waitForSelector('#releaseFormModal.open');
      await pageC.fill('#releaseLookupInput', 'CPCA-1004');
      await pageC.click('#releaseLookupBtn');
      await pageC.waitForSelector('.lookup-cand-btn[data-lookup-idx="0"]');
      await pageC.click('.lookup-cand-btn[data-lookup-idx="0"]');
      assert.equal(await pageC.inputValue('#rfCatNo'), 'CPCA-1004');
      assert.ok((await pageC.inputValue('#rfTracksInput')).includes("Ryu's Theme"));
      await pageC.click('#cancelReleaseFormBtn');
      await pageC.waitForSelector('#releaseFormModal', { state: 'hidden' });
      stateFlags.mbOffline = true;

      await pageC.click('#addReleaseBtn');
      await pageC.waitForSelector('#releaseFormModal.open');
      await pageC.fill('#rfArtist', 'E2E Artist');
      await pageC.fill('#rfTitle', 'E2E Collection Disc');
      await pageC.fill('#rfCatNo', 'E2E-1001');
      await pageC.fill('#rfCategory', 'Game');
      await pageC.fill('#rfNotes', 'Initial E2E copy');
      await pageC.fill('#rfTracksInput', '1. Custom E2E Track (3:33)\n2. Hidden B-Side Track (4:44)');
      await pageC.click('#saveReleaseFormBtn');
      await pageC.waitForSelector('#releaseFormModal', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 release · 2 tracks');

      const ownedSyncDeadline = Date.now() + 4500;
      let syncedOwnedAdd = false;
      while (Date.now() < ownedSyncDeadline) {
        const rows = db.queryRaw("SELECT release_id, data_json, deleted_at FROM owned_releases WHERE github_id = '2002' AND release_id = 'own-e2e-1001'");
        if (rows.length === 1 && rows[0].deleted_at === null && JSON.parse(rows[0].data_json).catNo === 'E2E-1001') {
          syncedOwnedAdd = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(syncedOwnedAdd, true, 'Expected Collection release E2E-1001 to sync to SQLite owned_releases');

      // Switch to Hunt mode -> verify Tracks Owned overlap badge renders from shared manual tracklist + graduate CPCA-1004
      await pageC.click('#modeHuntBtn');
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('Tracks Owned: 2/2'));
      await pageC.click('#openCrateFlipBtn');
      await pageC.waitForSelector('#lightboxModal.open');
      await pageC.waitForFunction(() => (document.getElementById('lbOwnedCrossRefBox')?.innerHTML || '').includes('E2E-1001'));
      await pageC.click('#lbGraduateBtn');
      await pageC.waitForSelector('#releaseFormModal.open');
      await pageC.click('#saveReleaseFormBtn');
      await pageC.waitForSelector('#releaseFormModal', { state: 'hidden' });
      await pageC.click('#closeLightboxBtn');
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('✓ Owned'));

      // Switch to Collection -> reload page with ?mode=collection (offline IndexedDB restore) & assert zero 375px mobile overflow
      await pageC.click('#modeCollectionBtn');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent.startsWith('2 releases'));
      await pageC.reload({ waitUntil: 'domcontentloaded' });
      await pageC.waitForSelector('#addReleaseBtn:not(.hidden)');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent.startsWith('2 releases'));
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('E2E-1001'));

      await pageC.setViewportSize({ width: 375, height: 812 });
      const colMobileOverflow = await pageC.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(colMobileOverflow, false, 'Mobile 375px Collection mode must not overflow horizontally');
      await pageC.setViewportSize({ width: 1280, height: 800 });

      // Add custom cover in Collection Crate Flip -> flush immediately via visibilitychange keepalive -> verify SQLite + /api/share?include=collection stripping
      await pageC.click('#openCrateFlipBtn');
      await pageC.waitForSelector('#lightboxModal.open');
      await pageC.click('#lbToggleCustomBtn');
      await pageC.fill('#customCoverInput', 'https://custom.e2e.example/owned-cover.svg');
      await pageC.selectOption('#customCoverLabel', { index: 0 });
      await pageC.click('#saveCustomCoverBtn');
      await pageC.click('#closeLightboxBtn');
      await pageC.waitForFunction(() => (document.getElementById('syncStatusPill')?.textContent || '').includes('Pending...'));

      await pageC.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.visibilityState;
      });

      const coverSyncDeadline = Date.now() + 1200;
      let syncedCustomCover = false;
      while (Date.now() < coverSyncDeadline) {
        const rows = db.queryRaw("SELECT data_json FROM owned_releases WHERE github_id = '2002'");
        if (rows.some((r) => (r.data_json || '').includes('owned-cover.svg'))) {
          syncedCustomCover = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(syncedCustomCover, true, 'Expected Collection custom cover keepalive flush within 1200ms');

      const shareWithColJson = await (
        await fetch(`${latestShareUrl}?include=collection`, { headers: { Origin: 'https://agent.example' } })
      ).json();
      assert.equal(shareWithColJson.collection.count, 2);
      assert.equal(shareWithColJson.collection.items.some((it) => it.catNo === 'E2E-1001'), true);
      assert.equal(JSON.stringify(shareWithColJson).includes('owned-cover.svg'), false);

      // Backup Modal: Copy Collection Agent Link + JSON Merge import (adds trackless/noteless E2E-MRG-1 -> 3 releases)
      await pageC.click('#collectionBackupBtn');
      await pageC.waitForSelector('#collectionBackupModal.open');
      await pageC.click('#copyCollectionAgentLinkBtn');
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Copied Agent Collection status link'));
      await pageC.fill(
        '#collectionBackupTextarea',
        JSON.stringify({
          schemaVersion: 1,
          items: [{ id: 'own-e2e-mrg-1', artist: 'Merge Artist', title: 'Merge Album', category: 'Rock', catNo: 'E2E-MRG-1' }]
        })
      );
      await pageC.click('#importCollectionMergeBtn');
      await pageC.waitForSelector('#collectionBackupModal', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent.startsWith('3 releases'));

      // Exercise Collection Quick Filters (#collectionQuickFilters)
      await pageC.click('#collectionQuickFilters [data-filter="missing-tracks"]');
      await pageC.waitForFunction(() => {
        const html = document.getElementById('albumGrid')?.innerHTML || '';
        return html.includes('E2E-MRG-1') && !html.includes('E2E-1001');
      });
      await pageC.click('#collectionQuickFilters [data-filter="has-notes"]');
      await pageC.waitForFunction(() => {
        const html = document.getElementById('albumGrid')?.innerHTML || '';
        return html.includes('E2E-1001') && !html.includes('E2E-MRG-1');
      });
      await pageC.click('#collectionQuickFilters [data-filter="has-tracks"]');
      await pageC.waitForFunction(() => {
        const html = document.getElementById('albumGrid')?.innerHTML || '';
        return html.includes('E2E-1001') && !html.includes('E2E-MRG-1');
      });
      await pageC.click('#collectionQuickFilters [data-filter="all"]');
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('E2E-MRG-1'));

      // Edit first release & soft-delete active release -> verify tombstone synced to SQLite
      await pageC.click('#openCrateFlipBtn');
      await pageC.waitForSelector('#lightboxModal.open');
      await pageC.click('#lbEditReleaseBtn');
      await pageC.waitForSelector('#releaseFormModal.open');
      await pageC.fill('#rfNotes', 'Edited E2E note');
      await pageC.click('#saveReleaseFormBtn');
      await pageC.waitForSelector('#releaseFormModal', { state: 'hidden' });
      assert.ok((await pageC.textContent('#lbCatalogText')).includes('CPCA-1004'));
      await pageC.click('#lbDeleteReleaseBtn');
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent.startsWith('2 releases'));
      await pageC.click('#closeLightboxBtn');

      const delDeadline = Date.now() + 4500;
      let sawTombstone = false;
      while (Date.now() < delDeadline) {
        const rows = db.queryRaw("SELECT deleted_at FROM owned_releases WHERE github_id = '2002' AND deleted_at IS NOT NULL");
        if (rows.length === 1) {
          sawTombstone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(sawTombstone, true, 'Expected Collection soft-delete to persist deleted_at tombstone in SQLite');

      await pageC.click('#modeHuntBtn');
      await pageC.waitForSelector('#openCatalogLoaderBtn:not(.hidden)');

      // Batch Graduate (#batchGraduateBtn) on checked un-owned Hunt items sheet-cpca-1004 (soft-deleted earlier) and sheet-kscl-737
      await pageC.click('.check-btn[data-action="toggle-acq"][data-id="sheet-kscl-737"]');
      await pageC.waitForSelector('#batchGraduateBtn:not(.hidden)');
      assert.equal(await pageC.textContent('#batchGraduateBtn'), 'Move Found to Collection (2)');
      await pageC.click('#batchGraduateBtn');
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 2 releases to Owned Collection'));
      await pageC.waitForSelector('#batchGraduateBtn', { state: 'hidden' });
      await pageC.waitForFunction(() => (document.getElementById('albumGrid')?.innerHTML || '').includes('✓ Owned'));

      // Local .csv upload via real <input type="file"> + Sign-out keeps local progress
      await pageC.click('#openCatalogLoaderBtn');
      await pageC.waitForSelector('#catalogLoaderScreen:not(.hidden)');
      await pageC.setInputFiles('#catalogFileInput', {
        name: 'local-dup.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(e2eDupSheetCsv, 'utf8')
      });
      await pageC.waitForSelector('#catalogLoaderScreen', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('progressBadge')?.textContent === '1 / 2');
      await pageC.waitForFunction(() => {
        const msg = document.getElementById('toast')?.textContent || '';
        return msg.includes('Loaded local CSV: local-dup.csv') && msg.includes('Merged 1 duplicate row (CPCA-1004)');
      });

      await pageC.click('#githubSignOutBtn');
      await pageC.waitForSelector('#githubAuthBtn:not(.hidden)');
      await pageC.waitForSelector('#copyAgentLinkBtn', { state: 'hidden' });
      await pageC.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Signed out of cloud sync'));
      assert.equal(await pageC.textContent('#progressBadge'), '1 / 2');
      assert.equal(pageCErrors.length, 0, `Unexpected Device C errors: ${pageCErrors.join('; ')}`);
    } catch (err) {
      console.error('Device C debug:', { url: pageC.url(), errors: pageCErrors });
      throw err;
    } finally {
      await ctxC.close();
    }

    console.log('✓ Browser E2E checks passed (desktop + 375px mobile Hunt & Collection, OAuth, multi-device SQLite sync, Collection IndexedDB reload + tombstones + graduation + Owned cross-ref badges, search/filters + track search, Crate Flip cover-only swipe, jacket search, Track List MB/IndexedDB persistence/paste override, backup modal, Google Sheet + dedup + write-back, /api/share, offline CSV cache, local CSV upload, sign-out, keepalive flush)');
  } finally {
    await browser.close();
    await Promise.all([
      closeServer(staticServer),
      closeServer(mockGithubServer),
      closeServer(mockGoogleServer),
      closeServer(workerServer)
    ]);
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
