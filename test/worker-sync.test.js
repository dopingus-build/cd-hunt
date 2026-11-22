'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  fetch: workerFetch,
  signToken,
  verifyToken,
  validateSyncPayload,
  getAllowedOrigins,
  getUtcDateString,
  getNextUtcMidnightIso,
  getHourWindow
} = require('../worker/index.js');

const DEFAULT_ORIGIN = 'https://dopingus-build.github.io';
const DEFAULT_REDIRECT = 'https://dopingus-build.github.io/cd-hunt/';
const TEST_JWT_SECRET = 'test-hmac-secret-at-least-32-bytes-long-012345';

function createMockD1() {
  const dailyUsage = new Map();
  const userState = new Map();

  function cloneRow(row) {
    return row ? Object.assign({}, row) : null;
  }

  return {
    dailyUsage,
    userState,
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...params) {
          return {
            async first() {
              if (normalized.startsWith('SELECT utc_date, req_count, write_count FROM daily_usage WHERE utc_date = ?')) {
                return cloneRow(dailyUsage.get(params[0]));
              }
              if (normalized.startsWith('SELECT github_id, github_login, state_json, updated_at, hour_window, hour_writes FROM user_state WHERE github_id = ?')) {
                return cloneRow(userState.get(params[0]));
              }
              if (normalized.startsWith('SELECT github_login, state_json, updated_at FROM user_state WHERE github_id = ?')) {
                return cloneRow(userState.get(params[0]));
              }
              if (normalized.startsWith('SELECT updated_at, hour_window, hour_writes FROM user_state WHERE github_id = ?')) {
                const row = userState.get(params[0]);
                return row
                  ? { updated_at: row.updated_at, hour_window: row.hour_window, hour_writes: row.hour_writes }
                  : null;
              }
              throw new Error('Unhandled mock D1 first() query: ' + normalized);
            },
            async run() {
              if (normalized.startsWith('INSERT INTO daily_usage')) {
                const [utcDate, writeDelta] = params;
                const existing = dailyUsage.get(utcDate);
                if (existing) {
                  existing.req_count += 1;
                  existing.write_count += Number(writeDelta) || 0;
                } else {
                  dailyUsage.set(utcDate, {
                    utc_date: utcDate,
                    req_count: 1,
                    write_count: Number(writeDelta) || 0
                  });
                }
                return { success: true };
              }
              if (normalized.startsWith('INSERT INTO user_state')) {
                const [githubId, githubLogin, stateJson, updatedAt, hourWindow] = params;
                const existing = userState.get(githubId);
                if (existing) {
                  const nextWrites = existing.hour_window === hourWindow ? existing.hour_writes + 1 : 1;
                  existing.github_login = githubLogin;
                  existing.state_json = stateJson;
                  existing.updated_at = updatedAt;
                  existing.hour_window = hourWindow;
                  existing.hour_writes = nextWrites;
                } else {
                  userState.set(githubId, {
                    github_id: githubId,
                    github_login: githubLogin,
                    state_json: stateJson,
                    updated_at: updatedAt,
                    hour_window: hourWindow,
                    hour_writes: 1
                  });
                }
                return { success: true };
              }
              throw new Error('Unhandled mock D1 run() query: ' + normalized);
            }
          };
        }
      };
    }
  };
}

function makeEnv(overrides = {}) {
  return Object.assign(
    {
      DB: createMockD1(),
      ALLOWED_ORIGINS: DEFAULT_ORIGIN,
      APP_REDIRECT_URL: DEFAULT_REDIRECT,
      GITHUB_CLIENT_ID: 'gh-client-id-123',
      GITHUB_CLIENT_SECRET: 'gh-client-secret-456',
      JWT_SECRET: TEST_JWT_SECRET,
      DAILY_REQ_LIMIT: '80000',
      DAILY_WRITE_LIMIT: '80000',
      USER_HOURLY_WRITE_LIMIT: '60',
      MAX_PAYLOAD_BYTES: '131072',
      PAUSE_SYNC: 'false'
    },
    overrides
  );
}

function makeValidPayload(overrides = {}) {
  return Object.assign(
    {
      schemaVersion: 1,
      updatedAt: 1795138200000,
      activeCatalogUrl: 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json',
      catalogs: {
        cd_hunt_osaka_cd_cover_a1b2c3d4: {
          updatedAt: 1795138200000,
          checklist: { 'cd-01': true },
          customCovers: {
            'cd-01': {
              variants: [{ url: 'https://custom.example/cover.jpg', label: '通常盤 Regular', source: 'custom', isRegular: true }],
              selectedIndex: 0
            }
          },
          selectedVariants: {
            'cd-02': { url: 'https://coverartarchive.org/release/abc/front-500', selectedIndex: 0 }
          },
          viewMode: 'grid',
          noteDismissed: false
        }
      }
    },
    overrides
  );
}

