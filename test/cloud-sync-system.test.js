'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT_DIR, 'index.html');
const VALIDATE_PATH = path.join(ROOT_DIR, 'js', 'validate.js');
const STORAGE_PATH = path.join(ROOT_DIR, 'js', 'storage.js');
const COVER_RESOLVER_PATH = path.join(ROOT_DIR, 'js', 'cover-resolver.js');
const CONFIG_PATH = path.join(ROOT_DIR, 'js', 'config.js');
const SYNC_PATH = path.join(ROOT_DIR, 'js', 'sync.js');
const SHEET_ADAPTER_PATH = path.join(ROOT_DIR, 'js', 'sheet-adapter.js');
const APP_PATH = path.join(ROOT_DIR, 'js', 'app.js');
const SCHEMA_PATH = path.join(ROOT_DIR, 'worker', 'schema.sql');
const SAMPLE_CATALOG_PATH = path.join(ROOT_DIR, 'docs', 'sample-catalog.json');

const { deriveStoragePrefix } = require('../js/storage.js');

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

async function startFullSystem(envOverrides = {}) {
  const { default: worker } = await import('../worker/index.mjs');
  const db = createSqliteD1Database();
  const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));

  const githubUsers = {
    code_alice: { id: 1001, login: 'alice', avatar_url: 'https://avatars.example/alice.png', token: 'gho_sys_alice' },
    code_bob: { id: 2002, login: 'bob', avatar_url: 'https://avatars.example/bob.png', token: 'gho_sys_bob' }
  };

  const mockGithubServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'POST' && reqUrl.pathname === '/login/oauth/access_token') {
      const payload = JSON.parse(bodyText);
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
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
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

  let metadataBaseUrl = '';
  const metadataServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    if (reqUrl.pathname === '/alice/cd-metadata/main/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          catalogs: [
            { title: 'Alice Sample Catalog', url: `${metadataBaseUrl}/alice/cd-metadata/main/sample.json` }
          ]
        })
      );
      return;
    }
    if (reqUrl.pathname === '/alice/cd-metadata/main/sample.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sampleCatalog));
      return;
    }
    if (reqUrl.pathname === '/dopingus-build/cd-metadata/main/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1, catalogs: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const [githubBaseUrl, metaUrl] = await Promise.all([
    listenServer(mockGithubServer),
    listenServer(metadataServer)
  ]);
  metadataBaseUrl = metaUrl;

  const workerEnv = Object.assign(
    {
      DB: db,
      ALLOWED_ORIGINS: 'https://dopingus-build.github.io',
      APP_REDIRECT_URL: 'https://dopingus-build.github.io/cd-hunt/',
      GITHUB_CLIENT_ID: 'gh-sys-client',
      GITHUB_CLIENT_SECRET: 'gh-sys-secret',
      JWT_SECRET: 'system-test-jwt-secret-0123456789abcdef',
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

  let workerBaseUrl = '';
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
  const sampleCatalogUrl = `${metadataBaseUrl}/alice/cd-metadata/main/sample.json`;
  const samplePrefix = deriveStoragePrefix({
    sourceUrl: sampleCatalogUrl,
    meta: sampleCatalog.meta,
    items: sampleCatalog.items
  });

  return {
    db,
    workerBaseUrl,
    metadataBaseUrl,
    sampleCatalogUrl,
    samplePrefix,
    sampleCatalog,
    async completeOAuthRedirect(loginUrl, oauthCode) {
      const loginRes = await fetch(loginUrl, { redirect: 'manual' });
      assert.equal(loginRes.status, 302);
      const ghAuthUrl = new URL(loginRes.headers.get('location'));
      assert.equal(ghAuthUrl.searchParams.get('scope'), null);
      const state = ghAuthUrl.searchParams.get('state');

      const callbackRes = await fetch(
        `${workerBaseUrl}/auth/callback?code=${encodeURIComponent(oauthCode)}&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' }
      );
      assert.equal(callbackRes.status, 302);
      const finalLoc = callbackRes.headers.get('location');
      assert.ok(finalLoc.includes('#auth_token='));
      const hashIdx = finalLoc.indexOf('#');
      return finalLoc.slice(hashIdx);
    },
    async close() {
      await Promise.all([
        closeServer(workerServer),
        closeServer(mockGithubServer),
        closeServer(metadataServer)
      ]);
      db.close();
    }
  };
}

function createDomHarness(html) {
  const elements = new Map();
  const docListeners = {};
  const winListeners = {};
  const fallbackImgsById = new Map();

  function createEl(id, initialClasses = []) {
    const classes = new Set(initialClasses);
    const attrs = {};
    const listeners = {};
    return {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      href: '',
      files: [],
      style: {},
      classList: {
        add(...t) { t.filter(Boolean).forEach((x) => classes.add(x)); },
        remove(...t) { t.filter(Boolean).forEach((x) => classes.delete(x)); },
        toggle(tok, force) {
          if (force === undefined) {
            if (classes.has(tok)) { classes.delete(tok); return false; }
            classes.add(tok);
            return true;
          }
          if (force) { classes.add(tok); return true; }
          classes.delete(tok);
          return false;
        },
        contains(tok) { return classes.has(tok); }
      },
      setAttribute(name, val) { attrs[name] = String(val); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      querySelectorAll(sel) {
        if (sel === 'img[data-fallback-id]') return extractFallbackImgs(this.innerHTML);
        return [];
      },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of listeners[ev.type] || []) fn.call(this, ev);
      }
    };
  }

  function extractFallbackImgs(markup) {
    const imgs = [];
    for (const m of String(markup || '').matchAll(/data-fallback-id=["']([^"']+)["']/g)) {
      const imgStub = { getAttribute: (a) => (a === 'data-fallback-id' ? m[1] : null), onerror: null };
      fallbackImgsById.set(m[1], imgStub);
      imgs.push(imgStub);
    }
    return imgs;
  }

  for (const m of html.matchAll(/<[^>]*\bid=["']([^"']+)["'][^>]*>/g)) {
    const cm = m[0].match(/\bclass=["']([^"']+)["']/);
    elements.set(m[1], createEl(m[1], cm ? cm[1].split(/\s+/).filter(Boolean) : []));
  }

  const documentStub = {
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    body: { appendChild() {}, removeChild() {} },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      if (/^(?:art-slot|single-variants|refresh-icon)-/.test(id)) {
        const dyn = createEl(id, []);
        elements.set(id, dyn);
        return dyn;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-album-id]') {
        const cards = [];
        for (const gid of ['albumGrid', 'digitalGrid']) {
          const g = elements.get(gid);
          if (!g || !g.innerHTML) continue;
          for (const m of g.innerHTML.matchAll(/data-album-id=["']([^"']+)["']/g)) {
            cards.push({ getAttribute: (a) => (a === 'data-album-id' ? m[1] : null) });
          }
        }
        return cards;
      }
      if (sel === 'img[data-fallback-id]') {
        const src = ['albumGrid', 'digitalGrid', 'lbArtBox'].map((i) => (elements.get(i) && elements.get(i).innerHTML) || '').join('');
        return extractFallbackImgs(src);
      }
      return [];
    },
    createElement: () => createEl('dynamic', []),
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    }
  };

  return { elements, docListeners, winListeners, documentStub };
}

function createStorageInstance(seedObj = {}) {
  const store = new Map(Object.entries(seedObj).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    get length() { return store.size; },
    key(idx) { return idx >= 0 && idx < store.size ? Array.from(store.keys())[idx] : null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    snapshot() { return Object.fromEntries(store.entries()); }
  };
}

async function bootSystemClient(sys, {
  origin = 'https://dopingus-build.github.io',
  pathname = '/cd-hunt/',
  search = '',
  hash = '',
  initialStorage = {},
  syncDebounceMs = 20,
  coverMocks = null,
  imageImpl = null
} = {}) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const { elements, docListeners, winListeners, documentStub } = createDomHarness(html);
  const localStorage = createStorageInstance(initialStorage);
  const locationNavigations = [];
  const copiedTexts = [];
  const requestLog = [];
  const locationObj = {
    origin,
    pathname,
    search,
    hash,
    assign(next) { locationNavigations.push(next); }
  };

  let observerCallback = null;
  const observedTargets = [];
  class TrackingIntersectionObserver {
    constructor(cb) { observerCallback = cb; }
    observe(target) { observedTargets.push(target); }
    unobserve() {}
    disconnect() { observedTargets.length = 0; }
  }
  class NoopImage { set src(_) {} }

  // Forward frontend fetch to real local HTTP servers, attaching browser-style Origin on cross-origin Worker requests.
  async function systemFetch(rawUrl, init = {}) {
    let urlStr = String(rawUrl);
    if (urlStr.startsWith('https://raw.githubusercontent.com/')) {
      const parsedRaw = new URL(urlStr);
      urlStr = `${sys.metadataBaseUrl}${parsedRaw.pathname}`;
    } else if (
      urlStr.includes('musicbrainz.org') ||
      urlStr.includes('coverartarchive.org') ||
      urlStr.includes('itunes.apple.com') ||
      urlStr.startsWith('https://docs.google.com/')
    ) {
      if (coverMocks) return coverMocks(urlStr);
      return new Response(JSON.stringify({ releases: [], images: [], results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.assign({}, init.headers || {});
    if (urlStr.startsWith(sys.workerBaseUrl) && !headers.Origin) {
      headers.Origin = origin;
    }

    const realInit = { method, headers };
    if (init.body !== undefined) realInit.body = init.body;
    if (init.keepalive !== undefined) realInit.keepalive = init.keepalive;

    const res = await fetch(urlStr, realInit);
    requestLog.push({ method, url: urlStr, keepalive: init.keepalive, status: res.status });
    return res;
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    Image: imageImpl || NoopImage,
    FileReader: class {},
    IntersectionObserver: TrackingIntersectionObserver,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    document: documentStub,
    localStorage,
    location: locationObj,
    navigator: {
      clipboard: {
        async writeText(txt) {
          copiedTexts.push(txt);
        }
      }
    },
    addEventListener(type, fn) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(fn);
    },
    history: {
      replaceState(_s, _t, nextUrl) {
        const s = String(nextUrl);
        const hIdx = s.indexOf('#');
        locationObj.hash = hIdx !== -1 ? s.slice(hIdx) : '';
        const beforeH = hIdx !== -1 ? s.slice(0, hIdx) : s;
        const qIdx = beforeH.indexOf('?');
        locationObj.search = qIdx !== -1 ? beforeH.slice(qIdx) : '';
      }
    },
    fetch: systemFetch
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const filePath of [VALIDATE_PATH, STORAGE_PATH, COVER_RESOLVER_PATH, CONFIG_PATH]) {
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
  }
  context.CDHunt.config.syncApiUrl = sys.workerBaseUrl;
  context.CDHunt.config.syncDebounceMs = syncDebounceMs;
  for (const filePath of [SYNC_PATH, SHEET_ADAPTER_PATH, APP_PATH]) {
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
  }

  async function settle(ms = 45) {
    await new Promise((r) => setTimeout(r, ms));
  }
  await settle();

  return {
    elements,
    localStorage,
    locationObj,
    locationNavigations,
    copiedTexts,
    requestLog,
    settle,
    async clickElement(id) {
      const el = elements.get(id);
      assert.ok(el, `#${id} must exist`);
      el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
      await settle();
    },
    triggerDocumentClick(action, attrs = {}) {
      const targetStub = {
        closest: (sel) => (sel === '[data-action]' ? targetStub : null),
        getAttribute: (name) => (name === 'data-action' ? action : (attrs[name] ?? null))
      };
      for (const fn of docListeners.click || []) fn({ target: targetStub, stopPropagation() {} });
    },
    async triggerIntersection(albumId) {
      if (!observerCallback) return;
      const matches = observedTargets.filter((t) => t && t.getAttribute('data-album-id') === albumId);
      if (matches.length > 0) {
        observerCallback(matches.map((target) => ({ isIntersecting: true, target })));
        await settle();
      }
    },
    async triggerVisibilityChange(nextState) {
      documentStub.visibilityState = nextState;
      for (const fn of docListeners.visibilitychange || []) fn({});
      await settle();
    }
  };
}

describe('Full-stack cloud sync system tests (Frontend VM <-> HTTP Worker <-> SQLite)', () => {
  it('completes OAuth login, two-device sync round trip, newer-baseline uncheck, and visibilitychange keepalive flush', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    // Device A opens app unauthenticated -> clicks Sign in -> completes OAuth -> reloads with #auth_token
    const deviceAInit = await bootSystemClient(sys, {
      search: `?syncApi=${encodeURIComponent(sys.workerBaseUrl)}`
    });
    await deviceAInit.clickElement('githubAuthBtn');
    assert.equal(deviceAInit.locationNavigations.length, 1);
    const aliceHash = await sys.completeOAuthRedirect(deviceAInit.locationNavigations[0], 'code_alice');

    const deviceA = await bootSystemClient(sys, {
      search: `?syncApi=${encodeURIComponent(sys.workerBaseUrl)}`,
      hash: aliceHash,
      syncDebounceMs: 15
    });
    assert.equal(deviceA.locationObj.hash, '');
    assert.ok(deviceA.elements.get('syncStatusPill').textContent.includes('@alice'));
    assert.ok(deviceA.elements.get('catalogPresetsList').innerHTML.includes('Alice Sample Catalog'));

    // Load discovered catalog preset, mutate checklist + viewMode + note + custom cover
    deviceA.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await deviceA.settle(60);
    deviceA.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await deviceA.clickElement('viewModeBtn');
    await deviceA.clickElement('dismissNoteBtn');
    deviceA.triggerDocumentClick('open-lb', { 'data-lb-idx': '0' });
    await deviceA.clickElement('lbToggleCustomBtn');
    deviceA.elements.get('customCoverInput').value = 'https://custom.example/a-reg.jpg';
    deviceA.elements.get('customCoverLabel').value = '通常盤 Custom';
    await deviceA.clickElement('saveCustomCoverBtn');
    await deviceA.settle(80);

    // Inspect SQLite directly: zero GitHub token leaked, Device A state stored cleanly
    const rowsAfterA = sys.db.queryRaw('SELECT github_id, github_login, state_json FROM user_state');
    assert.equal(rowsAfterA.length, 1);
    assert.equal(rowsAfterA[0].github_id, '1001');
    assert.equal(rowsAfterA[0].github_login, 'alice');
    assert.equal(rowsAfterA[0].state_json.includes('gho_sys_alice'), false);
    const savedDoc = JSON.parse(rowsAfterA[0].state_json);
    assert.equal(savedDoc.catalogs[sys.samplePrefix].checklist['sample-01'], true);
    assert.equal(savedDoc.catalogs[sys.samplePrefix].customCovers['sample-01'].variants[0].url, 'https://custom.example/a-reg.jpg');
    assert.equal(savedDoc.catalogs[sys.samplePrefix].viewMode, 'single');
    assert.equal(savedDoc.catalogs[sys.samplePrefix].noteDismissed, true);

    // Device B (fresh browser) completes real OAuth -> pulls SQLite -> zero redundant startup PUTs
    const deviceBInit = await bootSystemClient(sys, {
      search: `?syncApi=${encodeURIComponent(sys.workerBaseUrl)}`
    });
    await deviceBInit.clickElement('githubAuthBtn');
    const aliceHashB = await sys.completeOAuthRedirect(deviceBInit.locationNavigations[0], 'code_alice');

    const deviceB = await bootSystemClient(sys, {
      search: `?syncApi=${encodeURIComponent(sys.workerBaseUrl)}`,
      hash: aliceHashB,
      syncDebounceMs: 5000
    });
    assert.equal(deviceB.requestLog.filter((r) => r.method === 'PUT').length, 0);
    assert.equal(deviceB.localStorage.getItem('cd_hunt_catalog_url_v1'), sys.sampleCatalogUrl);
    assert.equal(deviceB.elements.get('progressBadge').textContent, '1 / 1');
    assert.equal(deviceB.elements.get('viewModeLabel').textContent, 'Grid View');
    assert.equal(deviceB.elements.get('digitalNoteBanner').classList.contains('hidden'), true);
    const cacheB = JSON.parse(deviceB.localStorage.getItem(`${sys.samplePrefix}_cover_cache_v6`));
    assert.equal(cacheB['sample-01'].variants[0].url, 'https://custom.example/a-reg.jpg');

    // Device B explicitly unchecks sample-01, marks dig-01, returns to grid, and flushes via visibilitychange keepalive
    deviceB.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    deviceB.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    await deviceB.clickElement('viewModeBtn');
    await deviceB.triggerVisibilityChange('hidden');
    await deviceB.settle(60);

    const putLogsB = deviceB.requestLog.filter((r) => r.method === 'PUT');
    assert.equal(putLogsB.length, 1);
    assert.equal(putLogsB[0].keepalive, true);
    assert.equal(putLogsB[0].status, 200);

    // Device A reloads with its existing localStorage -> newer Device B baseline unchecks sample-01
    const deviceAReloaded = await bootSystemClient(sys, {
      initialStorage: deviceA.localStorage.snapshot(),
      syncDebounceMs: 20
    });
    const checklistAAfter = JSON.parse(deviceAReloaded.localStorage.getItem(`${sys.samplePrefix}_checklist_v2`));
    assert.equal(Boolean(checklistAAfter['sample-01']), false);
    assert.equal(checklistAAfter['dig-01'], true);
    assert.equal(deviceAReloaded.elements.get('viewModeLabel').textContent, '1-Col View');
  });

  it('backfills offline local progress to empty cloud and union-merges unbaselined first-time login', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    // Part A: Alice works offline first (no token), then logs in to empty SQLite -> automatic backfill PUT
    const aliceOffline = await bootSystemClient(sys, {
      search: ''
    });
    aliceOffline.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await aliceOffline.settle(50);
    aliceOffline.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await aliceOffline.clickElement('githubAuthBtn');
    const aliceHash = await sys.completeOAuthRedirect(aliceOffline.locationNavigations[0], 'code_alice');

    const aliceSignedIn = await bootSystemClient(sys, {
      initialStorage: aliceOffline.localStorage.snapshot(),
      hash: aliceHash,
      syncDebounceMs: 15
    });
    await aliceSignedIn.settle(70);

    const aliceRows = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(aliceRows.length, 1);
    assert.equal(JSON.parse(aliceRows[0].state_json).catalogs[sys.samplePrefix].checklist['sample-01'], true);

    // Part B: Bob already has dig-01 in SQLite; Device C works offline with sample-01 + custom cover then logs in
    const bobHash1 = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_bob'
    );
    const bobCloudDevice = await bootSystemClient(sys, {
      hash: bobHash1,
      syncDebounceMs: 15
    });
    bobCloudDevice.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await bobCloudDevice.settle(50);
    bobCloudDevice.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    await bobCloudDevice.settle(80);
    const bobInitialRows = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '2002'");
    assert.equal(bobInitialRows.length, 1);
    assert.equal(JSON.parse(bobInitialRows[0].state_json).catalogs[sys.samplePrefix].checklist['dig-01'], true);

    // Offline Device C adds sample-01 + custom cover without any sync baseline
    const bobOfflineDevice = await bootSystemClient(sys);
    bobOfflineDevice.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await bobOfflineDevice.settle(50);
    bobOfflineDevice.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    bobOfflineDevice.triggerDocumentClick('open-lb', { 'data-lb-idx': '0' });
    await bobOfflineDevice.clickElement('lbToggleCustomBtn');
    bobOfflineDevice.elements.get('customCoverInput').value = 'https://custom.example/union.jpg';
    bobOfflineDevice.elements.get('customCoverLabel').value = 'Union Custom';
    await bobOfflineDevice.clickElement('saveCustomCoverBtn');

    const bobHash2 = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_bob'
    );
    const bobMerged = await bootSystemClient(sys, {
      initialStorage: bobOfflineDevice.localStorage.snapshot(),
      hash: bobHash2,
      syncDebounceMs: 15
    });
    await bobMerged.settle(80);

    const mergedChecklist = JSON.parse(bobMerged.localStorage.getItem(`${sys.samplePrefix}_checklist_v2`));
    assert.deepEqual(mergedChecklist, { 'dig-01': true, 'sample-01': true });
    const bobRows = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '2002'");
    const storedBob = JSON.parse(bobRows[0].state_json).catalogs[sys.samplePrefix];
    assert.deepEqual(storedBob.checklist, { 'dig-01': true, 'sample-01': true });
    assert.equal(storedBob.customCovers['sample-01'].variants[0].url, 'https://custom.example/union.jpg');
  });

  it('enforces real Worker 429 rate limits, 503 pause short-circuit, 413 payload limits, and 403 origin blocking', async (t) => {
    // 1) Real SQLite 429 hourly rate limit
    const sys429 = await startFullSystem({ USER_HOURLY_WRITE_LIMIT: '1' });
    t.after(() => sys429.close());
    const hash429 = await sys429.completeOAuthRedirect(
      `${sys429.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_alice'
    );
    const app429 = await bootSystemClient(sys429, { hash: hash429, syncDebounceMs: 10 });
    app429.triggerDocumentClick('load-preset', { 'data-preset-url': sys429.sampleCatalogUrl });
    await app429.settle(60); // load triggers 1st PUT (allowed, hour_writes -> 1)
    assert.ok(app429.elements.get('syncStatusPill').textContent.includes('Synced'));
    app429.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app429.settle(60); // 2nd PUT hits SQLite hour_writes limit -> 429
    assert.ok(app429.elements.get('syncStatusPill').textContent.includes('Rate limited'));

    // 2) Real SQLite 503 daily write limit + client short-circuit
    const sys503 = await startFullSystem({ DAILY_WRITE_LIMIT: '1' });
    t.after(() => sys503.close());
    const hash503 = await sys503.completeOAuthRedirect(
      `${sys503.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_alice'
    );
    const app503 = await bootSystemClient(sys503, { hash: hash503, syncDebounceMs: 10 });
    app503.triggerDocumentClick('load-preset', { 'data-preset-url': sys503.sampleCatalogUrl });
    await app503.settle(60); // 1st write succeeds (write_count -> 1)
    app503.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app503.settle(60); // 2nd write triggers 503 Paused
    assert.ok(app503.elements.get('syncStatusPill').textContent.includes('Paused until 00:00 UTC'));
    const putsAtPause = app503.requestLog.filter((r) => r.method === 'PUT').length;
    app503.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    await app503.settle(50);
    assert.equal(app503.requestLog.filter((r) => r.method === 'PUT').length, putsAtPause);

    // 3) Real Worker 413 Payload Too Large + 403 Bad Origin
    const sys413 = await startFullSystem({ MAX_PAYLOAD_BYTES: '180' });
    t.after(() => sys413.close());
    const hash413 = await sys413.completeOAuthRedirect(
      `${sys413.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_alice'
    );
    const app413 = await bootSystemClient(sys413, { hash: hash413, syncDebounceMs: 10 });
    app413.triggerDocumentClick('load-preset', { 'data-preset-url': sys413.sampleCatalogUrl });
    await app413.settle(60);
    assert.ok(app413.elements.get('syncStatusPill').textContent.includes('Too large for cloud'));

    const appEvilOrigin = await bootSystemClient(sys413, {
      origin: 'https://evil.example',
      hash: hash413,
      syncDebounceMs: 10
    });
    assert.equal(appEvilOrigin.requestLog.some((r) => r.url.endsWith('/api/state') && r.status === 403), true);
    assert.ok(appEvilOrigin.elements.get('syncStatusPill').textContent.includes('Offline'));
  });

  it('conserves real SQLite daily_usage write_count across cover resolution and rapid toggles', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    class MockVerifiedImage {
      set src(val) {
        this._src = val;
        setTimeout(() => {
          this.naturalWidth = 500;
          this.naturalHeight = 500;
          if (typeof this.onload === 'function') this.onload();
        }, 1);
      }
    }

    const hash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_alice'
    );
    const app = await bootSystemClient(sys, {
      hash,
      syncDebounceMs: 50,
      imageImpl: MockVerifiedImage,
      initialStorage: {
        cd_hunt_catalog_url_v1: sys.sampleCatalogUrl
      },
      coverMocks: async (url) => {
        if (url.includes('musicbrainz.org/ws/2/release/')) {
          return new Response(JSON.stringify({ releases: [{ id: 'sys-mb-1', status: 'Official' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (url.includes('coverartarchive.org/release/sys-mb-1')) {
          return new Response(JSON.stringify({ images: [{ front: true, thumbnails: { '500': 'https://img.example/sys-mb.jpg' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    // Clear startup activeCatalogUrl backfill from clean baseline, then check writes
    await app.settle(90);
    const baselineWrites = sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count;

    // Background cover auto-resolution adds 0 SQLite writes
    await app.triggerIntersection('sample-01');
    await app.settle(80);
    const cached = JSON.parse(app.localStorage.getItem(`${sys.samplePrefix}_cover_cache_v6`));
    assert.ok(cached && cached['sample-01'] && cached['sample-01'].variants.length > 0);
    assert.equal(sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count, baselineWrites);

    // 5 rapid synchronous checklist toggles coalesce into exactly 1 SQLite write
    for (let i = 0; i < 5; i++) {
      app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    }
    await app.settle(100);
    assert.equal(sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count, baselineWrites + 1);
  });

  it('serves live semi-private /api/share link for AI/LLM agents and syncs Got it? back to Google Sheets via Service Account', async (t) => {
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

    const sheetRows = [
      ['CD Hunt Checklist'],
      ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number', 'Filing', 'Price', 'Priority', 'Recommended Shops'],
      ['FALSE', 'Games', 'Capcom', 'Breath of Fire III OST', 'CPCA-1004', 'Look under ブ', '¥3000', 'High', 'Mandarake']
    ];
    const batchUpdates = [];

    const googleMockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.sys-sheet-token', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/sheetSys99/values/A1:I500') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: sheetRows }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/sheetSys99/values:batchUpdate') {
        const updatePayload = JSON.parse(bodyStr);
        batchUpdates.push(updatePayload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalUpdatedCells: updatePayload.data.length }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const googleMockUrl = await listenServer(googleMockServer);
    t.after(() => closeServer(googleMockServer));

    const sys = await startFullSystem({
      GOOGLE_OAUTH_TOKEN_URL: `${googleMockUrl}/oauth/token`,
      GOOGLE_SHEETS_API_BASE_URL: googleMockUrl,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'cd-hunt-sync@sys.iam.gserviceaccount.com',
        private_key: pem,
        token_uri: `${googleMockUrl}/oauth/token`
      })
    });
    t.after(() => sys.close());

    const sheetCsvText = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Games,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,¥3000,High,Mandarake'
    ].join('\n');

    const sheetCatalogUrl = 'https://docs.google.com/spreadsheets/d/sheetSys99/edit';
    const sheetCsvExportUrl = 'https://docs.google.com/spreadsheets/d/sheetSys99/export?format=csv';
    const hash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/cd-hunt/')}`,
      'code_alice'
    );

    const app = await bootSystemClient(sys, {
      hash,
      syncDebounceMs: 10,
      initialStorage: {
        cd_hunt_catalog_url_v1: sheetCsvExportUrl
      },
      coverMocks: async (url) => {
        if (url === sheetCsvExportUrl || url === sheetCatalogUrl) {
          return new Response(sheetCsvText, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });

    // Click #copyAgentLinkBtn -> copies live share link
    assert.equal(app.elements.get('copyAgentLinkBtn').classList.contains('hidden'), false);
    await app.clickElement('copyAgentLinkBtn');
    const copiedShareMdUrl = app.copiedTexts.find((t) => t.includes('/api/share/'));
    assert.ok(copiedShareMdUrl && copiedShareMdUrl.endsWith('?format=markdown'));

    // Toggle CPCA-1004 acquired -> pushes sheetSync to Worker -> Google Sheet batchUpdate sets A3 = TRUE
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    await app.settle(120);

    assert.equal(batchUpdates.length, 1);
    assert.deepEqual(batchUpdates[0].data, [{ range: 'A3', values: [['TRUE']] }]);

    // External AI/LLM agent reads the semi-private share link without GitHub credentials
    const agentRes = await fetch(copiedShareMdUrl, { headers: { Origin: 'https://agent.example' } });
    assert.equal(agentRes.status, 200);
    assert.equal(agentRes.headers.get('access-control-allow-origin'), '*');
    const agentMd = await agentRes.text();
    assert.ok(agentMd.includes('# CD Hunt Live Status (@alice)'));
    assert.ok(agentMd.includes('`sheet-cpca-1004`'));

    // JSON variant also works cleanly and strips transient/cover data
    const agentJsonUrl = copiedShareMdUrl.replace('?format=markdown', '');
    const agentJson = await (await fetch(agentJsonUrl)).json();
    assert.equal(agentJson.ok, true);
    assert.equal(agentJson.user.login, 'alice');
    assert.equal(agentJson.activeCatalogUrl, sheetCsvExportUrl);
    const catalogKeys = Object.keys(agentJson.catalogs);
    assert.equal(catalogKeys.length, 1);
    assert.deepEqual(agentJson.catalogs[catalogKeys[0]].checklist, { 'sheet-cpca-1004': true });
  });
});
