'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_PATH = path.join(__dirname, '..', 'worker', 'schema.sql');
const ALLOWED_ORIGIN = 'https://dopingus-build.github.io';
const APP_REDIRECT_URL = 'https://dopingus-build.github.io/cd-hunt/';

function createSqliteD1Database() {
  const db = new DatabaseSync(':memory:');
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

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
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

async function startIntegrationServers(envOverrides = {}) {
  const { default: worker } = await import('../worker/index.mjs');
  const db = createSqliteD1Database();
  const githubUsers = {
    code_alice: { id: 1001, login: 'alice', avatar_url: 'https://avatars.example/alice.png', token: 'gho_ephemeral_alice' },
    code_bob: { id: 2002, login: 'bob', avatar_url: 'https://avatars.example/bob.png', token: 'gho_ephemeral_bob' }
  };
  const tokenExchangeLog = [];

  const mockGithubServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && reqUrl.pathname === '/login/oauth/access_token') {
      const payload = JSON.parse(bodyText);
      tokenExchangeLog.push(payload);
      if (payload.client_id !== 'gh-test-client' || payload.client_secret !== 'gh-test-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'incorrect_client_credentials' }));
        return;
      }
      const user = githubUsers[payload.code];
      if (!user) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: user.token, token_type: 'bearer', scope: '' }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/user') {
      const auth = String(req.headers.authorization || '');
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      const matched = Object.values(githubUsers).find((u) => u.token === token);
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

  const githubBaseUrl = await listenServer(mockGithubServer);

  const workerEnv = Object.assign(
    {
      DB: db,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      APP_REDIRECT_URL,
      GITHUB_CLIENT_ID: 'gh-test-client',
      GITHUB_CLIENT_SECRET: 'gh-test-secret',
      JWT_SECRET: 'integration-test-jwt-secret-0123456789abcdef',
      GITHUB_OAUTH_TOKEN_URL: `${githubBaseUrl}/login/oauth/access_token`,
      GITHUB_USER_API_URL: `${githubBaseUrl}/user`,
      DAILY_REQ_LIMIT: '80000',
      DAILY_WRITE_LIMIT: '80000',
      USER_HOURLY_WRITE_LIMIT: '60',
      MAX_PAYLOAD_BYTES: '131072',
      PAUSE_SYNC: 'false'
    },
    envOverrides
  );

  const workerServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, workerBaseUrl);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (Array.isArray(val)) {
          for (const item of val) headers.append(key, item);
        } else if (val !== undefined) {
          headers.set(key, val);
        }
      }

      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = bodyBuf;
      }

      const webReq = new Request(reqUrl.toString(), init);
      const workerRes = await worker.fetch(webReq, workerEnv);

      res.statusCode = workerRes.status;
      for (const [k, v] of workerRes.headers.entries()) {
        res.setHeader(k, v);
      }
      const resBuf = Buffer.from(await workerRes.arrayBuffer());
      res.end(resBuf);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  const workerBaseUrl = await listenServer(workerServer);

  return {
    workerBaseUrl,
    githubBaseUrl,
    db,
    workerEnv,
    tokenExchangeLog,
    async loginViaHttp(oauthCode, redirectParam) {
      const loginPath = redirectParam
        ? `${workerBaseUrl}/auth/login?redirect=${encodeURIComponent(redirectParam)}`
        : `${workerBaseUrl}/auth/login`;
      const loginRes = await fetch(loginPath, { redirect: 'manual' });
      assert.equal(loginRes.status, 302);
      const ghAuthorizeUrl = new URL(loginRes.headers.get('location'));
      assert.equal(ghAuthorizeUrl.searchParams.get('scope'), null);
      const state = ghAuthorizeUrl.searchParams.get('state');

      const callbackRes = await fetch(
        `${workerBaseUrl}/auth/callback?code=${encodeURIComponent(oauthCode)}&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' }
      );
      assert.equal(callbackRes.status, 302);
      const appRedirect = callbackRes.headers.get('location');
      const expectedPrefix = redirectParam ? redirectParam.split('#')[0] : APP_REDIRECT_URL;
      assert.ok(appRedirect.startsWith(`${expectedPrefix}#auth_token=`));
      return {
        token: decodeURIComponent(appRedirect.split('#auth_token=')[1]),
        redirectLocation: appRedirect
      };
    },
    async close() {
      await Promise.all([closeServer(workerServer), closeServer(mockGithubServer)]);
      db.close();
    }
  };
}