describe('Worker files, Wrangler ESM wrapper, and SQL schema', () => {
  it('ships valid worker/index.mjs, worker/schema.sql, and .gitignore entries', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'worker', 'schema.sql'), 'utf8');
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS user_state'));
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS daily_usage'));

    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.dev.vars'));
    assert.ok(gitignore.includes('.wrangler/'));

    const mod = await import('../worker/index.mjs');
    assert.equal(typeof mod.default.fetch, 'function');
  });
});

describe('Date, hour window, and HMAC-SHA256 JWT helpers', () => {
  it('computes UTC date string, next UTC midnight ISO, and hour window deterministically', () => {
    const ts = Date.UTC(2026, 10, 20, 23, 59, 30);
    assert.equal(getUtcDateString(ts), '2026-11-20');
    assert.equal(getNextUtcMidnightIso(ts), '2026-11-21T00:00:00Z');
    assert.equal(getHourWindow(ts), Math.floor(ts / 3600000));
  });

  it('signs and verifies HMAC-SHA256 tokens and rejects tampered or expired tokens', async () => {
    const baseMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    await assert.rejects(() => signToken({ sub: '1' }, ''), /JWT secret/);

    const token = await signToken({ purpose: 'session', sub: '42', login: 'topaz-lidiera' }, TEST_JWT_SECRET, 60, baseMs);
    const verified = await verifyToken(token, TEST_JWT_SECRET, baseMs + 30 * 1000);
    assert.equal(verified.sub, '42');
    assert.equal(verified.login, 'topaz-lidiera');
    assert.equal(verified.purpose, 'session');

    // Expired
    assert.equal(await verifyToken(token, TEST_JWT_SECRET, baseMs + 60 * 1000), null);

    // Tampered payload
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ purpose: 'session', sub: '999', exp: verified.exp + 100 })).toString('base64url');
    assert.equal(await verifyToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, TEST_JWT_SECRET, baseMs), null);

    // Wrong algorithm header / malformed tokens
    const algNoneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal(await verifyToken(`${algNoneHeader}.${parts[1]}.${parts[2]}`, TEST_JWT_SECRET, baseMs), null);
    assert.equal(await verifyToken('not-three-parts', TEST_JWT_SECRET, baseMs), null);
    assert.equal(await verifyToken('bad!header.payload.sig', TEST_JWT_SECRET, baseMs), null);
    assert.equal(await verifyToken(null, TEST_JWT_SECRET, baseMs), null);
    assert.equal(await verifyToken(token, '', baseMs), null);
  });
});

describe('Sync payload validation (validateSyncPayload)', () => {
  it('accepts valid payloads and rejects malformed top-level or catalog fields', () => {
    assert.deepEqual(validateSyncPayload(makeValidPayload()), { valid: true });
    assert.equal(validateSyncPayload(null).valid, false);
    assert.equal(validateSyncPayload([]).valid, false);
    assert.equal(validateSyncPayload(makeValidPayload({ schemaVersion: 2 })).valid, false);
    assert.equal(validateSyncPayload(makeValidPayload({ updatedAt: -1 })).valid, false);
    assert.equal(validateSyncPayload(makeValidPayload({ activeCatalogUrl: 123 })).valid, false);
    assert.equal(validateSyncPayload(makeValidPayload({ activeCatalogUrl: 'a'.repeat(2049) })).valid, false);
    assert.equal(validateSyncPayload(makeValidPayload({ catalogs: null })).valid, false);

    assert.equal(validateSyncPayload(makeValidPayload({ catalogs: { bad_prefix: {} } })).valid, false);
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: null } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { updatedAt: -5 } } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { checklist: 'bad' } } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { customCovers: 'bad' } } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(
        makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { customCovers: { 'cd-01': {} } } } })
      ).valid,
      false
    );
    assert.equal(
      validateSyncPayload(
        makeValidPayload({
          catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { customCovers: { 'cd-01': { variants: [{ url: '  ' }] } } } }
        })
      ).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { selectedVariants: 'bad' } } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { viewMode: 'list' } } })).valid,
      false
    );
    assert.equal(
      validateSyncPayload(makeValidPayload({ catalogs: { cd_hunt_osaka_cd_cover_a1b2c3d4: { noteDismissed: 'yes' } } })).valid,
      false
    );
  });
});

