import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SITE_URL = process.env.SITE_URL || 'https://dopingus-build.github.io/disk-crate/';
const WORKER_URL = (process.env.WORKER_URL || 'https://cd-hunt-sync.tndo.workers.dev').replace(/\/+$/, '');
const SITE_ORIGIN = new URL(SITE_URL).origin;

describe('Live deployment smoke checks (GitHub Pages + Cloudflare Worker)', () => {
  it('serves index.html with auth controls and ordered scripts from GitHub Pages', async () => {
    const res = await fetch(SITE_URL);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('id="githubAuthBtn"'), 'Expected #githubAuthBtn in live HTML');
    assert.ok(html.includes('id="copyAgentLinkBtn"'), 'Expected #copyAgentLinkBtn in live HTML');
    assert.ok(html.includes('id="githubSignOutBtn"'), 'Expected #githubSignOutBtn in live HTML');
    assert.ok(html.includes('id="syncStatusPill"'), 'Expected #syncStatusPill in live HTML');
    assert.ok(html.includes('id="sheetSyncBotBanner"'), 'Expected #sheetSyncBotBanner in live HTML');
    assert.ok(html.includes('id="openScannerBtn"'), 'Expected opt-in #openScannerBtn in live HTML');

    for (const eagerPath of ['scanner-manager.js', 'scanner-ui.js', 'scanner-worker.js', 'scanner.css']) {
      assert.equal(html.includes(eagerPath), false, `index.html must not statically load ${eagerPath} on startup`);
    }

    const orderedScripts = [
      '<script src="./js/validate.js"></script>',
      '<script src="./js/storage.js"></script>',
      '<script src="./js/db.js"></script>',
      '<script src="./js/cover-resolver.js"></script>',
      '<script src="./js/track-resolver.js"></script>',
      '<script src="./js/config.js"></script>',
      '<script src="./js/sync.js"></script>',
      '<script src="./js/sheet-adapter.js"></script>',
      '<script src="./js/collection.js"></script>',
      '<script src="./js/app.js"></script>'
    ];
    let lastIdx = -1;
    for (const tag of orderedScripts) {
      const idx = html.indexOf(tag);
      assert.notEqual(idx, -1, `Missing ${tag} in live index.html`);
      assert.ok(idx > lastIdx, `Expected ${tag} to appear in dependency order`);
      lastIdx = idx;
    }
  });

  it('serves live JS and CSS static assets with matching syncApiUrl config', async () => {
    const configRes = await fetch(new URL('js/config.js', SITE_URL));
    assert.equal(configRes.status, 200);
    const configText = await configRes.text();
    assert.ok(configText.includes(WORKER_URL), `Expected live js/config.js to reference ${WORKER_URL}`);

    for (const assetPath of [
      'js/sync.js',
      'js/sheet-adapter.js',
      'js/collection.js',
      'js/app.js',
      'js/validate.js',
      'js/storage.js',
      'js/db.js',
      'js/cover-resolver.js',
      'js/track-resolver.js',
      'js/scanner-manager.js',
      'js/scanner-ui.js',
      'js/scanner-worker.js',
      'css/styles.css',
      'css/scanner.css'
    ]) {
      const res = await fetch(new URL(assetPath, SITE_URL));
      assert.equal(res.status, 200, `Expected ${assetPath} to return HTTP 200`);
    }
  });

  it('serves same-origin /scanner-assets/v1/manifest.json and verified engine-shell.wasm on GitHub Pages', async () => {
    const manifestUrl = new URL('scanner-assets/v1/manifest.json', SITE_URL);
    const mfRes = await fetch(manifestUrl);
    assert.equal(mfRes.status, 200, `Expected ${manifestUrl} to return HTTP 200`);
    const manifest = await mfRes.json();
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(Array.isArray(manifest.packs));

    const shellPack = manifest.packs.find((p) => p && p.id === 'engine-shell');
    assert.ok(shellPack && shellPack.available && Array.isArray(shellPack.files) && shellPack.files.length === 1);
    const wasmMeta = shellPack.files[0];

    const wasmUrl = new URL(`scanner-assets/v1/${wasmMeta.path}`, SITE_URL);
    const wasmRes = await fetch(wasmUrl);
    assert.equal(wasmRes.status, 200, `Expected ${wasmUrl} to return HTTP 200`);
    const ctype = (wasmRes.headers.get('content-type') || '').toLowerCase();
    assert.ok(ctype.includes('application/wasm'), `Expected application/wasm content-type, got: ${ctype}`);

    const wasmBuf = Buffer.from(await wasmRes.arrayBuffer());
    assert.equal(wasmBuf.length, wasmMeta.bytes);
    const actualSha = crypto.createHash('sha256').update(wasmBuf).digest('hex');
    assert.equal(actualSha, wasmMeta.sha256);
  });

  it('responds cleanly on Worker /api/status with CORS headers and quota metadata', async () => {
    const res = await fetch(`${WORKER_URL}/api/status`, {
      headers: { Origin: SITE_ORIGIN }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), SITE_ORIGIN);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.paused, 'boolean');
    assert.match(String(body.utcDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(body.resetsAt);
    assert.ok(body.limits && body.limits.dailyReqLimit > 0 && body.limits.dailyWriteLimit > 0);
    assert.ok(body.sheetSync && typeof body.sheetSync.configured === 'boolean');
  });

  it('allows CORS preflight from SITE_ORIGIN and rejects untrusted foreign origins', async () => {
    const preflightRes = await fetch(`${WORKER_URL}/api/state`, {
      method: 'OPTIONS',
      headers: { Origin: SITE_ORIGIN }
    });
    assert.equal(preflightRes.status, 204);
    assert.equal(preflightRes.headers.get('access-control-allow-origin'), SITE_ORIGIN);

    const methods = preflightRes.headers.get('access-control-allow-methods') || '';
    const allowHeaders = preflightRes.headers.get('access-control-allow-headers') || '';
    assert.ok(methods.includes('GET') && methods.includes('PUT') && methods.includes('POST'));
    assert.ok(allowHeaders.toLowerCase().includes('authorization') && allowHeaders.toLowerCase().includes('content-type'));

    const blockedRes = await fetch(`${WORKER_URL}/api/status`, {
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(blockedRes.status, 403);
  });

  it('redirects /auth/login to zero-scope GitHub OAuth and blocks invalid redirect targets', async () => {
    const loginRes = await fetch(
      `${WORKER_URL}/auth/login?redirect=${encodeURIComponent(SITE_URL)}`,
      { redirect: 'manual' }
    );
    assert.equal(loginRes.status, 302);

    const location = loginRes.headers.get('location');
    assert.ok(location, 'Expected Location header on /auth/login');
    const ghUrl = new URL(location);
    assert.equal(ghUrl.origin + ghUrl.pathname, 'https://github.com/login/oauth/authorize');
    assert.ok(ghUrl.searchParams.get('client_id'));
    assert.ok(ghUrl.searchParams.get('state'));
    assert.ok((ghUrl.searchParams.get('redirect_uri') || '').endsWith('/auth/callback'));
    assert.equal(ghUrl.searchParams.get('scope'), null, 'OAuth login must not request any GitHub scope');

    const badRedirectRes = await fetch(
      `${WORKER_URL}/auth/login?redirect=${encodeURIComponent('https://evil.example/')}`,
      { redirect: 'manual' }
    );
    assert.equal(badRedirectRes.status, 400);
  });

  it('rejects unauthenticated and invalid Bearer requests to /api/state and /api/collection* with 401', async () => {
    const missingAuthRes = await fetch(`${WORKER_URL}/api/state`, {
      headers: { Origin: SITE_ORIGIN }
    });
    assert.equal(missingAuthRes.status, 401);

    const invalidAuthRes = await fetch(`${WORKER_URL}/api/state`, {
      headers: {
        Origin: SITE_ORIGIN,
        Authorization: 'Bearer invalid.jwt.token'
      }
    });
    assert.equal(invalidAuthRes.status, 401);

    const missingColRes = await fetch(`${WORKER_URL}/api/collection`, {
      headers: { Origin: SITE_ORIGIN }
    });
    assert.equal(missingColRes.status, 401);

    const missingBatchRes = await fetch(`${WORKER_URL}/api/collection/batch`, {
      method: 'POST',
      headers: { Origin: SITE_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] })
    });
    assert.equal(missingBatchRes.status, 401);
  });

  it('allows cross-origin GET /api/share/* from external origins and rejects invalid share tokens with 401', async () => {
    const res = await fetch(`${WORKER_URL}/api/share/invalid-token`, {
      headers: { Origin: 'https://agent.example' }
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});