function makeSampleSyncPayload(overrides = {}) {
  return Object.assign(
    {
      schemaVersion: 1,
      updatedAt: 1795138200000,
      activeCatalogUrl: 'https://raw.githubusercontent.com/alice/cd-metadata/main/2026-japan.json',
      catalogs: {
        cd_hunt_osaka_cd_cover_a1b2c3d4: {
          updatedAt: 1795138200000,
          checklist: { 'cd-01': true },
          customCovers: {
            'cd-01': {
              variants: [{ url: 'https://custom.example/reg.jpg', label: '通常盤 Regular', source: 'custom', isRegular: true }],
              selectedIndex: 0
            }
          },
          selectedVariants: {},
          viewMode: 'grid',
          noteDismissed: false
        }
      }
    },
    overrides
  );
}

describe('Cloudflare Worker HTTP + SQLite end-to-end integration tests', () => {
  it('completes OAuth login over HTTP and syncs state across two independent sessions using SQLite', async (t) => {
    const env = await startIntegrationServers();
    t.after(() => env.close());

    // Device A logs in via /auth/login -> /auth/callback
    const tokenDeviceA = (await env.loginViaHttp('code_alice')).token;
    assert.equal(env.tokenExchangeLog.length, 1);
    assert.equal(env.tokenExchangeLog[0].redirect_uri, `${env.workerBaseUrl}/auth/callback`);

    // Initial state on Device A is empty
    const initGetRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenDeviceA}` }
    });
    assert.equal(initGetRes.status, 200);
    const initBody = await initGetRes.json();
    assert.equal(initBody.user.login, 'alice');
    assert.equal(initBody.state, null);

    // Device A saves state to SQLite
    const deviceAPayload = makeSampleSyncPayload();
    const putARes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${tokenDeviceA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(deviceAPayload)
    });
    assert.equal(putARes.status, 200);

    // Inspect raw SQLite rows directly to confirm zero GitHub tokens persisted and exact schema columns
    const userRows = env.db.queryRaw('SELECT github_id, github_login, state_json, hour_writes FROM user_state');
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].github_id, '1001');
    assert.equal(userRows[0].github_login, 'alice');
    assert.equal(userRows[0].hour_writes, 1);
    assert.equal(userRows[0].state_json.includes('gho_ephemeral_alice'), false);

    // Device B logs in independently as Alice and reads Device A's saved state
    const tokenDeviceB = (await env.loginViaHttp('code_alice')).token;
    const getBRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenDeviceB}` }
    });
    assert.equal(getBRes.status, 200);
    const getBBody = await getBRes.json();
    assert.deepEqual(getBBody.state, deviceAPayload);

    // Device B checks off cd-02 and switches to 1-Col view, then syncs back to Device A
    const mergedPayload = makeSampleSyncPayload({ updatedAt: 1795138300000 });
    mergedPayload.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.checklist['cd-02'] = true;
    mergedPayload.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.viewMode = 'single';

    const putBRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${tokenDeviceB}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mergedPayload)
    });
    assert.equal(putBRes.status, 200);

    const getARes = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${tokenDeviceA}` }
    });
    const getABody = await getARes.json();
    assert.deepEqual(getABody.state.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.checklist, { 'cd-01': true, 'cd-02': true });
    assert.equal(getABody.state.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.viewMode, 'single');
  });

  it('isolates per-user SQLite rows across different GitHub users while aggregating shared daily usage', async (t) => {
    const env = await startIntegrationServers();
    t.after(() => env.close());

    const aliceToken = (await env.loginViaHttp('code_alice')).token;
    const bobToken = (await env.loginViaHttp('code_bob')).token;

    const alicePayload = makeSampleSyncPayload({ activeCatalogUrl: 'https://example.com/alice.json' });
    const bobPayload = makeSampleSyncPayload({
      activeCatalogUrl: 'https://example.com/bob.json',
      catalogs: {
        cd_hunt_bob_custom_list_1234abcd: {
          checklist: { 'bob-99': true },
          viewMode: 'single',
          noteDismissed: true
        }
      }
    });

    assert.equal(
      (
        await fetch(`${env.workerBaseUrl}/api/state`, {
          method: 'PUT',
          headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` },
          body: JSON.stringify(alicePayload)
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${env.workerBaseUrl}/api/state`, {
          method: 'PUT',
          headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${bobToken}` },
          body: JSON.stringify(bobPayload)
        })
      ).status,
      200
    );

    const aliceGet = await (
      await fetch(`${env.workerBaseUrl}/api/state`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` }
      })
    ).json();
    const bobGet = await (
      await fetch(`${env.workerBaseUrl}/api/state`, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${bobToken}` }
      })
    ).json();

    assert.equal(aliceGet.user.login, 'alice');
    assert.equal(aliceGet.state.activeCatalogUrl, 'https://example.com/alice.json');
    assert.equal(bobGet.user.login, 'bob');
    assert.equal(bobGet.state.activeCatalogUrl, 'https://example.com/bob.json');

    const usageRows = env.db.queryRaw('SELECT req_count, write_count FROM daily_usage');
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0].req_count, 4);
    assert.equal(usageRows[0].write_count, 2);
  });

  it('enforces real SQLite ON CONFLICT rate limits, daily circuit breaker, and HTTP CORS preflight', async (t) => {
    const env = await startIntegrationServers({
      USER_HOURLY_WRITE_LIMIT: '2',
      DAILY_WRITE_LIMIT: '4',
      DAILY_REQ_LIMIT: '5'
    });
    t.after(() => env.close());

    // Real HTTP CORS preflight & rejected origin
    const preflightRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN }
    });
    assert.equal(preflightRes.status, 204);
    assert.equal(preflightRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

    const evilRes = await fetch(`${env.workerBaseUrl}/api/status`, {
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(evilRes.status, 403);

    const aliceToken = (await env.loginViaHttp('code_alice')).token;
    const bobToken = (await env.loginViaHttp('code_bob')).token;
    const body = JSON.stringify(makeSampleSyncPayload());

    // Alice hits per-user hourly write cap (2 ok -> 3rd 429) using real SQLite ON CONFLICT hour_writes increment
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${env.workerBaseUrl}/api/state`, {
        method: 'PUT',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` },
        body
      });
      assert.equal(r.status, 200);
    }
    const aliceRateLimited = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` },
      body
    });
    assert.equal(aliceRateLimited.status, 429);
    assert.ok(Number(aliceRateLimited.headers.get('retry-after')) > 0);

    // Bob still has write quota until global DAILY_WRITE_LIMIT=4 is reached (2 ok -> 3rd pauses with 503)
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${env.workerBaseUrl}/api/state`, {
        method: 'PUT',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${bobToken}` },
        body
      });
      assert.equal(r.status, 200);
    }
    const writePaused = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${bobToken}` },
      body
    });
    assert.equal(writePaused.status, 503);
    assert.equal((await writePaused.json()).paused, true);

    // One more GET reaches DAILY_REQ_LIMIT=5 -> /api/status & subsequent GET report paused: true
    assert.equal(
      (
        await fetch(`${env.workerBaseUrl}/api/state`, {
          headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${bobToken}` }
        })
      ).status,
      200
    );
    const getPaused = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(getPaused.status, 503);
    const statusBody = await (
      await fetch(`${env.workerBaseUrl}/api/status`, { headers: { Origin: ALLOWED_ORIGIN } })
    ).json();
    assert.equal(statusBody.paused, true);
    assert.equal(statusBody.usage.reqCount, 5);
    assert.equal(statusBody.usage.writeCount, 4);
  });

  it('supports comma-separated ALLOWED_ORIGINS for CORS preflight, API calls, and custom OAuth redirect targets', async (t) => {
    const customOrigin = 'https://custom.example';
    const customAppUrl = `${customOrigin}/cd-hunt/`;
    const env = await startIntegrationServers({
      ALLOWED_ORIGINS: `${ALLOWED_ORIGIN}, ${customOrigin}`
    });
    t.after(() => env.close());

    // Preflight from secondary allowed origin reflects that origin
    const preflight = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'OPTIONS',
      headers: { Origin: customOrigin }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), customOrigin);
    assert.equal(preflight.headers.get('vary'), 'Origin');

    // Disallowed ?redirect= origin returns 400 on /auth/login
    const badLogin = await fetch(
      `${env.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://rogue.example/cd-hunt/')}`,
      { redirect: 'manual' }
    );
    assert.equal(badLogin.status, 400);

    // OAuth flow launched from secondary allowed origin redirects back to that custom URL with session JWT
    const loginResult = await env.loginViaHttp('code_alice', customAppUrl);
    assert.ok(loginResult.redirectLocation.startsWith(`${customAppUrl}#auth_token=`));

    const putRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        Origin: customOrigin,
        Authorization: `Bearer ${loginResult.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(makeSampleSyncPayload())
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.headers.get('access-control-allow-origin'), customOrigin);

    const getRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: customOrigin, Authorization: `Bearer ${loginResult.token}` }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('access-control-allow-origin'), customOrigin);
    assert.equal((await getRes.json()).user.login, 'alice');
  });

  it('serves user-isolated /api/share JSON & Markdown over HTTP + SQLite, strips customCovers, and enforces daily req limits', async (t) => {
    const env = await startIntegrationServers({
      DAILY_REQ_LIMIT: '12',
      DAILY_WRITE_LIMIT: '12'
    });
    t.after(() => env.close());

    const aliceToken = (await env.loginViaHttp('code_alice')).token;
    const bobToken = (await env.loginViaHttp('code_bob')).token;

    const putAliceRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        makeSampleSyncPayload({
          catalogs: {
            cd_hunt_osaka_cd_cover_a1b2c3d4: {
              updatedAt: 1795138200000,
              checklist: { 'cd-01': true, 'cd-02': false },
              customCovers: {
                'cd-01': {
                  variants: [{ url: 'https://private.example/custom.jpg', label: 'Custom', source: 'custom', isRegular: true }],
                  selectedIndex: 0
                }
              },
              viewMode: 'single'
            }
          }
        })
      )
    });
    assert.equal(putAliceRes.status, 200);
    const putAlice = await putAliceRes.json();
    assert.ok(putAlice.shareToken && putAlice.shareUrl.startsWith(`${env.workerBaseUrl}/api/share/`));

    const putBobRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${bobToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        makeSampleSyncPayload({
          activeCatalogUrl: 'https://example.com/bob.json',
          catalogs: {
            cd_hunt_bob_list_deadbeef: {
              updatedAt: 1795138300000,
              checklist: { 'bob-99': true },
              viewMode: 'grid'
            }
          }
        })
      )
    });
    assert.equal(putBobRes.status, 200);
    const putBob = await putBobRes.json();
    assert.notEqual(putAlice.shareToken, putBob.shareToken);

    // Public CORS preflight & GET from external AI/LLM origin
    const preflight = await fetch(putAlice.shareUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://agent.example' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const aliceShareJsonRes = await fetch(putAlice.shareUrl, {
      headers: { Origin: 'https://agent.example' }
    });
    assert.equal(aliceShareJsonRes.status, 200);
    assert.equal(aliceShareJsonRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(aliceShareJsonRes.headers.get('cache-control'), 'no-store');
    const aliceShareJson = await aliceShareJsonRes.json();
    assert.deepEqual(aliceShareJson.user, { login: 'alice' });
    assert.deepEqual(aliceShareJson.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.checklist, { 'cd-01': true, 'cd-02': false });
    assert.equal(aliceShareJson.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.customCovers, undefined);

    const bobShareJson = await (await fetch(`${env.workerBaseUrl}/api/share?token=${encodeURIComponent(putBob.shareToken)}`)).json();
    assert.deepEqual(bobShareJson.user, { login: 'bob' });
    assert.deepEqual(bobShareJson.catalogs.cd_hunt_bob_list_deadbeef.checklist, { 'bob-99': true });

    // Both ?format=markdown and Accept: text/markdown return readable Markdown checklist
    const mdRes = await fetch(`${putAlice.shareUrl}?format=markdown`);
    assert.equal(mdRes.status, 200);
    assert.ok(mdRes.headers.get('content-type').includes('text/markdown'));
    const mdText = await mdRes.text();
    assert.ok(mdText.includes('# CD Hunt Live Status (@alice)'));
    assert.ok(mdText.includes('`cd-01`'));
    assert.equal(mdText.includes('cd-02'), false);

    const acceptMdRes = await fetch(putAlice.shareUrl, { headers: { Accept: 'text/markdown' } });
    assert.equal(acceptMdRes.status, 200);
    assert.ok((await acceptMdRes.text()).includes('# CD Hunt Live Status (@alice)'));

    // Guards: POST -> 405, invalid/session tokens -> 401
    assert.equal((await fetch(putAlice.shareUrl, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${env.workerBaseUrl}/api/share/invalid-token`)).status, 401);
    assert.equal((await fetch(`${env.workerBaseUrl}/api/share/${aliceToken}`)).status, 401);

    // Exhaust remaining DAILY_REQ_LIMIT (currently 6: 2 PUT + 4 valid GET share) -> /api/share returns 503
    for (let i = 0; i < 6; i++) {
      const r = await fetch(putAlice.shareUrl);
      assert.equal(r.status, 200);
    }
    const pausedShareRes = await fetch(putAlice.shareUrl);
    assert.equal(pausedShareRes.status, 503);
    assert.equal((await pausedShareRes.json()).paused, true);
  });

  it('authenticates RS256 Service Account assertions and executes single-tab, multi-tab gid, and fault-tolerant Sheets write-back over HTTP + SQLite', async (t) => {
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
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

    let forceSheetsForbidden = false;
    const batchWrites = [];
    const assertions = [];

    const mockGoogleServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyText = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        const params = new URLSearchParams(bodyText);
        const assertion = params.get('assertion');
        const [h, p, s] = String(assertion || '').split('.');
        const validSig = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          keyPair.publicKey,
          Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
          new TextEncoder().encode(`${h}.${p}`)
        );
        if (!validSig) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        assertions.push(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.int-token', expires_in: 3600 }));
        return;
      }

      if (forceSheetsForbidden) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 403, message: 'Caller does not have permission' } }));
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/sheetInt01/values/A1:I500') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            values: [
              ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number'],
              ['FALSE', 'Game', 'Capcom', 'Breath of Fire III OST', 'CPCA-1004']
            ]
          })
        );
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/sheetInt02' && reqUrl.searchParams.get('fields') === 'sheets.properties(sheetId,title)') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sheets: [
              { properties: { sheetId: 0, title: 'Sheet1' } },
              { properties: { sheetId: 42, title: 'Osaka 2026' } }
            ]
          })
        );
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/sheetInt02/values/' + encodeURIComponent("'Osaka 2026'!A1:I500")) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            values: [
              ['Title Row'],
              ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number'],
              ['FALSE', 'J-Rock', 'AKFG', 'Sol-fa', 'KSCL-737']
            ]
          })
        );
        return;
      }

      if (req.method === 'POST' && /^\/v4\/spreadsheets\/sheetInt0[12]\/values:batchUpdate$/.test(reqUrl.pathname)) {
        const writeBody = JSON.parse(bodyText);
        batchWrites.push({ path: reqUrl.pathname, body: writeBody });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalUpdatedCells: writeBody.data.length }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    const googleUrl = await listenServer(mockGoogleServer);
    t.after(() => closeServer(mockGoogleServer));

    const botEmail = 'cd-hunt-int@demo-project.iam.gserviceaccount.com';
    const env = await startIntegrationServers({
      GOOGLE_OAUTH_TOKEN_URL: `${googleUrl}/oauth/token`,
      GOOGLE_SHEETS_API_BASE_URL: googleUrl,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: botEmail,
        private_key: pem,
        token_uri: `${googleUrl}/oauth/token`
      })
    });
    t.after(() => env.close());

    const statusJson = await (await fetch(`${env.workerBaseUrl}/api/status`, { headers: { Origin: ALLOWED_ORIGIN } })).json();
    assert.deepEqual(statusJson.sheetSync, { configured: true, serviceAccountEmail: botEmail });

    const aliceToken = (await env.loginViaHttp('code_alice')).token;

    // 1) Default tab write-back
    const put1 = await (
      await fetch(`${env.workerBaseUrl}/api/state`, {
        method: 'PUT',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeSampleSyncPayload({
            sheetSync: {
              googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheetInt01/edit',
              checklistByCatNo: { 'CPCA-1004': true }
            }
          })
        )
      })
    ).json();
    assert.deepEqual(put1.sheetSync, { ok: true, updatedRows: 1 });
    assert.equal(assertions[0].iss, botEmail);
    assert.deepEqual(batchWrites[0].body.data, [{ range: 'A2', values: [['TRUE']] }]);

    // 2) Multi-tab #gid=42 write-back + verify SQLite state_json stripped transient sheetSync
    const put2 = await (
      await fetch(`${env.workerBaseUrl}/api/state`, {
        method: 'PUT',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeSampleSyncPayload({
            sheetSync: {
              googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheetInt02/edit#gid=42',
              checklistByCatNo: { 'KSCL-737': true }
            }
          })
        )
      })
    ).json();
    assert.deepEqual(put2.sheetSync, { ok: true, updatedRows: 1 });
    assert.deepEqual(batchWrites[1].body.data, [{ range: "'Osaka 2026'!A3", values: [['TRUE']] }]);
    const savedRow = env.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(JSON.parse(savedRow[0].state_json).sheetSync, undefined);

    // 3) Sheet API 403 error does NOT block D1 state save (PUT returns 200 with sheetSync.ok === false)
    forceSheetsForbidden = true;
    const put3Res = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makeSampleSyncPayload({
          updatedAt: 1795138209999,
          sheetSync: {
            googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheetInt01/edit',
            checklistByCatNo: { 'CPCA-1004': false }
          }
        })
      )
    });
    assert.equal(put3Res.status, 200);
    const put3 = await put3Res.json();
    assert.equal(put3.ok, true);
    assert.equal(put3.sheetSync.ok, false);
    assert.ok(put3.sheetSync.error.includes('403'));
  });

  it('enforces PAUSE_SYNC kill-switch across /api/status, /api/state, and /api/share, and reports sheetSync.configured=false when unset', async (t) => {
    const env = await startIntegrationServers();
    t.after(() => env.close());

    const statusInitial = await (
      await fetch(`${env.workerBaseUrl}/api/status`, { headers: { Origin: ALLOWED_ORIGIN } })
    ).json();
    assert.equal(statusInitial.ok, true);
    assert.equal(statusInitial.paused, false);
    assert.deepEqual(statusInitial.sheetSync, { configured: false, serviceAccountEmail: null });

    const aliceToken = (await env.loginViaHttp('code_alice')).token;
    const initialPayload = makeSampleSyncPayload({
      catalogs: {
        cd_hunt_osaka_cd_cover_a1b2c3d4: {
          updatedAt: 1795138200000,
          checklist: { 'cd-01': true },
          viewMode: 'grid'
        }
      }
    });
    const seedRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(initialPayload)
    });
    assert.equal(seedRes.status, 200);
    const seedJson = await seedRes.json();
    assert.ok(seedJson.shareUrl);

    env.workerEnv.PAUSE_SYNC = 'true';

    const statusPaused = await (
      await fetch(`${env.workerBaseUrl}/api/status`, { headers: { Origin: ALLOWED_ORIGIN } })
    ).json();
    assert.equal(statusPaused.ok, true);
    assert.equal(statusPaused.paused, true);
    assert.equal(statusPaused.reason, 'manual_pause_enabled');

    const getPausedRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}` }
    });
    assert.equal(getPausedRes.status, 503);
    assert.equal((await getPausedRes.json()).paused, true);

    const putPausedRes = await fetch(`${env.workerBaseUrl}/api/state`, {
      method: 'PUT',
      headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makeSampleSyncPayload({
          updatedAt: 1795138299999,
          catalogs: {
            cd_hunt_osaka_cd_cover_a1b2c3d4: {
              updatedAt: 1795138299999,
              checklist: { 'cd-01': false, 'cd-99': true },
              viewMode: 'single'
            }
          }
        })
      )
    });
    assert.equal(putPausedRes.status, 503);
    assert.equal((await putPausedRes.json()).paused, true);

    const storedRows = env.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(storedRows.length, 1);
    const storedChecklist = JSON.parse(storedRows[0].state_json).catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.checklist;
    assert.deepEqual(storedChecklist, { 'cd-01': true });

    const sharePausedRes = await fetch(seedJson.shareUrl, { headers: { Origin: 'https://agent.example' } });
    assert.equal(sharePausedRes.status, 503);
    assert.equal(sharePausedRes.headers.get('access-control-allow-origin'), '*');
    assert.equal((await sharePausedRes.json()).paused, true);
  });
});