describe('CORS origin checks and preflight handling', () => {
  it('parses comma-separated ALLOWED_ORIGINS with legacy ALLOWED_ORIGIN and default fallbacks', () => {
    assert.deepEqual(getAllowedOrigins({}), [DEFAULT_ORIGIN]);
    assert.deepEqual(getAllowedOrigins({ ALLOWED_ORIGINS: '  ,  ' }), [DEFAULT_ORIGIN]);
    assert.deepEqual(getAllowedOrigins({ ALLOWED_ORIGIN: 'https://legacy.example/' }), ['https://legacy.example']);
    assert.deepEqual(
      getAllowedOrigins({ ALLOWED_ORIGINS: ' https://dopingus-build.github.io/ , https://cd.example:8443 ' }),
      ['https://dopingus-build.github.io', 'https://cd.example:8443']
    );
  });

  it('handles OPTIONS preflight, comma-separated origins/localhost flag, and blocks foreign origins with 403', async () => {
    const env = makeEnv({
      ALLOWED_ORIGINS: `${DEFAULT_ORIGIN}, https://mirror.example/`,
      ALLOW_LOCALHOST: 'false'
    });

    const preflightOk = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'OPTIONS',
        headers: { Origin: DEFAULT_ORIGIN }
      }),
      env
    );
    assert.equal(preflightOk.status, 204);
    assert.equal(preflightOk.headers.get('Access-Control-Allow-Origin'), DEFAULT_ORIGIN);
    assert.equal(preflightOk.headers.get('Vary'), 'Origin');

    const secondOriginStatus = await workerFetch(
      new Request('https://sync.example/api/status', {
        headers: { Origin: 'https://mirror.example' }
      }),
      env
    );
    assert.equal(secondOriginStatus.status, 200);
    assert.equal(secondOriginStatus.headers.get('Access-Control-Allow-Origin'), 'https://mirror.example');
    assert.equal(secondOriginStatus.headers.get('Vary'), 'Origin');

    const preflightEvil = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' }
      }),
      env
    );
    assert.equal(preflightEvil.status, 403);

    const apiEvil = await workerFetch(
      new Request('https://sync.example/api/status', {
        headers: { Origin: 'https://evil.example' }
      }),
      env
    );
    assert.equal(apiEvil.status, 403);

    const localBlocked = await workerFetch(
      new Request('https://sync.example/api/status', {
        headers: { Origin: 'http://localhost:8080' }
      }),
      env
    );
    assert.equal(localBlocked.status, 403);

    const localAllowed = await workerFetch(
      new Request('https://sync.example/api/status', {
        headers: { Origin: 'http://localhost:8080' }
      }),
      makeEnv({ ALLOW_LOCALHOST: 'true' })
    );
    assert.equal(localAllowed.status, 200);
    assert.equal(localAllowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  });
});

