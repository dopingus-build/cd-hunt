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
const DB_PATH = path.join(ROOT_DIR, 'js', 'db.js');
const COVER_RESOLVER_PATH = path.join(ROOT_DIR, 'js', 'cover-resolver.js');
const TRACK_RESOLVER_PATH = path.join(ROOT_DIR, 'js', 'track-resolver.js');
const CONFIG_PATH = path.join(ROOT_DIR, 'js', 'config.js');
const SYNC_PATH = path.join(ROOT_DIR, 'js', 'sync.js');
const SHEET_ADAPTER_PATH = path.join(ROOT_DIR, 'js', 'sheet-adapter.js');
const COLLECTION_PATH = path.join(ROOT_DIR, 'js', 'collection.js');
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
    if (reqUrl.pathname === '/alice/cd-metadata/main/hybrid.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          meta: {
            title: 'Hybrid Live System List',
            subtitle: 'Base JSON + Google Sheet #gid=42 overlay',
            googleSheetUrl: 'https://docs.google.com/spreadsheets/d/hybridSys42/edit#gid=42'
          },
          categories: [
            { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
            { key: 'J-Rock', label: 'J-Rock', dot: '#f43f5e' }
          ],
          items: [
            {
              id: 'sys-cur-akfg',
              category: 'J-Rock',
              artist: 'Asian Kung-Fu Generation',
              title: 'Sol-fa',
              regCatNo: 'KSCL-737',
              catalog: 'KSCL-737 (通常盤)',
              kana: 'ア',
              filing: 'Look under ア',
              price: '¥400–¥800'
            }
          ]
        })
      );
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
      APP_REDIRECT_URL: 'https://dopingus-build.github.io/disk-crate/',
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
    workerEnv,
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
      disabled: false,
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
      get className() { return Array.from(classes).join(' '); },
      set className(val) {
        classes.clear();
        String(val || '').split(/\s+/).filter(Boolean).forEach((t) => classes.add(t));
      },
      setAttribute(name, val) { attrs[name] = String(val); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      querySelectorAll(sel) {
        if (sel === 'img[data-fallback-id]') return extractFallbackImgs(this.innerHTML);
        return [];
      },
      select() {},
      focus() {},
      click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); },
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

  function registerMarkupIds(markup) {
    if (!markup) return;
    for (const m of String(markup).matchAll(/<[^>]*\bid=["']([^"']+)["'][^>]*>/g)) {
      const id = m[1];
      if (!elements.has(id)) {
        const cm = m[0].match(/\bclass=["']([^"']+)["']/);
        elements.set(id, createEl(id, cm ? cm[1].split(/\s+/).filter(Boolean) : []));
      }
    }
  }

  registerMarkupIds(html);

  let scriptLoader = null;
  const documentStub = {
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    head: {
      appendChild(el) {
        if (el && el.src && typeof scriptLoader === 'function') {
          scriptLoader(el.src);
        }
        if (el && typeof el.onload === 'function') el.onload();
      }
    },
    body: {
      appendChild(el) {
        if (el && el.id) elements.set(el.id, el);
        if (el && el.innerHTML) registerMarkupIds(el.innerHTML);
      },
      removeChild() {}
    },
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

  return {
    elements,
    docListeners,
    winListeners,
    documentStub,
    setScriptLoader(fn) { scriptLoader = fn; }
  };
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
  pathname = '/disk-crate/',
  search = '',
  hash = '',
  initialStorage = {},
  syncDebounceMs = 20,
  coverMocks = null,
  imageImpl = null,
  indexedDBImpl = null,
  offlineRef = null,
  cachesImpl = undefined,
  workerCtor = undefined,
  extraNavigator = null
} = {}) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const { elements, docListeners, winListeners, documentStub, setScriptLoader } = createDomHarness(html);
  const localStorage = createStorageInstance(initialStorage);
  const locationNavigations = [];
  const copiedTexts = [];
  const requestLog = [];
  const locationObj = {
    origin,
    pathname,
    search,
    hash,
    href: origin + pathname + search + hash,
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
      urlStr.startsWith('https://docs.google.com/') ||
      urlStr.includes('scanner-assets/')
    ) {
      if (coverMocks) return coverMocks(urlStr);
      return new Response(JSON.stringify({ releases: [], images: [], results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const method = String(init.method || 'GET').toUpperCase();
    if (offlineRef && offlineRef.offline && urlStr.startsWith(sys.workerBaseUrl)) {
      throw new Error('Simulated offline network');
    }
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

  const navObj = {
    clipboard: {
      async writeText(txt) {
        copiedTexts.push(txt);
      }
    }
  };
  if (extraNavigator && typeof extraNavigator === 'object') {
    Object.assign(navObj, extraNavigator);
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    Response,
    crypto: globalThis.crypto,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    caches: cachesImpl,
    Worker: workerCtor,
    Image: imageImpl || NoopImage,
    FileReader: class {},
    IntersectionObserver: TrackingIntersectionObserver,
    indexedDB: indexedDBImpl,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    document: documentStub,
    localStorage,
    location: locationObj,
    navigator: navObj,
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
  setScriptLoader((src) => {
    const rel = String(src).replace(/^\.\//, '');
    const abs = path.resolve(ROOT_DIR, rel);
    if (fs.existsSync(abs)) {
      vm.runInContext(fs.readFileSync(abs, 'utf8'), context, { filename: abs });
    }
  });
  for (const filePath of [VALIDATE_PATH, STORAGE_PATH, DB_PATH, COVER_RESOLVER_PATH, TRACK_RESOLVER_PATH, CONFIG_PATH]) {
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
  }
  const ns = context.DiskCrate || context.CDHunt;
  ns.config.syncApiUrl = sys.workerBaseUrl;
  ns.config.syncDebounceMs = syncDebounceMs;
  ns.config.mbTrackMinIntervalMs = 0;
  for (const filePath of [SYNC_PATH, SHEET_ADAPTER_PATH, COLLECTION_PATH, APP_PATH]) {
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
  }

  async function settle(ms = 45) {
    await new Promise((r) => setTimeout(r, ms));
  }
  await settle();

  return {
    window: context,
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
    setInput(id, val) {
      const el = elements.get(id);
      assert.ok(el, `#${id} must exist`);
      el.value = String(val);
      el.dispatchEvent({ type: 'input', target: el });
    },
    async selectLocalFile(name, content) {
      const fileInput = elements.get('catalogFileInput');
      assert.ok(fileInput, '#catalogFileInput must exist');
      const raw = typeof content === 'string' ? content : JSON.stringify(content);
      fileInput.files = [{ name, async text() { return raw; } }];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
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
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys429.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys503.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys413.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
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
    assert.ok(agentMd.includes('# Disk Crate Live Status (@alice)'));
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

  it('syncs hybrid JSON + meta.googleSheetUrl (#gid=42) across two devices and stays resilient when Sheets API returns 403', async (t) => {
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
    const batchUpdates = [];
    const sheetRows = [
      ['Got it?', 'Category', 'Artist', 'Title', 'Catalog Number', 'Filing', 'Price', 'Priority', 'Recommended Shops'],
      ['TRUE', 'J-Rock', 'Asian Kung-Fu Generation', 'Sol-fa', 'KSCL-737', 'Look under ア', '¥500', 'Medium', 'Book Off'],
      ['FALSE', 'Game OST', 'Keiichi Okabe', 'NieR:Automata OST', 'SQEX-10589~91', 'Look under ナ', '¥2,500', 'High', 'Mandarake']
    ];

    const googleMockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.hybrid-token', expires_in: 3600 }));
        return;
      }
      if (forceSheetsForbidden) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 403, message: 'The caller does not have permission' } }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/hybridSys42') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sheets: [
              { properties: { sheetId: 0, title: 'Default' } },
              { properties: { sheetId: 42, title: 'Osaka 2026' } }
            ]
          })
        );
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/hybridSys42/values/' + encodeURIComponent("'Osaka 2026'!A1:I500")) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: sheetRows }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/hybridSys42/values:batchUpdate') {
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
        client_email: 'cd-hunt-hybrid@sys.iam.gserviceaccount.com',
        private_key: pem,
        token_uri: `${googleMockUrl}/oauth/token`
      })
    });
    t.after(() => sys.close());

    const hybridJsonUrl = `${sys.metadataBaseUrl}/alice/cd-metadata/main/hybrid.json`;
    const sheetOverlayUrl = 'https://docs.google.com/spreadsheets/d/hybridSys42/export?format=csv&gid=42';
    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'TRUE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off',
      'FALSE,Game OST,Keiichi Okabe,NieR:Automata OST,SQEX-10589~91,Look under ナ,"¥2,500",High,Mandarake'
    ].join('\n');

    const hash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );

    const deviceA = await bootSystemClient(sys, {
      hash,
      search: '?catalog=' + encodeURIComponent(hybridJsonUrl),
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetOverlayUrl) {
          return new Response(sheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    // Device A merged 1 curated item + 1 new Sheet row (2/2), seeded KSCL-737 (TRUE in Sheet)
    assert.equal(deviceA.elements.get('progressBadge').textContent, '1 / 2');
    assert.ok(deviceA.elements.get('albumGrid').innerHTML.includes('NieR:Automata OST'));
    await deviceA.clickElement('viewModeBtn');
    assert.ok(deviceA.elements.get('albumGrid').innerHTML.includes('Priority: High'));
    assert.ok(deviceA.elements.get('albumGrid').innerHTML.includes('Mandarake'));

    // Toggle newly merged Sheet row SQEX-10589~91 -> pushes to SQLite AND batch-updates 'Osaka 2026'!A3 -> TRUE
    deviceA.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-sqex-10589-91' });
    await deviceA.settle(120);
    assert.equal(deviceA.elements.get('progressBadge').textContent, '2 / 2');
    assert.equal(batchUpdates.length, 1);
    assert.deepEqual(batchUpdates[0].data, [{ range: "'Osaka 2026'!A3", values: [['TRUE']] }]);

    // Device B (fresh sign-in, Sheet CSV unreachable offline) restores hybrid checklist from SQLite over base JSON,
    // unchecks sys-cur-akfg -> persists uncheck even if Sheets API returns 403
    const deviceB = await bootSystemClient(sys, {
      hash: await sys.completeOAuthRedirect(
        `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
        'code_alice'
      ),
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetOverlayUrl) throw new Error('Sheet CSV offline');
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    assert.equal(deviceB.elements.get('progressBadge').textContent, '1 / 1');

    forceSheetsForbidden = true;
    deviceB.triggerDocumentClick('toggle-acq', { 'data-id': 'sys-cur-akfg' });
    await deviceB.settle(120);
    assert.equal(deviceB.elements.get('progressBadge').textContent, '0 / 1');
    assert.ok(deviceB.elements.get('syncStatusPill').textContent.includes('Synced'));
    const dbRow = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    const storedChecklist = Object.values(JSON.parse(dbRow[0].state_json).catalogs)[0].checklist;
    assert.equal(storedChecklist['sys-cur-akfg'], undefined);
  });

  it('discovers Service Account bot email signed-out, loads standalone Google Sheet via UI, caches offline, and imports local .csv', async (t) => {
    const botEmail = 'cd-hunt-bot-ui@sys.iam.gserviceaccount.com';
    const sys = await startFullSystem({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: botEmail,
        private_key: '-----BEGIN PRIVATE KEY-----\nMII=\n-----END PRIVATE KEY-----'
      })
    });
    t.after(() => sys.close());

    const sheetEditUrl = 'https://docs.google.com/spreadsheets/d/standaloneSys1/edit';
    const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/standaloneSys1/export?format=csv';
    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'TRUE,Games,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,¥3000,High,Mandarake',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
    ].join('\n');

    // 1) Signed-out client fetches real Worker /api/status -> renders #sheetSyncBotBanner & copies bot email
    const signedOutClient = await bootSystemClient(sys, {
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetCsvUrl) {
          return new Response(sheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    await signedOutClient.settle(60);
    assert.equal(signedOutClient.elements.get('sheetSyncBotBanner').classList.contains('hidden'), false);
    assert.ok(signedOutClient.elements.get('sheetSyncBotText').textContent.includes(botEmail));
    await signedOutClient.clickElement('copySheetBotEmailBtn');
    assert.ok(signedOutClient.copiedTexts.includes(botEmail));

    // 2) Submit standalone Google Sheet URL via Catalog Loader UI -> uncheck CPCA-1004 -> persist localStorage
    signedOutClient.setInput('catalogUrlInput', sheetEditUrl);
    await signedOutClient.clickElement('loadCatalogUrlBtn');
    assert.equal(signedOutClient.elements.get('progressBadge').textContent, '1 / 2');
    signedOutClient.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    assert.equal(signedOutClient.elements.get('progressBadge').textContent, '0 / 2');

    // 3) Reload offline with Sheet fetch throwing -> restores offline CSV cache & preserves explicit uncheck
    const offlineSnapshot = signedOutClient.localStorage.snapshot();
    const offlineClient = await bootSystemClient(sys, {
      initialStorage: offlineSnapshot,
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetCsvUrl) throw new Error('Network offline');
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    assert.equal(offlineClient.elements.get('toast').textContent, 'Loaded cached Google Sheet (offline)');
    assert.equal(offlineClient.elements.get('progressBadge').textContent, '0 / 2');
    assert.ok(offlineClient.elements.get('albumGrid').innerHTML.includes('Sol-fa'));

    // 4) Upload local .csv file directly without network
    await offlineClient.selectLocalFile('my-list.csv', sheetCsv);
    assert.equal(offlineClient.elements.get('toast').textContent, 'Loaded local CSV: my-list.csv');
    assert.equal(offlineClient.elements.get('progressBadge').textContent, '1 / 2');
  });

  it('auto-deduplicates duplicate Google Sheet rows end-to-end across UI, SQLite, multi-row Sheet write-back, /api/share, and offline cache', async (t) => {
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
      ['Got it?', 'Aisle / Category', 'Artist / Franchise', 'Title / Release Details', 'Catalog Number', 'Filing Location & Shelf Search Advice', 'Target Used Price', 'Priority', 'Recommended Shops'],
      ['FALSE', 'Game OST', 'Capcom (カプコン)', 'Breath of Fire III OST', 'CPCA-1004', 'Look under ブ', '¥3,000', '', ''],
      ['TRUE', 'Game OST', 'Capcom', 'Breath of Fire III Original Soundtrack', 'CPCA-1004', 'Look under ブ', '¥3,500', 'High', 'Mandarake Grandchaos'],
      ['FALSE', 'J-Rock', 'Asian Kung-Fu Generation', 'Sol-fa', 'KSCL-737', 'Look under ア', '¥500', 'Medium', 'Book Off'],
      ['FALSE', 'Digital-Only', 'Hanatan', '"gradation"', 'N/A (Digital Only)', 'Digital only', '', '', 'iTunes JP'],
      ['TRUE', 'Digital-Only', 'Hanatan (花たん)', 'gradation (Digital Single)', 'N/A (Digital Only)', 'Digital only', '', 'Low', 'Mora']
    ];
    const batchUpdates = [];

    const googleMockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.dup-sys-token', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/dupSys01/values/A1:I500') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: sheetRows }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/dupSys01/values:batchUpdate') {
        const updatePayload = JSON.parse(bodyStr);
        batchUpdates.push(updatePayload);
        for (const item of updatePayload.data || []) {
          const m = String(item.range || '').match(/A(\d+)$/);
          if (m) {
            const rowIdx = Number(m[1]) - 1;
            if (sheetRows[rowIdx]) {
              sheetRows[rowIdx][0] = String(item.values[0][0]);
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalUpdatedCells: (updatePayload.data || []).length }));
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
        client_email: 'cd-hunt-dup@sys.iam.gserviceaccount.com',
        private_key: pem,
        token_uri: `${googleMockUrl}/oauth/token`
      })
    });
    t.after(() => sys.close());

    const dupSheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Game OST,Capcom (カプコン),Breath of Fire III OST,CPCA-1004,Look under ブ,"¥3,000",,',
      'TRUE,Game OST,Capcom,Breath of Fire III Original Soundtrack,CPCA-1004,Look under ブ,"¥3,500",High,Mandarake Grandchaos',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off',
      'FALSE,Digital-Only,Hanatan,"""gradation""",N/A (Digital Only),Digital only,,,iTunes JP',
      'TRUE,Digital-Only,Hanatan (花たん),gradation (Digital Single),N/A (Digital Only),Digital only,,Low,Mora'
    ].join('\n');

    const sheetEditUrl = 'https://docs.google.com/spreadsheets/d/dupSys01/edit';
    const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/dupSys01/export?format=csv';
    const hash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );

    const client = await bootSystemClient(sys, {
      hash,
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetCsvUrl) {
          return new Response(dupSheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    // Load duplicate Sheet via UI -> collapses 5 rows into 2 physical + 1 digital card, shows merge warning toast
    client.setInput('catalogUrlInput', sheetEditUrl);
    await client.clickElement('loadCatalogUrlBtn');
    assert.equal(client.elements.get('progressBadge').textContent, '1 / 2');
    const loadToast = client.elements.get('toast').textContent;
    assert.ok(loadToast.includes('Merged 2 duplicate rows'));
    assert.ok(loadToast.includes('CPCA-1004'));

    await client.clickElement('viewModeBtn');
    const gridHtml = client.elements.get('albumGrid').innerHTML;
    assert.ok(gridHtml.includes('Priority: High'));
    assert.ok(gridHtml.includes('Mandarake Grandchaos'));

    // Initial debounced load push reconciles inconsistent duplicate Sheet Row 2 (A2) to TRUE
    await client.settle(120);
    assert.equal(sheetRows[1][0], 'TRUE');
    assert.equal(sheetRows[2][0], 'TRUE');

    // Uncheck deduplicated CPCA-1004 -> batchUpdate flips BOTH duplicate rows (A2 & A3) to FALSE
    const updatesBeforeUncheck = batchUpdates.length;
    client.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    await client.settle(120);
    assert.equal(client.elements.get('progressBadge').textContent, '0 / 2');
    assert.equal(batchUpdates.length, updatesBeforeUncheck + 1);
    assert.deepEqual(batchUpdates[batchUpdates.length - 1].data, [
      { range: 'A2', values: [['FALSE']] },
      { range: 'A3', values: [['FALSE']] }
    ]);
    assert.equal(sheetRows[1][0], 'FALSE');
    assert.equal(sheetRows[2][0], 'FALSE');

    // Re-check deduplicated CPCA-1004 -> batchUpdate flips BOTH duplicate rows (A2 & A3) back to TRUE
    const updatesBeforeRecheck = batchUpdates.length;
    client.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    await client.settle(120);
    assert.equal(client.elements.get('progressBadge').textContent, '1 / 2');
    assert.equal(batchUpdates.length, updatesBeforeRecheck + 1);
    assert.deepEqual(batchUpdates[batchUpdates.length - 1].data, [
      { range: 'A2', values: [['TRUE']] },
      { range: 'A3', values: [['TRUE']] }
    ]);

    // /api/share JSON & Markdown expose only single canonical ID (no -2 duplicate IDs)
    await client.clickElement('copyAgentLinkBtn');
    const shareMdUrl = client.copiedTexts.find((txt) => txt.includes('/api/share/'));
    assert.ok(shareMdUrl);
    const mdText = await (await fetch(shareMdUrl)).text();
    assert.ok(mdText.includes('`sheet-cpca-1004`'));
    assert.equal(mdText.includes('sheet-cpca-1004-2'), false);
    const shareJson = await (await fetch(shareMdUrl.replace('?format=markdown', ''))).json();
    const shareCatalog = Object.values(shareJson.catalogs)[0];
    assert.equal(shareCatalog.checklist['sheet-cpca-1004'], true);
    assert.equal(shareCatalog.checklist['sheet-cpca-1004-2'], undefined);

    // Uncheck CPCA-1004 again and confirm SQLite + offline cached CSV reload preserve both uncheck & combined toast
    client.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    await client.settle(120);
    assert.deepEqual(batchUpdates[batchUpdates.length - 1].data, [
      { range: 'A2', values: [['FALSE']] },
      { range: 'A3', values: [['FALSE']] }
    ]);
    const dbRow = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(dbRow[0].state_json.includes('sheet-cpca-1004-2'), false);
    const storedChecklist = Object.values(JSON.parse(dbRow[0].state_json).catalogs)[0].checklist;
    assert.equal(Boolean(storedChecklist['sheet-cpca-1004']), false);

    const offlineClient = await bootSystemClient(sys, {
      initialStorage: client.localStorage.snapshot(),
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === sheetCsvUrl) throw new Error('Network offline');
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    const offlineToast = offlineClient.elements.get('toast').textContent;
    assert.ok(offlineToast.includes('Loaded cached Google Sheet (offline)'));
    assert.ok(offlineToast.includes('Merged 2 duplicate rows'));
    assert.equal(offlineClient.elements.get('progressBadge').textContent, '0 / 2');
  });

  it('syncs Backup & Restore modal imports (filtering out non-custom covers) to SQLite and restores across devices', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceA = await bootSystemClient(sys, {
      hash: hashA,
      syncDebounceMs: 10
    });
    deviceA.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await deviceA.settle(80);

    await deviceA.clickElement('backupBtn');
    assert.equal(deviceA.elements.get('backupModal').classList.contains('open'), true);
    const exportedJson = JSON.parse(deviceA.elements.get('backupTextarea').value);
    assert.deepEqual(exportedJson.checklist, {});

    deviceA.elements.get('backupTextarea').value = JSON.stringify({
      checklist: { 'sample-01': true, 'dig-01': true },
      viewMode: 'single',
      covers: {
        'sample-01': {
          selectedIndex: 1,
          variants: [
            { url: 'https://coverartarchive.org/release/x/front-500.jpg', label: '通常盤 Regular', source: 'musicbrainz', isRegular: true },
            { url: 'https://custom.example/restored-jacket.jpg', label: 'Custom Jacket', source: 'custom', isRegular: false }
          ]
        }
      }
    });
    await deviceA.clickElement('importBackupBtn');
    await deviceA.settle(100);

    assert.equal(deviceA.elements.get('progressBadge').textContent, '1 / 1');
    assert.equal(deviceA.elements.get('viewModeLabel').textContent, 'Grid View');

    const rowsA = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(rowsA.length, 1);
    const cloudCatalogA = JSON.parse(rowsA[0].state_json).catalogs[sys.samplePrefix];
    assert.deepEqual(cloudCatalogA.checklist, { 'sample-01': true, 'dig-01': true });
    assert.equal(cloudCatalogA.viewMode, 'single');
    assert.equal(cloudCatalogA.customCovers['sample-01'].variants.length, 1);
    assert.equal(cloudCatalogA.customCovers['sample-01'].variants[0].url, 'https://custom.example/restored-jacket.jpg');

    // Fresh Device B signs in and automatically restores imported checklist, viewMode, and custom cover
    const hashB = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceB = await bootSystemClient(sys, {
      hash: hashB,
      syncDebounceMs: 10
    });
    assert.equal(deviceB.elements.get('progressBadge').textContent, '1 / 1');
    assert.equal(deviceB.elements.get('viewModeLabel').textContent, 'Grid View');
    assert.ok(deviceB.elements.get('albumGrid').innerHTML.includes('https://custom.example/restored-jacket.jpg'));
  });

  it('syncs digital banner dismiss/restore, keeps signed-out edits local until re-sign-in merge, and recovers from mid-session 401 session expiry', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceA = await bootSystemClient(sys, {
      hash: hashA,
      syncDebounceMs: 10
    });
    deviceA.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await deviceA.settle(80);
    deviceA.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await deviceA.clickElement('dismissNoteBtn');
    await deviceA.settle(100);

    // Device B sees dismissed digital banner synced via SQLite, then restores it
    const hashB = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceB = await bootSystemClient(sys, {
      hash: hashB,
      syncDebounceMs: 10
    });
    assert.equal(deviceB.elements.get('digitalNoteBanner').classList.contains('hidden'), true);
    assert.equal(deviceB.elements.get('compactCountBar').classList.contains('hidden'), false);
    await deviceB.clickElement('restoreNoteBtn');
    await deviceB.settle(100);

    // Device A reloads with its old snapshot -> receives newer restored note state from SQLite
    const deviceAReloaded = await bootSystemClient(sys, {
      initialStorage: deviceA.localStorage.snapshot(),
      syncDebounceMs: 10
    });
    assert.equal(deviceAReloaded.elements.get('digitalNoteBanner').classList.contains('hidden'), false);
    assert.equal(deviceAReloaded.elements.get('compactCountBar').classList.contains('hidden'), true);

    // Sign out keeps local progress and blocks cloud PUTs until signing back in
    await deviceAReloaded.clickElement('githubSignOutBtn');
    assert.equal(deviceAReloaded.elements.get('copyAgentLinkBtn').classList.contains('hidden'), true);
    assert.equal(deviceAReloaded.elements.get('githubSignOutBtn').classList.contains('hidden'), true);
    assert.equal(deviceAReloaded.elements.get('githubAuthBtn').classList.contains('hidden'), false);
    assert.equal(deviceAReloaded.elements.get('progressBadge').textContent, '1 / 1');
    assert.equal(deviceAReloaded.localStorage.getItem('cd_hunt_sync_token_v1'), null);

    const putsWhileSignedIn = deviceAReloaded.requestLog.filter((r) => r.method === 'PUT').length;
    deviceAReloaded.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    await deviceAReloaded.settle(80);
    assert.equal(deviceAReloaded.requestLog.filter((r) => r.method === 'PUT').length, putsWhileSignedIn);

    // Re-sign-in backfills local signed-out dig-01 edit to SQLite
    await deviceAReloaded.clickElement('githubAuthBtn');
    assert.equal(deviceAReloaded.locationNavigations.length, 1);
    const reAuthHash = await sys.completeOAuthRedirect(deviceAReloaded.locationNavigations[0], 'code_alice');
    const deviceAReAuth = await bootSystemClient(sys, {
      initialStorage: deviceAReloaded.localStorage.snapshot(),
      hash: reAuthHash,
      syncDebounceMs: 10
    });
    await deviceAReAuth.settle(100);

    const dbRowsReAuth = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.deepEqual(
      JSON.parse(dbRowsReAuth[0].state_json).catalogs[sys.samplePrefix].checklist,
      { 'sample-01': true, 'dig-01': true }
    );

    // Mid-session JWT secret rotation triggers 401 -> clears session gracefully while keeping local edit
    sys.workerEnv.JWT_SECRET = 'rotated-secret-invalidates-active-session-jwt';
    deviceAReAuth.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await deviceAReAuth.settle(100);

    assert.equal(deviceAReAuth.requestLog.some((r) => r.method === 'PUT' && r.status === 401), true);
    assert.ok(deviceAReAuth.elements.get('syncStatusPill').textContent.includes('Session expired'));
    assert.ok(deviceAReAuth.elements.get('toast').textContent.includes('GitHub sync session expired'));
    assert.equal(deviceAReAuth.elements.get('copyAgentLinkBtn').classList.contains('hidden'), true);
    assert.equal(deviceAReAuth.localStorage.getItem('cd_hunt_sync_token_v1'), null);
    assert.equal(deviceAReAuth.elements.get('progressBadge').textContent, '0 / 1');
  });

  it('isolates multiple catalogs (JSON preset, standalone Google Sheet, and local file) across cloud sync and /api/share', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const multiSheetEditUrl = 'https://docs.google.com/spreadsheets/d/multiCatSheet1/edit';
    const multiSheetCsvUrl = 'https://docs.google.com/spreadsheets/d/multiCatSheet1/export?format=csv';
    const multiSheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Games,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,¥3000,High,Mandarake',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
    ].join('\n');

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceA = await bootSystemClient(sys, {
      hash: hashA,
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === multiSheetCsvUrl) {
          return new Response(multiSheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    // Catalog 1: JSON preset with sample-01 checked
    deviceA.triggerDocumentClick('load-preset', { 'data-preset-url': sys.sampleCatalogUrl });
    await deviceA.settle(80);
    deviceA.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await deviceA.settle(100);

    // Switch to Catalog 2: standalone Google Sheet with sheet-cpca-1004 checked
    await deviceA.clickElement('openCatalogLoaderBtn');
    deviceA.setInput('catalogUrlInput', multiSheetEditUrl);
    await deviceA.clickElement('loadCatalogUrlBtn');
    assert.equal(deviceA.elements.get('progressBadge').textContent, '0 / 2');
    deviceA.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    await deviceA.settle(120);

    const dbRows = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    const storedState = JSON.parse(dbRows[0].state_json);
    assert.equal(storedState.activeCatalogUrl, multiSheetCsvUrl);
    assert.equal(Object.keys(storedState.catalogs).length, 2);

    // /api/share Markdown surfaces both isolated catalogs cleanly
    await deviceA.clickElement('copyAgentLinkBtn');
    const shareMdUrl = deviceA.copiedTexts.find((txt) => txt.includes('/api/share/'));
    assert.ok(shareMdUrl);
    const shareMd = await (await fetch(shareMdUrl)).text();
    assert.ok(shareMd.includes('`sample-01`'));
    assert.ok(shareMd.includes('`sheet-cpca-1004`'));

    // Fresh Device B boots straight into active Catalog 2 (1 / 2), then switches back to Catalog 1 (1 / 1)
    const hashB = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const deviceB = await bootSystemClient(sys, {
      hash: hashB,
      syncDebounceMs: 10,
      coverMocks: async (url) => {
        if (url === multiSheetCsvUrl) {
          return new Response(multiSheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    assert.equal(deviceB.elements.get('progressBadge').textContent, '1 / 2');

    await deviceB.clickElement('openCatalogLoaderBtn');
    deviceB.setInput('catalogUrlInput', sys.sampleCatalogUrl);
    await deviceB.clickElement('loadCatalogUrlBtn');
    assert.equal(deviceB.elements.get('progressBadge').textContent, '1 / 1');

    // Loading a local file clears active remote URL & hides Share Link while leaving both cloud catalogs intact in SQLite
    await deviceB.selectLocalFile('offline-local.json', sys.sampleCatalog);
    assert.equal(deviceB.localStorage.getItem('cd_hunt_catalog_url_v1'), null);
    await deviceB.clickElement('openCatalogLoaderBtn');
    assert.equal(deviceB.elements.get('copyShareLinkBtn').classList.contains('hidden'), true);

    const dbRowsAfterLocal = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(Object.keys(JSON.parse(dbRowsAfterLocal[0].state_json).catalogs).length, 2);
  });

  it('resolves real-world Google Sheet covers (MusicBrainz range fallback & normalized iTunes fallback) with zero SQLite writes and syncs fullwidth-tilde write-back', async (t) => {
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
      ['Got it?', 'Aisle / Category', 'Artist / Franchise', 'Title / Release Details', 'Catalog Number', 'Filing Location & Shelf Search Advice', 'Target Used Price', 'Priority', 'Recommended Shops'],
      ['FALSE', 'Anime', 'Shiyui (シユイ)', '"ホロウ" (Hollow) (Demon Lord 2099 OP)', 'AICL-4670～4671', 'Look under シ', '¥2,400', 'Medium', 'Animate'],
      ['FALSE', 'Seiyuu', 'Rico Sasaki (佐々木李子)', 'スタート! (Start!) (Artist Editions ONLY for Track 4 "フレンドパスワード" — Skip AKCY-58073)', 'AKCY-58075 (Artist CD+Photobook)', 'Look under サ', '¥1,200', 'High', 'Animate']
    ];
    const batchUpdates = [];

    const googleMockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.real-cover-sys', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/realCoverSys1/values/A1:I500') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: sheetRows }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/v4/spreadsheets/realCoverSys1/values:batchUpdate') {
        const updatePayload = JSON.parse(bodyStr);
        batchUpdates.push(updatePayload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalUpdatedCells: (updatePayload.data || []).length }));
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
        client_email: 'cd-hunt-covers@sys.iam.gserviceaccount.com',
        private_key: pem,
        token_uri: `${googleMockUrl}/oauth/token`
      })
    });
    t.after(() => sys.close());

    class MockVerifiedImage {
      set src(val) {
        this._src = val;
        setTimeout(() => {
          this.naturalWidth = 600;
          this.naturalHeight = 600;
          if (typeof this.onload === 'function') this.onload();
        }, 1);
      }
    }

    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Anime,Shiyui (シユイ),"""ホロウ"" (Hollow) (Demon Lord 2099 OP)",AICL-4670～4671,Look under シ,"¥2,400",Medium,Animate',
      'FALSE,Seiyuu,Rico Sasaki (佐々木李子),"スタート! (Start!) (Artist Editions ONLY for Track 4 ""フレンドパスワード"" — Skip AKCY-58073)",AKCY-58075 (Artist CD+Photobook),Look under サ,"¥1,200",High,Animate'
    ].join('\n');
    const sheetEditUrl = 'https://docs.google.com/spreadsheets/d/realCoverSys1/edit';
    const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/realCoverSys1/export?format=csv';

    const hash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const client = await bootSystemClient(sys, {
      hash,
      syncDebounceMs: 10,
      imageImpl: MockVerifiedImage,
      coverMocks: async (url) => {
        if (url === sheetCsvUrl) {
          return new Response(sheetCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        if (url.includes('musicbrainz.org')) {
          if (url.includes('catno:AICL-4670~4671')) {
            return new Response(JSON.stringify({ releases: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (url.includes('catno:AICL-4670')) {
            return new Response(JSON.stringify({ releases: [{ id: 'mb-hollow-sys' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ releases: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('itunes.apple.com')) {
          if (url.includes(encodeURIComponent('佐々木李子 スタート!'))) {
            return new Response(
              JSON.stringify({
                results: [
                  {
                    trackName: 'スタート!',
                    collectionName: 'スタート! - Single',
                    artistName: '佐々木 李子',
                    artworkUrl100: 'https://img.example/rico/100x100bb.jpg'
                  }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    client.setInput('catalogUrlInput', sheetEditUrl);
    await client.clickElement('loadCatalogUrlBtn');
    await client.settle(120);
    const baselineWrites = sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count;

    await client.triggerIntersection('sheet-aicl-4670-4671');
    await client.triggerIntersection('sheet-akcy-58075');
    await client.settle(120);

    assert.ok(client.elements.get('art-slot-sheet-aicl-4670-4671').innerHTML.includes('https://coverartarchive.org/release/mb-hollow-sys/front-500'));
    assert.ok(client.elements.get('art-slot-sheet-akcy-58075').innerHTML.includes('https://img.example/rico/600x600bb.jpg'));
    assert.equal(sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count, baselineWrites);

    client.triggerDocumentClick('open-lb', { 'data-lb-idx': '1' });
    const ricoHref = decodeURIComponent(client.elements.get('lbGoogleSearchLink').href);
    assert.ok(ricoHref.includes('AKCY-58075 Rico Sasaki スタート! 通常盤 CD'));
    assert.equal(ricoHref.includes('AKCY-58073'), false);

    const beforeToggle = batchUpdates.length;
    client.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-aicl-4670-4671' });
    await client.settle(120);
    assert.equal(batchUpdates.length, beforeToggle + 1);
    assert.deepEqual(batchUpdates[batchUpdates.length - 1].data, [{ range: 'A2', values: [['TRUE']] }]);
  });

  function makeDeviceIdb(backing) {
    const state = backing || { stores: new Map() };
    function makeReq(executor) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try { executor(req); } catch (err) { req.error = err; if (req.onerror) req.onerror({ target: req }); }
      });
      return req;
    }
    return {
      open() {
        const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => {
          const dbObj = {
            objectStoreNames: { contains: (s) => state.stores.has(s) },
            createObjectStore: (s, opts) => {
              if (!state.stores.has(s)) state.stores.set(s, { keyPath: opts.keyPath, rows: new Map() });
              return { indexNames: { contains: () => true }, createIndex: () => {} };
            },
            transaction: (storeName) => {
              const storeMeta = state.stores.get(storeName);
              const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
              const storeApi = {
                get: (k) => makeReq((r) => { r.result = storeMeta.rows.has(k) ? JSON.parse(JSON.stringify(storeMeta.rows.get(k))) : undefined; if (r.onsuccess) r.onsuccess({ target: r }); }),
                put: (v) => makeReq((r) => { storeMeta.rows.set(v[storeMeta.keyPath], JSON.parse(JSON.stringify(v))); r.result = v[storeMeta.keyPath]; if (r.onsuccess) r.onsuccess({ target: r }); }),
                delete: (k) => makeReq((r) => { storeMeta.rows.delete(k); if (r.onsuccess) r.onsuccess({ target: r }); }),
                getAll: () => makeReq((r) => { r.result = Array.from(storeMeta.rows.values()).map((v) => JSON.parse(JSON.stringify(v))); if (r.onsuccess) r.onsuccess({ target: r }); }),
                clear: () => makeReq((r) => { storeMeta.rows.clear(); if (r.onsuccess) r.onsuccess({ target: r }); })
              };
              tx.objectStore = () => storeApi;
              setTimeout(() => { if (tx.oncomplete) tx.oncomplete({ target: tx }); }, 0);
              return tx;
            }
          };
          req.result = dbObj;
          req.transaction = { objectStore: () => ({ indexNames: { contains: () => true }, createIndex: () => {} }) };
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: dbObj } });
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      }
    };
  }

  it('isolates Hunt track_cache & manual_tracks from SQLite user_state while syncing Owned Collection tracks incrementally via /api/collection/batch', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const aliceHash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const backing = { stores: new Map() };
    const sampleUrl = 'https://raw.githubusercontent.com/alice/cd-metadata/main/sample.json';
    const client = await bootSystemClient(sys, {
      hash: aliceHash,
      search: '?catalog=' + encodeURIComponent(sampleUrl),
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      coverMocks: async (url) => {
        if (url.includes('musicbrainz.org/ws/2/release/?query=catno%3AKSCL-737')) {
          return new Response(
            JSON.stringify({ releases: [{ id: '55555555-5555-4555-8555-555555555555', title: 'Sol-fa', status: 'Official', 'label-info': [{ 'catalog-number': 'KSCL-737' }] }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('musicbrainz.org/ws/2/release/55555555-5555-4555-8555-555555555555')) {
          return new Response(
            JSON.stringify({
              id: '55555555-5555-4555-8555-555555555555',
              title: 'Sol-fa',
              'label-info': [{ 'catalog-number': 'KSCL-737' }],
              media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Hunt Only MB Track', length: 200000 }] }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    await client.settle(80);
    const putBaseline = client.requestLog.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/state')).length;
    const writesBaseline = sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count;
    const userStateBefore = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    const stateJsonBefore = userStateBefore[0] ? userStateBefore[0].state_json : null;

    // Fetch MusicBrainz tracks & save manual track override in Hunt mode -> strictly local IndexedDB, ZERO PUT /api/state
    await client.clickElement('openCrateFlipBtn');
    await client.clickElement('lbTracksToggleBtn');
    await client.settle(80);
    assert.ok(client.elements.get('lbTracksList').innerHTML.includes('Hunt Only MB Track'));

    await client.clickElement('lbEditTracksBtn');
    client.setInput('lbTrackEditorInput', '01. Strictly Local Hunt Override (3:21)');
    await client.clickElement('saveManualTracksBtn');
    await client.settle(80);

    assert.equal(client.requestLog.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/state')).length, putBaseline);
    assert.equal(sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count, writesBaseline);
    const userStateAfterHuntTracks = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(userStateAfterHuntTracks[0] ? userStateAfterHuntTracks[0].state_json : null, stateJsonBefore);
    assert.equal(backing.stores.get('manual_tracks').rows.size, 1);

    // Switch to Collection mode and add an owned release with tracks -> syncs via POST /api/collection/batch into SQLite owned_releases without touching user_state
    await client.clickElement('modeCollectionBtn');
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Collection Artist');
    client.setInput('rfTitle', 'Collection Album');
    client.setInput('rfCatNo', 'COL-9001');
    client.setInput('rfCategory', 'Rock');
    client.setInput('rfTracksInput', '01. Synced Collection Track (4:05)');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(120);

    assert.equal(client.requestLog.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/state')).length, putBaseline);
    assert.equal(client.requestLog.filter((r) => r.method === 'POST' && r.url.endsWith('/api/collection/batch')).length, 1);
    const userStateAfterCol = sys.db.queryRaw("SELECT state_json FROM user_state WHERE github_id = '1001'");
    assert.equal(userStateAfterCol[0] ? userStateAfterCol[0].state_json : null, stateJsonBefore);

    const ownedRows = sys.db.queryRaw("SELECT release_id, data_json, sync_seq FROM owned_releases WHERE github_id = '1001'");
    assert.equal(ownedRows.length, 1);
    assert.equal(JSON.parse(ownedRows[0].data_json).tracks[0].title, 'Synced Collection Track');
  });

  it('converges two offline devices across delayed offline scans (older clientUpdatedAt), LWW conflicts, and tombstones via SQLite sync_seq', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const hashB = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );

    const backingA = { stores: new Map() };
    const backingB = { stores: new Map() };
    const offlineRefA = { offline: false };
    const offlineRefB = { offline: false };

    // 1) Device A adds Release 1 and syncs (sync_seq = 1)
    const devA = await bootSystemClient(sys, {
      hash: hashA,
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backingA),
      offlineRef: offlineRefA
    });
    await devA.clickElement('addReleaseBtn');
    devA.setInput('rfArtist', 'Shared Artist');
    devA.setInput('rfTitle', 'Original Release 1');
    devA.setInput('rfCatNo', 'DEV-0001');
    devA.setInput('rfCategory', 'OST');
    await devA.clickElement('saveReleaseFormBtn');
    await devA.settle(120);

    // 2) Device B comes online in Collection mode and pulls Release 1 (lastSyncSeq = 1)
    const devB = await bootSystemClient(sys, {
      hash: hashB,
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backingB),
      offlineRef: offlineRefB
    });
    await devB.settle(100);
    assert.equal(devB.elements.get('progressBadge').textContent, '1 release · 0 tracks');

    // 3) Both devices go offline
    offlineRefA.offline = true;
    offlineRefB.offline = true;

    // Seed Device B offline mutations:
    // - Delayed scan (Release 2) with an OLDER clientUpdatedAt=1000
    // - Stale edit to Release 1 with an OLDER clientUpdatedAt=1200
    const dbModLocal = require('../js/db.js');
    const clientDbA = dbModLocal.createDbClient({ indexedDBImpl: makeDeviceIdb(backingA) });
    const clientDbB = dbModLocal.createDbClient({ indexedDBImpl: makeDeviceIdb(backingB) });
    const syncModLocal = require('../js/sync.js');

    const r1FromB = await clientDbB.getOwnedRelease('own-dev-0001');
    await clientDbB.putOwnedRelease({
      id: 'own-dev-0002',
      artist: 'Device B Offline Artist',
      title: 'Delayed Offline Scan Release 2',
      category: 'Rock',
      catNo: 'OFF-0002',
      createdAt: 1000,
      clientUpdatedAt: 1000,
      syncSeq: null,
      deletedAt: null,
      dirty: 1
    });
    await clientDbB.putOwnedRelease(
      Object.assign({}, r1FromB, {
        title: 'Stale Device B Title (Lost LWW)',
        clientUpdatedAt: 1200,
        dirty: 1
      })
    );

    // Device A offline mutations with NEWER clientUpdatedAt values:
    const r1FromA = await clientDbA.getOwnedRelease('own-dev-0001');
    await clientDbA.putOwnedRelease(
      Object.assign({}, r1FromA, {
        title: 'Winner Device A Title (Newer)',
        clientUpdatedAt: Date.now() + 10000,
        dirty: 1
      })
    );
    await clientDbA.putOwnedRelease({
      id: 'own-dev-0003',
      artist: 'Device A Temp',
      title: 'Release 3 To Soft-Delete',
      category: 'OST',
      catNo: 'TMP-0003',
      createdAt: Date.now() + 11000,
      clientUpdatedAt: Date.now() + 11000,
      syncSeq: null,
      deletedAt: null,
      dirty: 1
    });

    // 4) Device A reconnects first and syncs -> SQLite has R1 (Winner) & R3
    offlineRefA.offline = false;
    const tokA = devA.localStorage.getItem('cd_hunt_sync_token_v1');
    const syncResA1 = await syncModLocal.syncOwnedCollection(clientDbA, sys.workerBaseUrl, tokA, async (u, init) => {
      const headers = Object.assign({}, init && init.headers ? init.headers : {}, { Origin: 'https://dopingus-build.github.io' });
      return fetch(u, Object.assign({}, init, { headers }));
    });
    assert.equal(syncResA1.ok, true);
    assert.equal(syncResA1.pushedCount, 2);

    // 5) Device B reconnects -> pushes delayed R2 (t=1000 accepted with syncSeq=4!), LWW resolves R1 to Winner, and pulls R3
    offlineRefB.offline = false;
    const tokB = devB.localStorage.getItem('cd_hunt_sync_token_v1');
    const syncResB1 = await syncModLocal.syncOwnedCollection(clientDbB, sys.workerBaseUrl, tokB, async (u, init) => {
      const headers = Object.assign({}, init && init.headers ? init.headers : {}, { Origin: 'https://dopingus-build.github.io' });
      return fetch(u, Object.assign({}, init, { headers }));
    });
    assert.equal(syncResB1.ok, true);
    assert.equal(syncResB1.pushedCount, 1); // Delayed R2 (already saw R1 newer during pull, so R2 was pushed and got syncSeq=4!)
    assert.equal((await clientDbB.getOwnedRelease('own-dev-0001')).title, 'Winner Device A Title (Newer)');

    // 6) Device A soft-deletes R3 and syncs -> pulls Device B's delayed R2 (despite t=1000 < Device A's clock!) and removes R3 on Device B
    const r3OnA = await clientDbA.getOwnedRelease('own-dev-0003');
    const delTs = Date.now() + 20000;
    await clientDbA.putOwnedRelease(
      Object.assign({}, r3OnA, {
        deletedAt: delTs,
        clientUpdatedAt: delTs,
        dirty: 1
      })
    );
    const syncResA2 = await syncModLocal.syncOwnedCollection(clientDbA, sys.workerBaseUrl, tokA, async (u, init) => {
      const headers = Object.assign({}, init && init.headers ? init.headers : {}, { Origin: 'https://dopingus-build.github.io' });
      return fetch(u, Object.assign({}, init, { headers }));
    });
    assert.equal(syncResA2.ok, true);

    const syncResB2 = await syncModLocal.syncOwnedCollection(clientDbB, sys.workerBaseUrl, tokB, async (u, init) => {
      const headers = Object.assign({}, init && init.headers ? init.headers : {}, { Origin: 'https://dopingus-build.github.io' });
      return fetch(u, Object.assign({}, init, { headers }));
    });
    assert.equal(syncResB2.ok, true);

    // Both devices now have zero dirty items and identical active releases { own-dev-0001, own-dev-0002 }
    assert.equal((await clientDbA.getDirtyOwnedReleases()).length, 0);
    assert.equal((await clientDbB.getDirtyOwnedReleases()).length, 0);

    const activeA = (await clientDbA.getAllOwnedReleases()).map((r) => `${r.id}:${r.title}`).sort();
    const activeB = (await clientDbB.getAllOwnedReleases()).map((r) => `${r.id}:${r.title}`).sort();
    assert.deepEqual(activeA, [
      'own-dev-0001:Winner Device A Title (Newer)',
      'own-dev-0002:Delayed Offline Scan Release 2'
    ]);
    assert.deepEqual(activeB, activeA);
  });

  it('syncs Owned custom covers across devices via visibilitychange keepalive while stripping covers from /api/share?include=collection', async (t) => {
    const sys = await startFullSystem();
    t.after(() => sys.close());

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const hashB = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );

    const backingA = { stores: new Map() };
    const backingB = { stores: new Map() };
    const devA = await bootSystemClient(sys, {
      hash: hashA,
      search: '?mode=collection',
      syncDebounceMs: 4000,
      indexedDBImpl: makeDeviceIdb(backingA)
    });

    await devA.clickElement('addReleaseBtn');
    devA.setInput('rfArtist', 'Cover Sync Artist');
    devA.setInput('rfTitle', 'Custom Jacket Release');
    devA.setInput('rfCatNo', 'COV-1001');
    devA.setInput('rfCategory', 'Game');
    await devA.clickElement('saveReleaseFormBtn');

    await devA.clickElement('openCrateFlipBtn');
    await devA.clickElement('lbToggleCustomBtn');
    devA.setInput('customCoverInput', 'https://custom.example/owned-jacket.jpg');
    devA.setInput('customCoverLabel', 'Custom Owned Obi');
    await devA.clickElement('saveCustomCoverBtn');
    await devA.clickElement('closeLightboxBtn');

    // Immediate visibilitychange('hidden') must flush via keepalive: true before 4s debounce
    await devA.triggerVisibilityChange('hidden');
    await devA.settle(80);

    const batchLogs = devA.requestLog.filter((r) => r.method === 'POST' && r.url.endsWith('/api/collection/batch'));
    assert.equal(batchLogs.length, 1);
    assert.equal(batchLogs[0].keepalive, true);
    assert.equal(batchLogs[0].status, 200);

    const sqlRows = sys.db.queryRaw("SELECT data_json FROM owned_releases WHERE github_id = '1001' AND release_id = 'own-cov-1001'");
    assert.equal(sqlRows.length, 1);
    const parsedSql = JSON.parse(sqlRows[0].data_json);
    assert.equal(parsedSql.customCovers.variants[0].url, 'https://custom.example/owned-jacket.jpg');
    assert.equal(parsedSql.selectedVariant.url, 'https://custom.example/owned-jacket.jpg');

    // Agent Link copies &include=collection URL; /api/share strips customCovers & selectedVariant
    await devA.clickElement('copyAgentLinkBtn');
    const shareMdUrl = devA.copiedTexts.find((u) => u.includes('/api/share/'));
    assert.ok(shareMdUrl && shareMdUrl.endsWith('?format=markdown&include=collection'));

    const shareMdRes = await fetch(shareMdUrl, { headers: { Origin: 'https://agent.example' } });
    assert.equal(shareMdRes.status, 200);
    const shareMdText = await shareMdRes.text();
    assert.ok(shareMdText.includes('COV-1001'));
    assert.equal(shareMdText.includes('owned-jacket.jpg'), false);

    const shareJsonUrl = shareMdUrl.replace('?format=markdown&include=collection', '?include=collection');
    const shareJson = await (await fetch(shareJsonUrl, { headers: { Origin: 'https://agent.example' } })).json();
    assert.equal(shareJson.collection.count, 1);
    assert.equal(shareJson.collection.items[0].catNo, 'COV-1001');
    assert.equal(shareJson.collection.items[0].customCovers, undefined);
    assert.equal(shareJson.collection.items[0].selectedVariant, undefined);

    // Device B comes online and receives the custom cover cleanly
    const devB = await bootSystemClient(sys, {
      hash: hashB,
      search: '?mode=collection',
      syncDebounceMs: 20,
      indexedDBImpl: makeDeviceIdb(backingB)
    });
    await devB.settle(100);

    const dbModLocal = require('../js/db.js');
    const clientDbB = dbModLocal.createDbClient({ indexedDBImpl: makeDeviceIdb(backingB) });
    const devBCopy = await clientDbB.getOwnedRelease('own-cov-1001');
    assert.equal(devBCopy.customCovers.variants[0].url, 'https://custom.example/owned-jacket.jpg');
    assert.equal(devBCopy.selectedVariant.url, 'https://custom.example/owned-jacket.jpg');
  });

  it('preserves dirty Owned releases across 429 rate limits, 503 PAUSE_SYNC, and offline drops, then converges cleanly on recovery', async (t) => {
    const sys = await startFullSystem({ USER_HOURLY_WRITE_LIMIT: '1' });
    t.after(() => sys.close());

    const hashA = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const backing = { stores: new Map() };
    const offlineRef = { offline: false };
    const dbModLocal = require('../js/db.js');
    const clientDb = dbModLocal.createDbClient({ indexedDBImpl: makeDeviceIdb(backing) });

    let client = await bootSystemClient(sys, {
      hash: hashA,
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      offlineRef
    });

    // 1) Release 1 succeeds (consumes USER_HOURLY_WRITE_LIMIT = 1)
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Recovery Artist');
    client.setInput('rfTitle', 'Release 1');
    client.setInput('rfCatNo', 'REC-001');
    client.setInput('rfCategory', 'Rock');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(120);
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 1);

    // 2) Release 2 hits 429 hourly cap -> stays dirty: 1 locally without loss
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Recovery Artist');
    client.setInput('rfTitle', 'Release 2');
    client.setInput('rfCatNo', 'REC-002');
    client.setInput('rfCategory', 'Rock');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(120);
    assert.ok(client.elements.get('syncStatusPill').textContent.includes('Rate limited — saved locally'));
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 1);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 1);

    // Raise cap & reboot/reload client -> flushes REC-002 cleanly
    sys.workerEnv.USER_HOURLY_WRITE_LIMIT = '20';
    client = await bootSystemClient(sys, {
      initialStorage: client.localStorage.snapshot(),
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      offlineRef
    });
    await client.settle(120);
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 2);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 0);

    // 3) PAUSE_SYNC -> 503 preserves REC-003 dirty locally -> unpause & reload converges
    sys.workerEnv.PAUSE_SYNC = 'true';
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Recovery Artist');
    client.setInput('rfTitle', 'Release 3');
    client.setInput('rfCatNo', 'REC-003');
    client.setInput('rfCategory', 'Rock');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(120);
    assert.ok(client.elements.get('syncStatusPill').textContent.includes('Paused until 00:00 UTC'));
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 2);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 1);

    sys.workerEnv.PAUSE_SYNC = 'false';
    client = await bootSystemClient(sys, {
      initialStorage: client.localStorage.snapshot(),
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      offlineRef
    });
    await client.settle(120);
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 3);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 0);

    // 4) Network drops offline -> preserves REC-004 dirty locally -> reconnect & reload converges
    offlineRef.offline = true;
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Recovery Artist');
    client.setInput('rfTitle', 'Release 4');
    client.setInput('rfCatNo', 'REC-004');
    client.setInput('rfCategory', 'Rock');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(120);
    assert.ok(client.elements.get('syncStatusPill').textContent.includes('Offline — saved locally'));
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 3);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 1);

    offlineRef.offline = false;
    client = await bootSystemClient(sys, {
      initialStorage: client.localStorage.snapshot(),
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      offlineRef
    });
    await client.settle(120);
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 4);
    assert.equal((await clientDb.getDirtyOwnedReleases()).length, 0);
  });

  it('executes full-stack Owned Google Sheet two-way sync (#pushOwnedSheetBtn -> SQLite -> Sheets API #gid= -> #importOwnedSheetBtn on Device B)', async (t) => {
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
    const saBotEmail = 'owned-sheet-sync@sys.iam.gserviceaccount.com';

    const clearCalls = [];
    let storedSheetRows = [];
    const googleMockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST' && reqUrl.pathname === '/oauth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.owned-sys-token', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/v4/spreadsheets/ownedSysSheet') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sheets: [{ properties: { sheetId: 77, title: 'My Owned CDs' } }] }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname.endsWith(':clear')) {
        clearCalls.push(decodeURIComponent(reqUrl.pathname));
        storedSheetRows = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      if (req.method === 'PUT' && reqUrl.pathname.includes('/v4/spreadsheets/ownedSysSheet/values/')) {
        const body = JSON.parse(bodyStr);
        storedSheetRows = body.values || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updatedRows: Math.max(0, storedSheetRows.length - 1) }));
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
        client_email: saBotEmail,
        private_key: pem,
        token_uri: `${googleMockUrl}/oauth/token`
      })
    });
    t.after(() => sys.close());

    const aliceHash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );
    const backingA = { stores: new Map() };
    const devA = await bootSystemClient(sys, {
      hash: aliceHash,
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backingA)
    });

    // Add 2 owned releases with full metadata on Device A
    await devA.clickElement('addReleaseBtn');
    devA.setInput('rfArtist', 'yama');
    devA.setInput('rfArtistJa', 'ヤマ');
    devA.setInput('rfTitle', 'slash');
    devA.setInput('rfCategory', 'Anime');
    devA.setInput('rfCatNo', 'SRCL-12539');
    devA.setInput('rfBarcode', '4547366611397');
    devA.setInput('rfPurchasePrice', '¥1,200');
    devA.setInput('rfPurchaseShop', 'Book Off, Shibuya');
    devA.setInput('rfPurchaseDate', '2026-11-28');
    devA.setInput('rfNotes', 'First press with obi');
    devA.setInput('rfTracksInput', '1. slash (3:30)');
    await devA.clickElement('saveReleaseFormBtn');

    await devA.clickElement('addReleaseBtn');
    devA.setInput('rfArtist', 'Capcom');
    devA.setInput('rfTitle', 'Breath of Fire III OST');
    devA.setInput('rfCategory', 'Game');
    devA.setInput('rfCatNo', 'CPCA-1004');
    devA.setInput('rfPurchasePrice', '¥3,000');
    devA.setInput('rfPurchaseShop', 'Mandarake');
    devA.setInput('rfNotes', 'Mint');
    await devA.clickElement('saveReleaseFormBtn');

    const ownedSheetUrl = 'https://docs.google.com/spreadsheets/d/ownedSysSheet/edit#gid=77';
    await devA.clickElement('collectionBackupBtn');
    await devA.settle(80);
    assert.equal(devA.elements.get('ownedSheetBotBanner').classList.contains('hidden'), false);
    assert.ok(devA.elements.get('ownedSheetBotBanner').textContent.includes(saBotEmail));

    devA.setInput('ownedSheetUrlInput', ownedSheetUrl);
    await devA.clickElement('pushOwnedSheetBtn');
    await devA.settle(120);

    assert.ok(devA.elements.get('toast').textContent.includes('Synced 2 owned row(s) to Google Sheet'));
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 2);
    assert.equal(clearCalls.length, 1);
    assert.ok(clearCalls[0].includes("'My Owned CDs'!A1:K5000"));
    assert.equal(storedSheetRows.length, 3);
    assert.equal(storedSheetRows[0].length, 11);

    function csvCell(v) {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    const serializedCsv = storedSheetRows.map((row) => row.map(csvCell).join(',')).join('\n');

    // Device B (signed-out, clean IndexedDB) imports the exact CSV written to the mock Google Sheet
    const backingB = { stores: new Map() };
    const dbModLocal = require('../js/db.js');
    const devBDb = dbModLocal.createDbClient({ indexedDBImpl: makeDeviceIdb(backingB) });
    const devB = await bootSystemClient(sys, {
      search: '?mode=collection',
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backingB),
      coverMocks: async (url) => {
        if (url === 'https://docs.google.com/spreadsheets/d/ownedSysSheet/export?format=csv&gid=77') {
          return new Response(serializedCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    await devB.clickElement('collectionBackupBtn');
    devB.setInput('ownedSheetUrlInput', ownedSheetUrl);
    await devB.clickElement('importOwnedSheetBtn');
    await devB.settle(80);
    assert.ok(devB.elements.get('toast').textContent.includes('Imported Owned Sheet: +2 added, 0 merged'));

    const devBItems = await devBDb.getAllOwnedReleases();
    assert.equal(devBItems.length, 2);
    const yamaB = devBItems.find((x) => x.catNo === 'SRCL-12539');
    assert.ok(yamaB);
    assert.equal(yamaB.artist, 'yama');
    assert.equal(yamaB.artistJa, 'ヤマ');
    assert.equal(yamaB.barcode, '4547366611397');
    assert.equal(yamaB.purchasePrice, '¥1,200');
    assert.equal(yamaB.purchaseShop, 'Book Off, Shibuya');
    assert.equal(yamaB.purchaseDate, '2026-11-28');
    assert.equal(yamaB.notes, 'First press with obi');

    // Re-importing same Sheet CSV is idempotent (0 added, 2 merged)
    await devB.clickElement('collectionBackupBtn');
    devB.setInput('ownedSheetUrlInput', ownedSheetUrl);
    await devB.clickElement('importOwnedSheetBtn');
    await devB.settle(80);
    assert.ok(devB.elements.get('toast').textContent.includes('Imported Owned Sheet: +0 added, 2 merged'));
  });

  it('isolates signed-in Phase 3a Scanner runtime, download, scan, and Wipe from cloud sync (/api/state & /api/collection) while syncing explicit Add-to-Collection saves', async (t) => {
    const { buildEngineShellWasmBytes, buildScannerManifest } = await import('../scripts/build-scanner-assets.mjs');
    const wasmBytes = buildEngineShellWasmBytes();
    const manifest = buildScannerManifest(wasmBytes);
    const scannerWorkerMod = require('../js/scanner-worker.js');

    const sys = await startFullSystem();
    t.after(() => sys.close());

    const aliceHash = await sys.completeOAuthRedirect(
      `${sys.workerBaseUrl}/auth/login?redirect=${encodeURIComponent('https://dopingus-build.github.io/disk-crate/')}`,
      'code_alice'
    );

    const cacheBuckets = new Map();
    const cachesImpl = {
      async has(name) { return cacheBuckets.has(name); },
      async open(name) {
        if (!cacheBuckets.has(name)) cacheBuckets.set(name, new Map());
        const map = cacheBuckets.get(name);
        return {
          async put(k, res) {
            const key = typeof k === 'string' ? k : k.url;
            map.set(key, Buffer.from(await res.arrayBuffer()));
          },
          async match(k) {
            const key = typeof k === 'string' ? k : k.url;
            const buf = map.get(key);
            if (!buf) return undefined;
            return {
              ok: true,
              status: 200,
              async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
              async json() { return JSON.parse(buf.toString('utf8')); }
            };
          },
          async delete(k) { return map.delete(typeof k === 'string' ? k : k.url); }
        };
      },
      async delete(name) { return cacheBuckets.delete(name); }
    };

    class FakeScannerWorker {
      constructor() {
        this._core = scannerWorkerMod.createScannerWorkerCore();
        this.onmessage = null;
      }
      postMessage(msg) {
        Promise.resolve(this._core.handleMessage(msg)).then((reply) => {
          if (reply && typeof this.onmessage === 'function') this.onmessage({ data: reply });
        });
      }
      terminate() {}
    }

    const backing = { stores: new Map() };
    const sampleUrl = 'https://raw.githubusercontent.com/alice/cd-metadata/main/sample.json';
    const client = await bootSystemClient(sys, {
      hash: aliceHash,
      search: '?catalog=' + encodeURIComponent(sampleUrl),
      syncDebounceMs: 10,
      indexedDBImpl: makeDeviceIdb(backing),
      cachesImpl,
      workerCtor: FakeScannerWorker,
      extraNavigator: {
        mediaDevices: {
          async getUserMedia() {
            const tr = { getCapabilities() { return {}; }, stop() {} };
            return { getTracks: () => [tr], getVideoTracks: () => [tr] };
          }
        }
      },
      coverMocks: async (url) => {
        if (url.endsWith('scanner-assets/v1/manifest.json')) {
          return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.endsWith('scanner-assets/v1/engine-shell.wasm')) {
          return new Response(wasmBytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
        }
        return new Response(JSON.stringify({ releases: [], images: [], results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });

    // Seed 1 Owned release via UI & wait for initial cloud sync to settle completely
    await client.clickElement('modeCollectionBtn');
    await client.clickElement('addReleaseBtn');
    client.setInput('rfArtist', 'Iso Test Artist');
    client.setInput('rfTitle', 'Existing Owned');
    client.setInput('rfCategory', 'OST');
    client.setInput('rfCatNo', 'SC-OWN-1');
    client.setInput('rfBarcode', '4547366000111');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(140);
    assert.equal(sys.db.queryRaw("SELECT release_id FROM owned_releases WHERE github_id = '1001'").length, 1);

    const workerReqCountBefore = client.requestLog.filter((r) => r.url.startsWith(sys.workerBaseUrl)).length;
    const dailyWritesBefore = sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count;

    // 1) Open Scanner (Gate) -> 0 WASM downloads, 0 Cache Storage
    await client.clickElement('openScannerBtn');
    assert.equal(client.elements.get('scannerGatePanel').classList.contains('hidden'), false);
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), false);

    // 2) Confirm download -> verifies WASM into Cache Storage & enters live viewfinder
    await client.clickElement('scannerConfirmDownloadBtn');
    await client.settle(60);
    assert.equal(client.elements.get('scannerViewfinderPanel').classList.contains('hidden'), false);
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), true);

    // 3) Manual Hunt match (KSCL-737) -> Open in Hunt switches back to Hunt & opens Crate Flip
    client.setInput('scannerManualInput', 'KSCL-737');
    await client.clickElement('scannerManualSubmitBtn');
    assert.ok(client.elements.get('scannerManualResult').innerHTML.includes('On Hunt List'));
    const jumpTarget = {
      closest: () => jumpTarget,
      getAttribute: (a) => (a === 'data-scanner-jump' ? 'hunt' : (a === 'data-target-id' ? 'sample-01' : null))
    };
    client.elements.get('scannerManualResult').dispatchEvent({ type: 'click', target: jumpTarget });
    await client.settle(60);
    assert.equal(client.elements.get('scannerModal').classList.contains('open'), false);
    assert.equal(client.elements.get('lightboxModal').classList.contains('open'), true);
    assert.ok(client.elements.get('lbCatalogText').textContent.includes('KSCL-737'));
    await client.clickElement('closeLightboxBtn');

    // 4) Wipe Scanner Engine & Cache while signed in
    await client.clickElement('openScannerBtn');
    await client.clickElement('scannerViewManagerBtn');
    await client.clickElement('scannerWipeBtn');
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), false);

    // Assert ZERO Worker HTTP calls or SQLite writes during entire Scanner lifecycle & zero scanner state in SQLite
    assert.equal(
      client.requestLog.filter((r) => r.url.startsWith(sys.workerBaseUrl)).length,
      workerReqCountBefore,
      'Scanner open/download/lookup/wipe must send 0 requests to cloud Worker'
    );
    assert.equal(sys.db.queryRaw('SELECT write_count FROM daily_usage')[0].write_count, dailyWritesBefore);
    const allSqlState = JSON.stringify(sys.db.queryRaw('SELECT state_json FROM user_state')) +
      JSON.stringify(sys.db.queryRaw('SELECT data_json FROM owned_releases'));
    assert.equal(allSqlState.toLowerCase().includes('scanner'), false);

    // 5) Reopen Scanner from gate, scan unknown barcode -> + Add to Collection saves & syncs to SQLite
    await client.clickElement('closeScannerModalBtn');
    await client.clickElement('openScannerBtn');
    client.setInput('scannerManualInput', '4547366999999');
    await client.clickElement('scannerManualSubmitBtn');
    const addTarget = {
      closest: () => addTarget,
      getAttribute: (a) => (a === 'data-scanner-add' ? '4547366999999' : null)
    };
    client.elements.get('scannerManualResult').dispatchEvent({ type: 'click', target: addTarget });
    await client.settle(60);
    assert.equal(client.elements.get('releaseFormModal').classList.contains('open'), true);
    assert.equal(client.elements.get('rfBarcode').value, '4547366999999');

    client.setInput('rfArtist', 'Scanned New Artist');
    client.setInput('rfTitle', 'Scanned New Release');
    client.setInput('rfCatNo', 'SCN-ADD-99');
    client.setInput('rfCategory', 'Rock');
    await client.clickElement('saveReleaseFormBtn');
    await client.settle(140);

    const ownedSqlRows = sys.db.queryRaw("SELECT release_id, data_json FROM owned_releases WHERE github_id = '1001'");
    assert.equal(ownedSqlRows.length, 2);
    assert.equal(ownedSqlRows.some((r) => r.data_json.includes('4547366999999')), true);
  });
});
