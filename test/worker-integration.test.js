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
      ALLOWED_ORIGIN,
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
    tokenExchangeLog,
    async loginViaHttp(oauthCode) {
      const loginRes = await fetch(`${workerBaseUrl}/auth/login`, { redirect: 'manual' });
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
      assert.ok(appRedirect.startsWith(`${APP_REDIRECT_URL}#auth_token=`));
      return decodeURIComponent(appRedirect.split('#auth_token=')[1]);
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
    const tokenDeviceA = await env.loginViaHttp('code_alice');
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
    const tokenDeviceB = await env.loginViaHttp('code_alice');
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

    const aliceToken = await env.loginViaHttp('code_alice');
    const bobToken = await env.loginViaHttp('code_bob');

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

    const aliceToken = await env.loginViaHttp('code_alice');
    const bobToken = await env.loginViaHttp('code_bob');
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
});