describe('Zero-Scope GitHub OAuth flow (/auth/login & /auth/callback)', () => {
  it('redirects /auth/login to GitHub without any scope parameter and validates redirect & config', async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: `${DEFAULT_ORIGIN}, https://mirror.example` });
    const res = await workerFetch(new Request('https://sync.example/auth/login'), env);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('Location'));
    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'gh-client-id-123');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://sync.example/auth/callback');
    assert.equal(location.searchParams.get('scope'), null);

    const stateClaims = await verifyToken(location.searchParams.get('state'), TEST_JWT_SECRET);
    assert.equal(stateClaims.purpose, 'oauth_state');
    assert.equal(stateClaims.redirectUrl, undefined);

    // Valid custom redirect from ALLOWED_ORIGINS embeds sanitized URL (without hash) in state
    const customLogin = await workerFetch(
      new Request('https://sync.example/auth/login?redirect=' + encodeURIComponent('https://mirror.example/cd-hunt/?catalog=foo#old')),
      env
    );
    assert.equal(customLogin.status, 302);
    const customState = new URL(customLogin.headers.get('Location')).searchParams.get('state');
    const customClaims = await verifyToken(customState, TEST_JWT_SECRET);
    assert.equal(customClaims.redirectUrl, 'https://mirror.example/cd-hunt/?catalog=foo');

    // Disallowed, non-http(s), or invalid ?redirect= values return 400
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/login?redirect=https://evil.example/'), env)).status,
      400
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/login?redirect=javascript:alert(1)'), env)).status,
      400
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/login?redirect=not-a-valid-url'), env)).status,
      400
    );

    const badConfig = await workerFetch(new Request('https://sync.example/auth/login'), makeEnv({ GITHUB_CLIENT_ID: '' }));
    assert.equal(badConfig.status, 500);

    const badMethod = await workerFetch(new Request('https://sync.example/auth/login', { method: 'POST' }), env);
    assert.equal(badMethod.status, 405);
  });

  it('exchanges OAuth code, fetches GitHub identity, discards GitHub token, and returns usable session JWT', async (t) => {
    const env = makeEnv();
    const loginRes = await workerFetch(new Request('https://sync.example/auth/login'), env);
    const state = new URL(loginRes.headers.get('Location')).searchParams.get('state');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        return {
          ok: true,
          async json() {
            return { access_token: 'gho_secret_ephemeral_token' };
          }
        };
      }
      if (String(url) === 'https://api.github.com/user') {
        return {
          ok: true,
          async json() {
            return { id: 98765, login: 'octofan', avatar_url: 'https://avatars.example/u/98765' };
          }
        };
      }
      throw new Error('Unexpected fetch URL: ' + url);
    };
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    const cbRes = await workerFetch(
      new Request(`https://sync.example/auth/callback?code=oauth_code_1&state=${encodeURIComponent(state)}`),
      env
    );
    assert.equal(cbRes.status, 302);
    const redirectLocation = cbRes.headers.get('Location');
    assert.ok(redirectLocation.startsWith(DEFAULT_REDIRECT + '#auth_token='));
    const sessionJwt = decodeURIComponent(redirectLocation.split('#auth_token=')[1]);

    const claims = await verifyToken(sessionJwt, TEST_JWT_SECRET);
    assert.equal(claims.purpose, 'session');
    assert.equal(claims.sub, '98765');
    assert.equal(claims.login, 'octofan');

    // GitHub access token must never be stored in D1
    assert.equal(JSON.stringify(Array.from(env.DB.userState.entries())).includes('gho_secret_ephemeral_token'), false);

    // Minted JWT immediately authenticates GET /api/state
    const stateRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt }
      }),
      env
    );
    assert.equal(stateRes.status, 200);
    const stateBody = await stateRes.json();
    assert.equal(stateBody.user.login, 'octofan');
    assert.equal(stateBody.state, null);
  });

  it('rejects invalid OAuth callback parameters, state mismatches, missing config, and GitHub failures', async (t) => {
    const env = makeEnv();
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/callback'), makeEnv({ GITHUB_CLIENT_SECRET: '' }))).status,
      500
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/callback', { method: 'POST' }), env)).status,
      405
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/callback?error=access_denied'), env)).status,
      400
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/auth/callback?code=abc&state=tampered'), env)).status,
      400
    );

    const wrongPurposeState = await signToken({ purpose: 'session', sub: '1', login: 'a' }, TEST_JWT_SECRET, 60);
    assert.equal(
      (await workerFetch(new Request(`https://sync.example/auth/callback?code=abc&state=${wrongPurposeState}`), env)).status,
      400
    );

    const validState = await signToken({ purpose: 'oauth_state', nonce: 'n' }, TEST_JWT_SECRET, 60);
    const origFetch = globalThis.fetch;
    let mode = 'token_http_500';
    globalThis.fetch = async (url) => {
      if (String(url).includes('/login/oauth/access_token')) {
        if (mode === 'token_http_500') return { ok: false, status: 500 };
        if (mode === 'missing_token') return { ok: true, async json() { return {}; } };
        return { ok: true, async json() { return { access_token: 'gho_ok' }; } };
      }
      if (String(url).includes('/user')) {
        if (mode === 'user_http_500') return { ok: false, status: 500 };
        if (mode === 'user_incomplete') return { ok: true, async json() { return { id: 1 }; } };
      }
      throw new Error('unexpected');
    };
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    for (const nextMode of ['token_http_500', 'missing_token', 'user_http_500', 'user_incomplete']) {
      mode = nextMode;
      const res = await workerFetch(
        new Request(`https://sync.example/auth/callback?code=c1&state=${encodeURIComponent(validState)}`),
        env
      );
      assert.equal(res.status, 502, `Expected 502 for ${nextMode}`);
    }
  });
});

describe('State API (/api/state GET/PUT), validation, and size guards', () => {
  it('enforces authentication, method routing, D1 binding, corrupted JSON recovery, 413 payload limit, and 400 validation', async () => {
    const env = makeEnv({ MAX_PAYLOAD_BYTES: '500' });
    const sessionJwt = await signToken({ purpose: 'session', sub: '101', login: 'alice' }, TEST_JWT_SECRET, 3600);
    const oauthStateJwt = await signToken({ purpose: 'oauth_state', nonce: 'xyz' }, TEST_JWT_SECRET, 600);

    // 404 & 405
    assert.equal((await workerFetch(new Request('https://sync.example/unknown'), env)).status, 404);
    assert.equal(
      (await workerFetch(new Request('https://sync.example/api/state', { method: 'DELETE', headers: { Origin: DEFAULT_ORIGIN } }), env)).status,
      405
    );
    assert.equal(
      (await workerFetch(new Request('https://sync.example/api/status', { method: 'POST', headers: { Origin: DEFAULT_ORIGIN } }), env)).status,
      405
    );

    // 401 checks
    assert.equal(
      (await workerFetch(new Request('https://sync.example/api/state', { headers: { Origin: DEFAULT_ORIGIN } }), env)).status,
      401
    );
    assert.equal(
      (
        await workerFetch(
          new Request('https://sync.example/api/state', {
            method: 'PUT',
            headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + oauthStateJwt },
            body: '{}'
          }),
          env
        )
      ).status,
      401
    );

    // Missing D1 binding -> 500
    assert.equal(
      (
        await workerFetch(
          new Request('https://sync.example/api/state', {
            headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt }
          }),
          makeEnv({ DB: null })
        )
      ).status,
      500
    );
    assert.equal(
      (
        await workerFetch(
          new Request('https://sync.example/api/state', {
            method: 'PUT',
            headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt },
            body: '{}'
          }),
          makeEnv({ DB: null })
        )
      ).status,
      500
    );

    // 413 oversized payload
    const hugeRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt },
        body: JSON.stringify(makeValidPayload({ activeCatalogUrl: 'https://example.com/' + 'x'.repeat(600) }))
      }),
      env
    );
    assert.equal(hugeRes.status, 413);

    // 400 malformed JSON & invalid schema
    const badJsonRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt },
        body: '{invalid'
      }),
      env
    );
    assert.equal(badJsonRes.status, 400);

    const badSchemaRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt },
        body: JSON.stringify({ schemaVersion: 99, catalogs: {} })
      }),
      env
    );
    assert.equal(badSchemaRes.status, 400);

    // Valid PUT -> GET round-trip (raise max bytes first so sample fits cleanly)
    const normalEnv = makeEnv();
    const putOk = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt },
        body: JSON.stringify(makeValidPayload())
      }),
      normalEnv
    );
    assert.equal(putOk.status, 200);
    const putData = await putOk.json();
    assert.equal(putData.ok, true);
    assert.equal(putData.paused, false);

    const getOk = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt }
      }),
      normalEnv
    );
    assert.equal(getOk.status, 200);
    const getData = await getOk.json();
    assert.deepEqual(getData.state.catalogs.cd_hunt_osaka_cd_cover_a1b2c3d4.checklist, { 'cd-01': true });

    // Corrupted JSON stored in DB falls back cleanly to state: null
    normalEnv.DB.userState.get('101').state_json = '{corrupt';
    const getCorrupt = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt }
      }),
      normalEnv
    );
    assert.equal(getCorrupt.status, 200);
    assert.equal((await getCorrupt.json()).state, null);
  });
});

describe('Per-user hourly rate limiting & daily free-tier self-pausing circuit breaker', () => {
  it('enforces USER_HOURLY_WRITE_LIMIT (429) and resets automatically in the next UTC hour', async (t) => {
    const startMs = Date.UTC(2026, 10, 20, 10, 15, 0);
    t.mock.timers.enable({ apis: ['Date'], now: startMs });

    const env = makeEnv({ USER_HOURLY_WRITE_LIMIT: '2' });
    const jwt = await signToken({ purpose: 'session', sub: '555', login: 'alice' }, TEST_JWT_SECRET, 86400);
    const payloadStr = JSON.stringify(makeValidPayload());

    for (let i = 0; i < 2; i++) {
      const okRes = await workerFetch(
        new Request('https://sync.example/api/state', {
          method: 'PUT',
          headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
          body: payloadStr
        }),
        env
      );
      assert.equal(okRes.status, 200);
    }

    // 3rd write in same hour -> 429 without consuming another daily write
    const blockedRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
        body: payloadStr
      }),
      env
    );
    assert.equal(blockedRes.status, 429);
    const blockedBody = await blockedRes.json();
    assert.equal(blockedBody.error, 'rate_limit_exceeded');
    assert.ok(blockedBody.retryAfterSeconds > 0);
    assert.equal(env.DB.dailyUsage.get('2026-11-20').write_count, 2);

    // Advance into next hour -> succeeds and resets hour_writes to 1
    t.mock.timers.tick(46 * 60 * 1000);
    const nextHourRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
        body: payloadStr
      }),
      env
    );
    assert.equal(nextHourRes.status, 200);
    assert.equal(env.DB.userState.get('555').hour_writes, 1);
  });

  it('self-pauses on daily write/req limits until UTC midnight reset and obeys PAUSE_SYNC switch', async (t) => {
    const day1Ms = Date.UTC(2026, 10, 20, 23, 50, 0);
    t.mock.timers.enable({ apis: ['Date'], now: day1Ms });

    const env = makeEnv({ DAILY_WRITE_LIMIT: '2', DAILY_REQ_LIMIT: '4' });
    const jwt = await signToken({ purpose: 'session', sub: '777', login: 'bob' }, TEST_JWT_SECRET, 7 * 86400);
    const payloadStr = JSON.stringify(makeValidPayload());

    // 2 writes hit DAILY_WRITE_LIMIT (req_count=2, write_count=2)
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (
          await workerFetch(
            new Request('https://sync.example/api/state', {
              method: 'PUT',
              headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
              body: payloadStr
            }),
            env
          )
        ).status,
        200
      );
    }

    // 3rd write -> paused (503) because write_count >= 2
    const writePaused = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
        body: payloadStr
      }),
      env
    );
    assert.equal(writePaused.status, 503);
    assert.deepEqual(await writePaused.json(), {
      ok: false,
      paused: true,
      reason: 'daily_free_tier_limit_reached',
      resetsAt: '2026-11-21T00:00:00Z'
    });

    // Reads continue until DAILY_REQ_LIMIT (req_count goes 2 -> 3 -> 4)
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (
          await workerFetch(
            new Request('https://sync.example/api/state', {
              headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt }
            }),
            env
          )
        ).status,
        200
      );
    }

    // Now req_count === 4 === DAILY_REQ_LIMIT -> GET pauses & /api/status reports paused
    const getPaused = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt }
      }),
      env
    );
    assert.equal(getPaused.status, 503);
    assert.equal((await getPaused.json()).paused, true);

    const statusPaused = await workerFetch(
      new Request('https://sync.example/api/status', { headers: { Origin: DEFAULT_ORIGIN } }),
      env
    );
    assert.equal(statusPaused.status, 200);
    const statusJson = await statusPaused.json();
    assert.equal(statusJson.paused, true);
    assert.equal(statusJson.reason, 'daily_free_tier_limit_reached');

    // Cross UTC midnight -> new date row resets counters & unpauses automatically
    t.mock.timers.tick(15 * 60 * 1000);
    const statusNextDay = await workerFetch(
      new Request('https://sync.example/api/status', { headers: { Origin: DEFAULT_ORIGIN } }),
      env
    );
    const nextDayJson = await statusNextDay.json();
    assert.equal(nextDayJson.paused, false);
    assert.equal(nextDayJson.utcDate, '2026-11-21');

    const writeNextDay = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt },
        body: payloadStr
      }),
      env
    );
    assert.equal(writeNextDay.status, 200);

    // Manual PAUSE_SYNC="true" kill switch
    const manualPausedEnv = makeEnv({ DB: env.DB, PAUSE_SYNC: 'true' });
    const manualRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + jwt }
      }),
      manualPausedEnv
    );
    assert.equal(manualRes.status, 503);
    assert.equal((await manualRes.json()).reason, 'manual_pause_enabled');
    const manualStatus = await (
      await workerFetch(
        new Request('https://sync.example/api/status', { headers: { Origin: DEFAULT_ORIGIN } }),
        manualPausedEnv
      )
    ).json();
    assert.equal(manualStatus.paused, true);
    assert.equal(manualStatus.reason, 'manual_pause_enabled');
  });
});

describe('Semi-private read-only share endpoint (/api/share) and Google Service Account write-back', () => {
  it('validates optional sheetSync fields cleanly in validateSyncPayload', () => {
    const valid = validateSyncPayload({
      schemaVersion: 1,
      catalogs: {},
      sheetSync: {
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit',
        checklistByCatNo: { 'CPCA-1004': true }
      }
    });
    assert.equal(valid.valid, true);
    assert.equal(validateSyncPayload({ schemaVersion: 1, catalogs: {}, sheetSync: 'bad' }).valid, false);
    assert.equal(
      validateSyncPayload({ schemaVersion: 1, catalogs: {}, sheetSync: { googleSheetUrl: 123, checklistByCatNo: {} } }).valid,
      false
    );
    assert.equal(
      validateSyncPayload({ schemaVersion: 1, catalogs: {}, sheetSync: { googleSheetUrl: 'https://x', checklistByCatNo: [] } }).valid,
      false
    );
  });

  it('mints read_share tokens in /api/state, serves /api/share JSON & Markdown across any Origin, and strips covers/tokens', async () => {
    const env = makeEnv();
    const sessionJwt = await signToken({ purpose: 'session', sub: '12345', login: 'dopingus' }, TEST_JWT_SECRET, 3600);

    const payload = {
      schemaVersion: 1,
      updatedAt: 1700000000000,
      activeCatalogUrl: 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json',
      catalogs: {
        cd_hunt_osaka_0123abcd: {
          updatedAt: 1700000000000,
          checklist: { 'bof3-ost': true, 'slash-op': false },
          customCovers: { 'bof3-ost': { variants: [{ url: 'https://cover.example/a.jpg' }], selectedIndex: 0 } },
          viewMode: 'single'
        }
      }
    };

    const putRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        method: 'PUT',
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }),
      env
    );
    assert.equal(putRes.status, 200);
    const putJson = await putRes.json();
    assert.ok(putJson.shareToken);
    assert.equal(putJson.shareUrl, 'https://sync.example/api/share/' + putJson.shareToken);

    const getRes = await workerFetch(
      new Request('https://sync.example/api/state', {
        headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt }
      }),
      env
    );
    const getJson = await getRes.json();
    assert.ok(getJson.shareToken);
    assert.ok(getJson.shareUrl.startsWith('https://sync.example/api/share/'));

    // Public OPTIONS preflight on /api/share accepts any Origin (e.g. external AI/LLM agent)
    const preflight = await workerFetch(
      new Request('https://sync.example/api/share/' + getJson.shareToken, {
        method: 'OPTIONS',
        headers: { Origin: 'https://agent.example' }
      }),
      env
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    // Method not allowed on /api/share
    const postShare = await workerFetch(
      new Request('https://sync.example/api/share/' + getJson.shareToken, {
        method: 'POST',
        headers: { Origin: 'https://agent.example' }
      }),
      env
    );
    assert.equal(postShare.status, 405);

    // Valid GET /api/share/<token> JSON from external origin strips customCovers
    const shareJsonRes = await workerFetch(
      new Request(getJson.shareUrl, {
        headers: { Origin: 'https://agent.example' }
      }),
      env
    );
    assert.equal(shareJsonRes.status, 200);
    assert.equal(shareJsonRes.headers.get('access-control-allow-origin'), '*');
    const shareJson = await shareJsonRes.json();
    assert.deepEqual(shareJson.user, { login: 'dopingus' });
    assert.equal(shareJson.activeCatalogUrl, payload.activeCatalogUrl);
    assert.deepEqual(shareJson.catalogs.cd_hunt_osaka_0123abcd.checklist, { 'bof3-ost': true, 'slash-op': false });
    assert.equal(shareJson.catalogs.cd_hunt_osaka_0123abcd.customCovers, undefined);

    // Valid GET /api/share?token=<token>&format=markdown returns readable Markdown checklist
    const shareMdRes = await workerFetch(
      new Request('https://sync.example/api/share?token=' + encodeURIComponent(getJson.shareToken) + '&format=markdown'),
      env
    );
    assert.equal(shareMdRes.status, 200);
    assert.ok(shareMdRes.headers.get('content-type').includes('text/markdown'));
    const mdText = await shareMdRes.text();
    assert.ok(mdText.includes('# CD Hunt Live Status (@dopingus)'));
    assert.ok(mdText.includes('`bof3-ost`'));
    assert.equal(mdText.includes('slash-op'), false);

    // Rejects missing, tampered, and wrong-purpose (session) JWTs with 401
    assert.equal((await workerFetch(new Request('https://sync.example/api/share/bad-token'), env)).status, 401);
    assert.equal((await workerFetch(new Request('https://sync.example/api/share/' + sessionJwt), env)).status, 401);
  });

  it('signs RS256 Google OAuth assertions and batch-updates Column A of Google Sheets when GOOGLE_SERVICE_ACCOUNT_JSON is set', async () => {
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
    const pkcs8Buf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const pkcs8B64 = Buffer.from(pkcs8Buf).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

    const saJson = JSON.stringify({
      client_email: 'cd-hunt-bot@demo-project.iam.gserviceaccount.com',
      private_key: pem,
      token_uri: 'https://oauth.google.mock/token'
    });

    const sheetWrites = [];
    let capturedAssertion = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'https://oauth.google.mock/token') {
        const params = new URLSearchParams(String(init.body || ''));
        capturedAssertion = params.get('assertion');
        return new Response(JSON.stringify({ access_token: 'ya29.mock-sheet-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u === 'https://sheets.google.mock/v4/spreadsheets/sheetXYZ123/values/A1:I500') {
        assert.equal(init.headers.Authorization, 'Bearer ya29.mock-sheet-token');
        return new Response(
          JSON.stringify({
            values: [
              ['CD Hunt Title'],
              ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number'],
              ['FALSE', 'Game', 'Capcom', 'Breath of Fire III OST', 'CPCA-1004'],
              ['TRUE', 'Anime', 'yama', 'slash', 'SRCL-12539 (通常盤)'],
              ['FALSE', 'Anime', 'Shiyui', 'Hollow', 'AICL-4670～4671'],
              ['FALSE', 'Seiyuu', 'Rico Sasaki', 'Start! (Skip AKCY-58073)', 'AKCY-58075 (Photobook)'],
              ['FALSE', 'J-Rock', 'AKFG', 'Sol-fa', 'KSCL-737']
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u === 'https://sheets.google.mock/v4/spreadsheets/sheetXYZ123/values:batchUpdate') {
        sheetWrites.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ totalUpdatedCells: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error('Unexpected Google API fetch: ' + u);
    };

    try {
      const env = makeEnv({
        GOOGLE_SERVICE_ACCOUNT_JSON: saJson,
        GOOGLE_SHEETS_API_BASE_URL: 'https://sheets.google.mock'
      });

      const statusRes = await workerFetch(
        new Request('https://sync.example/api/status', { headers: { Origin: DEFAULT_ORIGIN } }),
        env
      );
      const statusJson = await statusRes.json();
      assert.deepEqual(statusJson.sheetSync, {
        configured: true,
        serviceAccountEmail: 'cd-hunt-bot@demo-project.iam.gserviceaccount.com'
      });

      const sessionJwt = await signToken({ purpose: 'session', sub: '12345', login: 'dopingus' }, TEST_JWT_SECRET, 3600);
      const putRes = await workerFetch(
        new Request('https://sync.example/api/state', {
          method: 'PUT',
          headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: 1,
            updatedAt: 1700000000000,
            activeCatalogUrl: 'https://docs.google.com/spreadsheets/d/sheetXYZ123/export?format=csv',
            catalogs: {
              cd_hunt_sheet_00112233: {
                updatedAt: 1700000000000,
                checklist: { 'sheet-cpca-1004': true },
                viewMode: 'grid'
              }
            },
            sheetSync: {
              googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheetXYZ123/edit',
              checklistByCatNo: {
                'CPCA-1004': true,
                'SRCL-12539': false,
                'AICL-4670~4671': true,
                'AKCY-58075': false,
                'AKCY-58073': true,
                'KSCL-737': false
              }
            }
          })
        }),
        env
      );
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.deepEqual(putBody.sheetSync, { ok: true, updatedRows: 3 });

      // Verify RS256 assertion signature against public key and ensure D1 stripped transient sheetSync
      assert.ok(capturedAssertion);
      const [h, p, s] = capturedAssertion.split('.');
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        keyPair.publicKey,
        Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
        new TextEncoder().encode(h + '.' + p)
      );
      assert.equal(verified, true);
      const savedD1Json = JSON.parse(env.DB.userState.get('12345').state_json);
      assert.equal(savedD1Json.sheetSync, undefined);

      assert.equal(sheetWrites.length, 1);
      assert.equal(sheetWrites[0].valueInputOption, 'USER_ENTERED');
      assert.deepEqual(sheetWrites[0].data, [
        { range: 'A3', values: [['TRUE']] },
        { range: 'A4', values: [['FALSE']] },
        { range: 'A5', values: [['TRUE']] }
      ]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('resolves multi-tab gid titles when googleSheetUrl includes #gid=42 and scopes read/batchUpdate to that tab', async () => {
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
    const saJson = JSON.stringify({
      client_email: 'cd-hunt-bot@demo-project.iam.gserviceaccount.com',
      private_key: pem,
      token_uri: 'https://oauth.google.mock/token'
    });

    const requestedUrls = [];
    const sheetWrites = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u === 'https://oauth.google.mock/token') {
        return new Response(JSON.stringify({ access_token: 'ya29.gid-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u === 'https://sheets.google.mock/v4/spreadsheets/sheetMulti99?fields=sheets.properties(sheetId,title)') {
        return new Response(
          JSON.stringify({
            sheets: [
              { properties: { sheetId: 0, title: 'Default Tab' } },
              { properties: { sheetId: 42, title: 'Osaka Tab' } }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u === 'https://sheets.google.mock/v4/spreadsheets/sheetMulti99/values/' + encodeURIComponent("'Osaka Tab'!A1:I500")) {
        return new Response(
          JSON.stringify({
            values: [
              ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number'],
              ['FALSE', 'Game', 'Capcom', 'Breath of Fire III OST', 'CPCA-1004']
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u === 'https://sheets.google.mock/v4/spreadsheets/sheetMulti99/values:batchUpdate') {
        sheetWrites.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error('Unexpected fetch URL: ' + u);
    };

    try {
      const env = makeEnv({
        GOOGLE_SERVICE_ACCOUNT_JSON: saJson,
        GOOGLE_SHEETS_API_BASE_URL: 'https://sheets.google.mock'
      });
      const sessionJwt = await signToken({ purpose: 'session', sub: '12345', login: 'dopingus' }, TEST_JWT_SECRET, 3600);
      const putRes = await workerFetch(
        new Request('https://sync.example/api/state', {
          method: 'PUT',
          headers: { Origin: DEFAULT_ORIGIN, Authorization: 'Bearer ' + sessionJwt, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: 1,
            updatedAt: 1700000000000,
            activeCatalogUrl: 'https://docs.google.com/spreadsheets/d/sheetMulti99/export?format=csv&gid=42',
            catalogs: {
              cd_hunt_sheet_00112233: {
                updatedAt: 1700000000000,
                checklist: { 'sheet-cpca-1004': true },
                viewMode: 'grid'
              }
            },
            sheetSync: {
              googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheetMulti99/edit#gid=42',
              checklistByCatNo: { 'CPCA-1004': true }
            }
          })
        }),
        env
      );
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.deepEqual(putBody.sheetSync, { ok: true, updatedRows: 1 });
      assert.ok(requestedUrls.includes('https://sheets.google.mock/v4/spreadsheets/sheetMulti99?fields=sheets.properties(sheetId,title)'));
      assert.deepEqual(sheetWrites[0].data, [{ range: "'Osaka Tab'!A2", values: [['TRUE']] }]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
