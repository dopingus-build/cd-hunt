'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT_DIR, 'index.html');
const LEGACY_HTML_PATH = path.join(ROOT_DIR, 'osaka_cd_cover_album.html');
const CSS_PATH = path.join(ROOT_DIR, 'css', 'styles.css');
const EXTERNAL_METADATA_PATH = path.join(ROOT_DIR, '..', 'cd-metadata', '2026-japan.json');
const EXTERNAL_INDEX_PATH = path.join(ROOT_DIR, '..', 'cd-metadata', 'index.json');
const SAMPLE_CATALOG_PATH = path.join(ROOT_DIR, 'docs', 'sample-catalog.json');

function getPresetTestFixtures() {
  if (fs.existsSync(EXTERNAL_INDEX_PATH) && fs.existsSync(EXTERNAL_METADATA_PATH)) {
    const catalogJson = JSON.parse(fs.readFileSync(EXTERNAL_METADATA_PATH, 'utf8'));
    return {
      indexJson: JSON.parse(fs.readFileSync(EXTERNAL_INDEX_PATH, 'utf8')),
      catalogJson,
      expectedTitle: 'Osaka CD Cover Album',
      expectedPhysical: 53,
      expectedDigital: 2
    };
  }
  const sampleJson = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
  return {
    indexJson: {
      schemaVersion: 1,
      catalogs: [
        {
          id: '2026-japan',
          title: '2026 Japan (Osaka) CD Hunt',
          subtitle: '53 physical CDs + 2 digital-only releases',
          file: '2026-japan.json'
        }
      ]
    },
    catalogJson: sampleJson,
    expectedTitle: 'Sample Disk Crate Catalog',
    expectedPhysical: 1,
    expectedDigital: 1
  };
}
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

const { deriveStoragePrefix } = require('../js/storage.js');

function readAppHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function readValidatorSource() {
  assert.ok(fs.existsSync(VALIDATE_PATH), 'js/validate.js must exist');
  return fs.readFileSync(VALIDATE_PATH, 'utf8');
}

function createElementStub(id, initialClasses = [], onImgQuery) {
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
      add(...tokens) {
        tokens.filter(Boolean).forEach((t) => classes.add(t));
      },
      remove(...tokens) {
        tokens.filter(Boolean).forEach((t) => classes.delete(t));
      },
      toggle(token, force) {
        if (force === undefined) {
          if (classes.has(token)) {
            classes.delete(token);
            return false;
          }
          classes.add(token);
          return true;
        }
        if (force) {
          classes.add(token);
          return true;
        }
        classes.delete(token);
        return false;
      },
      contains(token) {
        return classes.has(token);
      }
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      String(val || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => classes.add(t));
    },
    setAttribute(name, val) {
      attrs[name] = String(val);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelectorAll(selector) {
      if (selector === 'img[data-fallback-id]' && typeof onImgQuery === 'function') {
        return onImgQuery(this.innerHTML);
      }
      return [];
    },
    select() {},
    focus() {},
    click() {
      this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners[event.type] || []) {
        fn.call(this, event);
      }
    }
  };
}

function buildDomElements(html, onImgQuery) {
  const elements = new Map();
  const tagRegex = /<[^>]*\bid=["']([^"']+)["'][^>]*>/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const id = match[1];
    const classMatch = fullTag.match(/\bclass=["']([^"']+)["']/);
    const initialClasses = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    elements.set(id, createElementStub(id, initialClasses, onImgQuery));
  }
  return elements;
}

function createStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      if (index < 0 || index >= store.size) return null;
      return Array.from(store.keys())[index];
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      store.set(key, String(val));
    },
    removeItem(key) {
      store.delete(key);
    },
    _store: store
  };
}

async function bootApp({
  catalogObject,
  savedCatalogUrl,
  initialStorage,
  search = '',
  hash = '',
  origin = 'https://dopingus-build.github.io',
  pathname = '/disk-crate/',
  syncApiUrl = '',
  syncDebounceMs = 10,
  fetchImpl,
  imageImpl,
  indexedDBImpl = null,
  mbTrackMinIntervalMs = 0,
  disableIntersectionObserver = false,
  clipboardMode = 'async',
  execCommandThrow = false,
  cachesImpl = null,
  workerCtor = null,
  extraNavigator = null
} = {}) {
  const html = readAppHtml();
  const validatorSource = readValidatorSource();
  const storageSource = fs.readFileSync(STORAGE_PATH, 'utf8');
  const dbSource = fs.readFileSync(DB_PATH, 'utf8');
  const coverResolverSource = fs.readFileSync(COVER_RESOLVER_PATH, 'utf8');
  const trackResolverSource = fs.readFileSync(TRACK_RESOLVER_PATH, 'utf8');
  const configSource = fs.readFileSync(CONFIG_PATH, 'utf8');
  const syncSource = fs.readFileSync(SYNC_PATH, 'utf8');
  const sheetAdapterSource = fs.readFileSync(SHEET_ADAPTER_PATH, 'utf8');
  const collectionSource = fs.readFileSync(COLLECTION_PATH, 'utf8');
  const appScript = fs.readFileSync(APP_PATH, 'utf8');

  const fallbackImgsById = new Map();
  function extractFallbackImgs(markup) {
    const imgs = [];
    const matches = String(markup || '').matchAll(/data-fallback-id=["']([^"']+)["']/g);
    for (const m of matches) {
      const albumId = m[1];
      const imgStub = {
        getAttribute(attr) {
          return attr === 'data-fallback-id' ? albumId : null;
        },
        onerror: null
      };
      fallbackImgsById.set(albumId, imgStub);
      imgs.push(imgStub);
    }
    return imgs;
  }

  const elements = buildDomElements(html, extractFallbackImgs);
  const docListeners = {};
  const localStorage = createStorage();
  if (initialStorage && typeof initialStorage === 'object') {
    for (const [k, v] of Object.entries(initialStorage)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  if (savedCatalogUrl) {
    localStorage.setItem('cd_hunt_catalog_url_v1', savedCatalogUrl);
  }

  const copiedTexts = [];
  const historyUpdates = [];
  const locationNavigations = [];
  const locationObj = {
    search,
    hash,
    origin,
    pathname,
    href: origin + pathname + search + hash,
    assign(nextUrl) {
      locationNavigations.push(nextUrl);
    }
  };
  let lastCreatedElement = null;
  const loadedDynamicAssets = [];

  function registerMarkupIds(markup) {
    if (!markup) return;
    const tagRegex = /<[^>]*\bid=["']([^"']+)["'][^>]*>/g;
    let match;
    while ((match = tagRegex.exec(markup)) !== null) {
      const fullTag = match[0];
      const id = match[1];
      if (!elements.has(id)) {
        const classMatch = fullTag.match(/\bclass=["']([^"']+)["']/);
        const initialClasses = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
        elements.set(id, createElementStub(id, initialClasses, extractFallbackImgs));
      }
    }
  }

  const winListeners = {};
  const documentStub = {
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    head: {
      appendChild(el) {
        if (el && el.href) {
          loadedDynamicAssets.push(el.href);
        }
        if (el && el.src) {
          loadedDynamicAssets.push(el.src);
          const rel = String(el.src).replace(/^\.\//, '');
          const abs = path.resolve(__dirname, '..', rel);
          if (fs.existsSync(abs)) {
            vm.runInContext(fs.readFileSync(abs, 'utf8'), context, { filename: abs });
          }
          if (typeof el.onload === 'function') el.onload();
        }
      }
    },
    body: {
      appendChild(el) {
        if (el && el.id) {
          elements.set(el.id, el);
        }
        if (el && el.innerHTML) {
          registerMarkupIds(el.innerHTML);
        }
      },
      removeChild() {}
    },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      if (/^(?:art-slot|single-variants|refresh-icon)-/.test(id)) {
        const dynamicEl = createElementStub(id, [], extractFallbackImgs);
        elements.set(id, dynamicEl);
        return dynamicEl;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-album-id]') {
        const cards = [];
        for (const gridId of ['albumGrid', 'digitalGrid']) {
          const grid = elements.get(gridId);
          if (!grid || !grid.innerHTML) continue;
          const matches = grid.innerHTML.matchAll(/data-album-id=["']([^"']+)["']/g);
          for (const m of matches) {
            cards.push({
              getAttribute(attr) {
                return attr === 'data-album-id' ? m[1] : null;
              }
            });
          }
        }
        return cards;
      }
      if (selector === 'img[data-fallback-id]') {
        const sources = ['albumGrid', 'digitalGrid', 'lbArtBox']
          .map((id) => (elements.get(id) && elements.get(id).innerHTML) || '')
          .join('');
        return extractFallbackImgs(sources);
      }
      return [];
    },
    createElement() {
      lastCreatedElement = createElementStub('dynamic', [], extractFallbackImgs);
      return lastCreatedElement;
    },
    execCommand(cmd) {
      if (cmd !== 'copy') return false;
      if (execCommandThrow) {
        throw new Error('execCommand blocked');
      }
      if (lastCreatedElement && typeof lastCreatedElement.value === 'string') {
        copiedTexts.push(lastCreatedElement.value);
      }
      return true;
    },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    }
  };

  let observerCallback = null;
  const observedTargets = [];
  class TrackingIntersectionObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe(target) {
      observedTargets.push(target);
    }
    unobserve(target) {
      const idx = observedTargets.indexOf(target);
      if (idx !== -1) observedTargets.splice(idx, 1);
    }
    disconnect() {
      observedTargets.length = 0;
    }
  }

  class MockFileReader {
    readAsText(file) {
      if (file && file._failRead) {
        if (typeof this.onerror === 'function') this.onerror(new Error('read error'));
        return;
      }
      this.result = file && typeof file._content === 'string' ? file._content : '';
      if (typeof this.onload === 'function') this.onload();
    }
  }

  class MockImage {
    set src(_) {}
  }

  let navigatorObj = {};
  if (clipboardMode === 'async') {
    navigatorObj = {
      clipboard: {
        async writeText(txt) {
          copiedTexts.push(txt);
        }
      }
    };
  } else if (clipboardMode === 'reject') {
    navigatorObj = {
      clipboard: {
        async writeText() {
          throw new Error('Clipboard denied');
        }
      }
    };
  }

  if (extraNavigator && typeof extraNavigator === 'object') {
    Object.assign(navigatorObj, extraNavigator);
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
    caches: cachesImpl || undefined,
    Worker: workerCtor || undefined,
    indexedDB: indexedDBImpl || undefined,
    Image: imageImpl || MockImage,
    FileReader: MockFileReader,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    document: documentStub,
    localStorage,
    location: locationObj,
    navigator: navigatorObj,
    addEventListener(type, fn) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(fn);
    },
    history: {
      replaceState(_state, _title, nextUrl) {
        historyUpdates.push(nextUrl);
        const s = String(nextUrl);
        const hashIdx = s.indexOf('#');
        locationObj.hash = hashIdx !== -1 ? s.slice(hashIdx) : '';
        const beforeHash = hashIdx !== -1 ? s.slice(0, hashIdx) : s;
        const qIdx = beforeHash.indexOf('?');
        locationObj.search = qIdx !== -1 ? beforeHash.slice(qIdx) : '';
      }
    },
    fetch:
      fetchImpl ||
      (async (url) => {
        if (String(url).endsWith('/index.json') && fs.existsSync(EXTERNAL_INDEX_PATH)) {
          return {
            ok: true,
            status: 200,
            async json() {
              return JSON.parse(fs.readFileSync(EXTERNAL_INDEX_PATH, 'utf8'));
            }
          };
        }
        throw new Error('Unexpected network fetch in offline test: ' + url);
      })
  };
  if (!disableIntersectionObserver) {
    sandbox.IntersectionObserver = TrackingIntersectionObserver;
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  if (catalogObject !== undefined) {
    context.CD_HUNT_CATALOG = catalogObject;
  }

  vm.runInContext(validatorSource, context, { filename: VALIDATE_PATH });
  vm.runInContext(storageSource, context, { filename: STORAGE_PATH });
  vm.runInContext(dbSource, context, { filename: DB_PATH });
  vm.runInContext(coverResolverSource, context, { filename: COVER_RESOLVER_PATH });
  vm.runInContext(trackResolverSource, context, { filename: TRACK_RESOLVER_PATH });
  vm.runInContext(configSource, context, { filename: CONFIG_PATH });
  (context.DiskCrate || context.CDHunt).config.syncApiUrl = syncApiUrl;
  (context.DiskCrate || context.CDHunt).config.syncDebounceMs = syncDebounceMs;
  (context.DiskCrate || context.CDHunt).config.mbTrackMinIntervalMs = mbTrackMinIntervalMs;
  vm.runInContext(syncSource, context, { filename: SYNC_PATH });
  vm.runInContext(sheetAdapterSource, context, { filename: SHEET_ADAPTER_PATH });
  vm.runInContext(collectionSource, context, { filename: COLLECTION_PATH });
  vm.runInContext(appScript, context, { filename: APP_PATH });

  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await flush();

  return {
    elements,
    localStorage,
    historyUpdates,
    locationNavigations,
    copiedTexts,
    observedTargets,
    loadedDynamicAssets,
    document: documentStub,
    window: context,
    flush,
    async clickElement(id) {
      const el = elements.get(id);
      assert.ok(el, `Element #${id} must exist`);
      el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
      await flush();
    },
    async inputText(id, value) {
      const el = elements.get(id);
      assert.ok(el, `Element #${id} must exist`);
      el.value = value;
      el.dispatchEvent({ type: 'input', target: el });
      await flush();
    },
    async pressKey(id, key) {
      const el = elements.get(id);
      assert.ok(el, `Element #${id} must exist`);
      el.dispatchEvent({ type: 'keydown', key, preventDefault() {} });
      await flush();
    },
    async clickLookupCandidate(idx) {
      const resBox = elements.get('releaseLookupResults');
      assert.ok(resBox, 'Element #releaseLookupResults must exist');
      const candStub = { getAttribute: (name) => (name === 'data-lookup-idx' ? String(idx) : null) };
      resBox.dispatchEvent({
        type: 'click',
        target: { closest: (sel) => (sel === '[data-lookup-idx]' ? candStub : null) },
        preventDefault() {},
        stopPropagation() {}
      });
      await flush();
    },
    async selectLocalFile(name, jsonContent, { useFileReader = false, failRead = false } = {}) {
      const fileInput = elements.get('catalogFileInput');
      assert.ok(fileInput, 'Element #catalogFileInput must exist');
      const raw = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);
      const fileObj = useFileReader
        ? { name, _content: raw, _failRead: failRead }
        : {
            name,
            async text() {
              return raw;
            }
          };
      fileInput.files = [fileObj];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
      await flush();
    },
    async triggerIntersection(albumId) {
      if (!observerCallback) return;
      const matching = observedTargets.filter((t) => t && t.getAttribute('data-album-id') === albumId);
      if (matching.length > 0) {
        observerCallback(matching.map((target) => ({ isIntersecting: true, target })));
        await flush();
      }
    },
    triggerImageError(albumId) {
      const stub = fallbackImgsById.get(albumId);
      assert.ok(stub && typeof stub.onerror === 'function', `Expected img[data-fallback-id="${albumId}"] with onerror`);
      stub.onerror();
    },
    async triggerKeydown(key, targetTagName = '') {
      const ev = {
        key,
        target: targetTagName ? { tagName: targetTagName } : null
      };
      for (const fn of docListeners.keydown || []) {
        fn(ev);
      }
      await flush();
    },
    async swipeLightbox(dx, { targetId = 'lbCoverFrame', dy = 0 } = {}) {
      const el = elements.get(targetId);
      assert.ok(el, `Element #${targetId} must exist`);
      el.dispatchEvent({ type: 'touchstart', changedTouches: [{ screenX: 200, screenY: 200 }] });
      el.dispatchEvent({ type: 'touchend', changedTouches: [{ screenX: 200 + dx, screenY: 200 + dy }] });
      await flush();
    },
    triggerDocumentClick(action, attrs = {}) {
      const targetStub = {
        closest(selector) {
          return selector === '[data-action]' ? targetStub : null;
        },
        getAttribute(name) {
          if (name === 'data-action') return action;
          return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
        }
      };
      const event = { target: targetStub, stopPropagation() {} };
      for (const fn of docListeners.click || []) {
        fn(event);
      }
    },
    async triggerVisibilityChange(nextState) {
      documentStub.visibilityState = nextState;
      for (const fn of docListeners.visibilitychange || []) {
        fn({});
      }
      await flush();
    },
    async triggerPageHide() {
      for (const fn of winListeners.pagehide || []) {
        fn({});
      }
      await flush();
    }
  };
}

function makeValidRemoteCatalog() {
  return {
    $schema: 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json',
    schemaVersion: 1,
    meta: {
      title: 'Tokyo Vinyl & CD Hunt',
      subtitle: 'Disk Union Crate Browser',
      documentTitle: 'Tokyo Hunt',
      searchPlaceholder: 'Search Tokyo list...'
    },
    items: [
      {
        id: 'tok-01',
        category: 'J-Rock',
        artist: 'Asian Kung-Fu Generation',
        artistJa: 'ASIAN KUNG-FU GENERATION',
        title: 'Sol-fa',
        titleJa: 'ソルファ',
        regCatNo: 'KSCL-737',
        catalog: 'KSCL-737 (通常盤)',
        mbEditions: [{ catno: 'KSCL-737', label: '通常盤 Regular' }],
        kana: 'ア / A',
        filing: 'ア (AKFG) — J-Rock aisle',
        price: '¥400–¥800',
        itunesQuery: 'Sol-fa ASIAN KUNG-FU GENERATION',
        requiredGroups: [['sol-fa'], ['asian kung-fu']],
        accent: '#e11d48'
      }
    ]
  };
}

describe('HTML entrypoint generalization & script wiring', () => {
  it('uses index.html as the main app without legacy osaka_cd_cover_album.html', () => {
    assert.equal(fs.existsSync(LEGACY_HTML_PATH), false, 'osaka_cd_cover_album.html should be removed');
    const html = readAppHtml();
    assert.ok(fs.existsSync(CSS_PATH), 'css/styles.css must exist');
    assert.ok(html.includes('<title>Disk Crate'), 'index.html should use generic Disk Crate default title');
    assert.ok(
      html.includes('<link rel="stylesheet" href="./css/styles.css" />'),
      'Expected <link rel="stylesheet" href="./css/styles.css" /> in index.html'
    );
    assert.equal(html.includes('./data/catalog.js'), false, 'data/catalog.js must not be bundled');
    assert.ok(html.includes('id="catalogFileInput"'), 'Local JSON file input should exist');
    assert.ok(html.includes('id="loadCatalogFileBtn"'), 'Local JSON file button should exist');
    assert.ok(html.includes('id="copyShareLinkBtn"'), 'Copy Share Link button should exist');
    assert.ok(html.includes('id="catalogPresetsList"'), 'Dynamic presets container should exist');
    assert.ok(html.includes('id="githubAuthBtn"'), 'GitHub sign-in button should exist');
    assert.ok(html.includes('id="copyAgentLinkBtn"'), 'Agent Link button should exist');
    assert.ok(html.includes('id="githubSignOutBtn"'), 'GitHub sign-out button should exist');
    assert.ok(html.includes('id="syncStatusPill"'), 'Cloud sync status pill should exist');

    const expectedScripts = [
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
    for (const tag of expectedScripts) {
      const idx = html.indexOf(tag);
      assert.notEqual(idx, -1, `Expected ${tag} in index.html`);
      assert.ok(idx > lastIdx, `Expected ${tag} to appear in dependency order`);
      lastIdx = idx;
    }
  });
});

describe('Browser and Node dual export for js/validate.js', () => {
  it('attaches window.validateCatalog and window.normalizeCatalogUrl in a browser global context', () => {
    const validatorSource = readValidatorSource();
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(validatorSource, sandbox);

    assert.equal(typeof sandbox.window.validateCatalog, 'function');
    assert.equal(typeof sandbox.window.normalizeCatalogUrl, 'function');
    assert.equal(sandbox.window.DiskCrate, sandbox.window.CDHunt);
    assert.equal(typeof sandbox.window.DiskCrate.validateCatalog, 'function');
    assert.equal(typeof sandbox.window.DiskCrate.normalizeCatalogUrl, 'function');
    assert.equal(typeof sandbox.window.CDHunt.validateCatalog, 'function');
    assert.equal(typeof sandbox.window.CDHunt.normalizeCatalogUrl, 'function');
    const result = sandbox.window.validateCatalog(makeValidRemoteCatalog());
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true, errors: [] });
  });

  it('attaches all runtime modules to window.DiskCrate with strict window.CDHunt alias parity', async () => {
    const app = await bootApp();
    assert.equal(app.window.DiskCrate, app.window.CDHunt);
    for (const key of [
      'validateCatalog',
      'normalizeCatalogUrl',
      'extractGoogleSheetId',
      'storage',
      'db',
      'coverResolver',
      'trackResolver',
      'config',
      'sync',
      'sheetAdapter'
    ]) {
      assert.ok(app.window.DiskCrate[key], `Expected window.DiskCrate.${key} to be defined`);
      assert.equal(app.window.CDHunt[key], app.window.DiskCrate[key]);
    }
  });
});

describe('Catalog Loader screen, dynamic presets, local file picker, and share link', () => {
  it('shows Catalog Loader on first load and populates dynamic presets from cd-metadata/index.json', async () => {
    const { indexJson } = getPresetTestFixtures();
    const fetchedUrls = [];

    const app = await bootApp({
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        return {
          ok: true,
          status: 200,
          async json() {
            return indexJson;
          }
        };
      }
    });

    assert.notEqual(app.elements.get('errorBanner').style.display, 'block');
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), false);
    assert.equal(app.elements.get('copyShareLinkBtn').classList.contains('hidden'), true);
    assert.equal(app.elements.get('albumGrid').classList.contains('hidden'), true);
    assert.ok(fetchedUrls.includes('https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json'));

    const presetsHtml = app.elements.get('catalogPresetsList').innerHTML;
    assert.ok(presetsHtml.includes('data-action="load-preset"'));
    assert.ok(presetsHtml.includes('2026 Japan (Osaka) CD Hunt'));
    assert.ok(presetsHtml.includes('https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json'));
  });

  it('loads preset JSON when clicking a dynamic preset button and persists the URL', async () => {
    const { indexJson, catalogJson, expectedTitle, expectedPhysical, expectedDigital } = getPresetTestFixtures();
    const fetchedUrls = [];

    const app = await bootApp({
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return indexJson; } };
        }
        return { ok: true, status: 200, async json() { return catalogJson; } };
      }
    });

    app.triggerDocumentClick('load-preset', {
      'data-preset-url': 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json'
    });
    await app.flush();

    assert.ok(fetchedUrls.includes('https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json'));
    assert.equal(
      app.localStorage.getItem('cd_hunt_catalog_url_v1'),
      'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json'
    );
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);
    assert.equal(app.elements.get('brandTitle').textContent, expectedTitle);
    assert.equal(app.elements.get('progressBadge').textContent, '0 / ' + expectedPhysical);

    const physicalCards = app.elements.get('albumGrid').innerHTML.match(/<article class="cd-card/g) || [];
    const digitalCards = app.elements.get('digitalGrid').innerHTML.match(/<article class="cd-card/g) || [];
    assert.equal(physicalCards.length, expectedPhysical);
    assert.equal(digitalCards.length, expectedDigital);
  });

  it('converts pasted GitHub blob URL, syncs ?catalog=, and copies share link via #copyShareLinkBtn', async () => {
    const remoteCatalog = makeValidRemoteCatalog();
    const fetchedUrls = [];

    const app = await bootApp({
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        return { ok: true, status: 200, async json() { return remoteCatalog; } };
      }
    });

    app.elements.get('catalogUrlInput').value = 'https://github.com/example/my-cds/blob/main/tokyo.json';
    await app.clickElement('loadCatalogUrlBtn');

    const expectedRaw = 'https://raw.githubusercontent.com/example/my-cds/main/tokyo.json';
    assert.ok(fetchedUrls.includes(expectedRaw));
    assert.equal(app.localStorage.getItem('cd_hunt_catalog_url_v1'), expectedRaw);
    assert.ok(app.historyUpdates.some((u) => u.includes(encodeURIComponent(expectedRaw))));
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');

    await app.clickElement('openCatalogLoaderBtn');
    assert.equal(app.elements.get('copyShareLinkBtn').classList.contains('hidden'), false);
    await app.clickElement('copyShareLinkBtn');
    assert.equal(
      app.copiedTexts[0],
      'https://dopingus-build.github.io/disk-crate/?catalog=' + encodeURIComponent(expectedRaw)
    );
  });

  it('loads a local JSON file via #catalogFileInput, hides Copy Share Link, and derives unique storage keys', async () => {
    const localCatalog = makeValidRemoteCatalog();
    const app = await bootApp();

    await app.selectLocalFile('my-local.json', localCatalog);

    assert.notEqual(app.elements.get('errorBanner').style.display, 'block');
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);
    assert.equal(app.localStorage.getItem('cd_hunt_catalog_url_v1'), null);
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');

    app.triggerDocumentClick('toggle-acq', { 'data-id': 'tok-01' });
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 1');

    const expectedPrefix = deriveStoragePrefix({
      fileName: 'my-local.json',
      meta: localCatalog.meta,
      items: localCatalog.items
    });
    assert.deepEqual(
      JSON.parse(app.localStorage.getItem(expectedPrefix + '_checklist_v2')),
      { 'tok-01': true }
    );

    await app.clickElement('openCatalogLoaderBtn');
    assert.equal(app.elements.get('copyShareLinkBtn').classList.contains('hidden'), true);
    assert.ok(app.elements.get('activeCatalogInfo').textContent.includes('my-local.json'));
  });

  it('automatically reloads catalog from saved localStorage URL on subsequent visit', async () => {
    const remoteCatalog = makeValidRemoteCatalog();
    const savedRaw = 'https://raw.githubusercontent.com/example/my-cds/main/tokyo.json';
    let fetchedUrl = null;

    const app = await bootApp({
      savedCatalogUrl: savedRaw,
      fetchImpl: async (url) => {
        fetchedUrl = url;
        return {
          ok: true,
          status: 200,
          async json() {
            return remoteCatalog;
          }
        };
      }
    });

    assert.equal(fetchedUrl, savedRaw);
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');
  });

  it('loads index.json from a bare GitHub repository URL and resolves its presets cleanly', async () => {
    const aliceCatalog = makeValidRemoteCatalog();
    aliceCatalog.meta.title = 'Alice Osaka Hunt';
    const aliceIndex = {
      schemaVersion: 1,
      catalogs: [
        {
          id: 'alice-list',
          title: 'Alice Wishlist',
          subtitle: '1 physical CD',
          file: 'alice-list.json'
        }
      ]
    };
    const fetchedUrls = [];

    const app = await bootApp({
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        if (url === 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json') {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        if (url === 'https://raw.githubusercontent.com/alice/my-cd-metadata/main/index.json') {
          return { ok: true, status: 200, async json() { return aliceIndex; } };
        }
        if (url === 'https://raw.githubusercontent.com/alice/my-cd-metadata/main/alice-list.json') {
          return { ok: true, status: 200, async json() { return aliceCatalog; } };
        }
        throw new Error('Unexpected fetch URL: ' + url);
      }
    });

    app.elements.get('catalogUrlInput').value = 'https://github.com/alice/my-cd-metadata';
    await app.clickElement('loadCatalogUrlBtn');

    const expectedIndexUrl = 'https://raw.githubusercontent.com/alice/my-cd-metadata/main/index.json';
    const expectedCatalogUrl = 'https://raw.githubusercontent.com/alice/my-cd-metadata/main/alice-list.json';
    assert.ok(fetchedUrls.includes(expectedIndexUrl));
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), false);
    assert.equal(app.elements.get('activeCatalogInfo').textContent, 'Loaded repository index: ' + expectedIndexUrl);

    const presetsHtml = app.elements.get('catalogPresetsList').innerHTML;
    assert.ok(presetsHtml.includes('Alice Wishlist'));
    assert.ok(presetsHtml.includes(expectedCatalogUrl));

    app.triggerDocumentClick('load-preset', {
      'data-preset-url': expectedCatalogUrl
    });
    await app.flush();

    assert.ok(fetchedUrls.includes(expectedCatalogUrl));
    assert.equal(app.localStorage.getItem('cd_hunt_catalog_url_v1'), expectedCatalogUrl);
    assert.ok(app.historyUpdates.some((u) => u.includes(encodeURIComponent(expectedCatalogUrl))));
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);
    assert.equal(app.elements.get('brandTitle').textContent, 'Alice Osaka Hunt');
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');
  });
});

describe('Invalid catalog rejection on startup', () => {
  it('displays errorBanner for missing or unsupported schemaVersion', async () => {
    const missingVer = makeValidRemoteCatalog();
    delete missingVer.schemaVersion;
    const appMissing = await bootApp({ catalogObject: missingVer });
    assert.equal(appMissing.elements.get('errorBanner').style.display, 'block');
    assert.ok(appMissing.elements.get('errorBanner').textContent.includes('schemaVersion'));

    const badVer = makeValidRemoteCatalog();
    badVer.schemaVersion = 2;
    const appBadVer = await bootApp({ catalogObject: badVer });
    assert.equal(appBadVer.elements.get('errorBanner').style.display, 'block');
    assert.ok(appBadVer.elements.get('errorBanner').textContent.includes('schemaVersion'));
  });

  it('displays errorBanner when deprecated meta.storagePrefix is present', async () => {
    const bad = makeValidRemoteCatalog();
    bad.meta.storagePrefix = 'legacy_prefix';

    const app = await bootApp({ catalogObject: bad });
    assert.equal(app.elements.get('errorBanner').style.display, 'block');
    assert.ok(app.elements.get('errorBanner').textContent.includes('storagePrefix'));
    assert.equal(app.elements.get('albumGrid').innerHTML, '');
  });

  it('displays errorBanner and leaves albumGrid empty for duplicate item IDs', async () => {
    const base = makeValidRemoteCatalog();
    base.items.push(Object.assign({}, base.items[0], { title: 'Duplicate ID Item' }));

    const app = await bootApp({ catalogObject: base });
    assert.equal(app.elements.get('errorBanner').style.display, 'block');
    assert.ok(app.elements.get('errorBanner').textContent.toLowerCase().includes('duplicate'));
    assert.equal(app.elements.get('albumGrid').innerHTML, '');
  });

  it('displays errorBanner when required fields or requiredGroups are missing', async () => {
    const noArtist = makeValidRemoteCatalog();
    delete noArtist.items[0].artist;
    const app1 = await bootApp({ catalogObject: noArtist });
    assert.equal(app1.elements.get('errorBanner').style.display, 'block');
    assert.ok(app1.elements.get('errorBanner').textContent.includes('artist'));

    const noGroups = makeValidRemoteCatalog();
    delete noGroups.items[0].requiredGroups;
    const app2 = await bootApp({ catalogObject: noGroups });
    assert.equal(app2.elements.get('errorBanner').style.display, 'block');
    assert.ok(app2.elements.get('errorBanner').textContent.includes('requiredGroups'));
  });
});

describe('Remote ?catalog=<url> JSON loading and derived storage persistence', () => {
  it('loads valid remote JSON, updates branding, auto-derives categories, and persists checklist under derived key', async () => {
    const remoteCatalog = makeValidRemoteCatalog();
    const remoteUrl = 'https://example.com/custom.json';
    let requestedUrl = null;

    const app = await bootApp({
      search: '?catalog=' + encodeURIComponent(remoteUrl),
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          async json() {
            return remoteCatalog;
          }
        };
      }
    });

    assert.equal(requestedUrl, remoteUrl);
    assert.notEqual(app.elements.get('errorBanner').style.display, 'block');
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');
    assert.ok(app.elements.get('digitalNoteBanner').classList.contains('hidden'));
    assert.ok(app.elements.get('digitalOnlySection').classList.contains('hidden'));

    const pillsHtml = app.elements.get('categoryPills').innerHTML;
    assert.ok(pillsHtml.includes('All Releases'));
    assert.ok(pillsHtml.includes('J-Rock'));

    app.triggerDocumentClick('toggle-acq', { 'data-id': 'tok-01' });
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 1');

    const expectedPrefix = deriveStoragePrefix({
      sourceUrl: remoteUrl,
      meta: remoteCatalog.meta,
      items: remoteCatalog.items
    });
    assert.deepEqual(
      JSON.parse(app.localStorage.getItem(expectedPrefix + '_checklist_v2')),
      { 'tok-01': true }
    );
  });

  it('rejects invalid remote JSON with a prohibited hotlinked domain and displays errorBanner', async () => {
    const invalidRemote = makeValidRemoteCatalog();
    invalidRemote.items[0].filing = 'https://vgmdb.net/album/123';

    const app = await bootApp({
      search: '?catalog=https://example.com/bad.json',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return invalidRemote;
        }
      })
    });

    const errorBanner = app.elements.get('errorBanner');
    assert.equal(errorBanner.style.display, 'block');
    assert.ok(errorBanner.textContent.includes('vgmdb.net'));
    assert.equal(app.elements.get('albumGrid').innerHTML, '');
  });
});

describe('Responsive CSS grid containment regression', () => {
  it('constrains .modal-stage tracks with minmax(0, 1fr) and .lb-details with min-width: 0', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const stageMatch = css.match(/\.modal-stage\s*\{[^}]*\}/);
    const detailsMatch = css.match(/\.lb-details\s*\{[^}]*\}/);

    assert.ok(stageMatch, '.modal-stage rule must exist in css/styles.css');
    assert.ok(detailsMatch, '.lb-details rule must exist in css/styles.css');
    assert.ok(
      stageMatch[0].includes('minmax(0, 1fr)'),
      '.modal-stage must use minmax(0, 1fr) so variant strips do not widen the grid track'
    );
    assert.ok(
      detailsMatch[0].includes('min-width: 0'),
      '.lb-details must set min-width: 0 to allow horizontal flex strips to scroll within viewport'
    );
  });

  it('defines GPU-accelerated carousel transition animations with reduced-motion support in css/styles.css', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    assert.ok(css.includes('@keyframes carouselSlideNext'));
    assert.ok(css.includes('@keyframes carouselSlidePrev'));
    assert.ok(css.includes('@keyframes carouselEditionFlip'));
    assert.ok(css.includes('.carousel-anim-next'));
    assert.ok(css.includes('.carousel-anim-prev'));
    assert.ok(css.includes('.carousel-anim-flip'));
    assert.ok(css.includes('prefers-reduced-motion: reduce'));
  });
});

function makeRichTestCatalog({ includeDigital = true } = {}) {
  const items = [
    {
      id: 'cd-01',
      category: 'Anime Themes & Chara',
      artist: 'yama',
      artistJa: 'yama (ヤマ)',
      title: '"slash" (Gundam OP)',
      titleJa: 'slash (水星の魔女)',
      regCatNo: 'SRCL-12539',
      catalog: 'SRCL-12539 (通常盤)',
      mbEditions: [
        { catno: 'SRCL-12539', label: '通常盤 Regular' },
        { catno: 'SRCL-12540', label: '期間生産限定 Anime' }
      ],
      kana: 'ヤ / Y',
      filing: 'ヤ (yama) / ガンダム',
      price: '¥500–¥900 (Reg)',
      itunesQuery: 'slash yama',
      requiredGroups: [['slash'], ['yama']],
      accent: '#3b82f6'
    },
    {
      id: 'cd-02',
      category: 'Games & OSTs',
      artist: 'Yoshino Aoki',
      artistJa: '青木佳乃',
      title: 'Breath of Fire III OST',
      titleJa: 'ブレス オブ ファイアIII',
      regCatNo: 'CPCA-1004',
      catalog: 'CPCA-1004',
      mbEditions: [{ catno: 'CPCA-1004', label: '通常盤 Regular' }],
      kana: 'フ / B',
      filing: 'Games OST Shelf / Book Off',
      price: '¥1,500–¥2,500',
      itunesQuery: 'Breath of Fire III',
      requiredGroups: [['breath of fire']],
      accent: '#f59e0b'
    }
  ];
  if (includeDigital) {
    items.push({
      id: 'dig-01',
      digitalOnly: true,
      category: 'Anime Themes & Chara',
      artist: 'Hanatan',
      artistJa: '花たん',
      title: '"gradation" (Digital)',
      titleJa: 'gradation (配信限定)',
      regCatNo: 'DIGITAL',
      catalog: 'Digital Only',
      mbEditions: [],
      kana: 'ハ / H',
      filing: 'No physical CD exists — stream only.',
      price: '¥0 (Digital)',
      itunesQuery: 'gradation Hanatan',
      requiredGroups: [['gradation'], ['hanatan']],
      accent: '#0ea5e9'
    });
  }
  return {
    $schema: 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json',
    schemaVersion: 1,
    meta: {
      title: 'Rich Test Hunt',
      subtitle: 'Custom Test Subtitle',
      documentTitle: 'Rich Test Doc',
      searchPlaceholder: 'Filter rich catalog...',
      digitalSectionTitle: 'Custom Digital Section',
      digitalSectionSubtitle: 'Custom digital subtitle.'
    },
    categories: [
      { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
      { key: 'Anime Themes & Chara', label: 'Anime Themes & Chara', dot: '#f43f5e' },
      { key: 'Games & OSTs', label: 'Games & OSTs', dot: '#f59e0b' }
    ],
    items
  };
}

describe('Search, category filtering, hunting-only toggle, and empty state recovery', () => {
  it('filters across English, Japanese, catalog #, and filing, then recovers via clear and reset buttons', async () => {
    const app = await bootApp({ catalogObject: makeRichTestCatalog() });

    assert.equal(app.document.title, 'Rich Test Doc');
    assert.equal(app.elements.get('searchInput').getAttribute('placeholder'), 'Filter rich catalog...');
    assert.equal(app.elements.get('digitalSectionTitle').textContent, 'Custom Digital Section');
    assert.equal(app.elements.get('digitalSectionSub').textContent, 'Custom digital subtitle.');

    // Filter by category pill with no digital items
    app.triggerDocumentClick('set-cat', { 'data-cat': 'Games & OSTs' });
    assert.equal(app.elements.get('visibleCountText').textContent, 'Showing 1 of 2 physical covers');
    assert.equal(app.elements.get('digitalOnlySection').classList.contains('hidden'), true);
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('CPCA-1004'));

    // Back to All, search Japanese artist name
    app.triggerDocumentClick('set-cat', { 'data-cat': 'All' });
    await app.inputText('searchInput', '青木佳乃');
    assert.equal(app.elements.get('clearSearchBtn').classList.contains('visible'), true);
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('cd-02'), true);
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('cd-01'), false);

    // Search non-existent text -> emptyState -> resetFiltersBtn
    await app.inputText('searchInput', 'nonexistent-release-xyz');
    assert.equal(app.elements.get('albumGrid').classList.contains('hidden'), true);
    assert.equal(app.elements.get('emptyState').classList.contains('hidden'), false);
    await app.clickElement('resetFiltersBtn');
    assert.equal(app.elements.get('emptyState').classList.contains('hidden'), true);
    assert.equal(app.elements.get('clearSearchBtn').classList.contains('visible'), false);
    assert.equal(app.elements.get('visibleCountText').textContent, 'Showing 2 physical + 1 digital-only');

    // Clear search button resets query directly
    await app.inputText('searchInput', 'SRCL-12539');
    assert.equal(app.elements.get('visibleCountText').textContent, 'Showing 1 of 2 physical covers');
    await app.clickElement('clearSearchBtn');
    assert.equal(app.elements.get('searchInput').value, '');
    assert.equal(app.elements.get('clearSearchBtn').classList.contains('visible'), false);
    assert.equal(app.elements.get('visibleCountText').textContent, 'Showing 2 physical + 1 digital-only');

    // Acquire cd-01 & filter with Hunting Only
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'cd-01' });
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 2');
    await app.clickElement('huntingOnlyBtn');
    assert.equal(app.elements.get('huntingOnlyBtn').classList.contains('btn-active-filter'), true);
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('cd-01'), false);
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('cd-02'), true);

    // Toggle Hunting Only off & un-acquire cd-01
    await app.clickElement('huntingOnlyBtn');
    assert.equal(app.elements.get('huntingOnlyBtn').classList.contains('btn-active-filter'), false);
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'cd-01' });
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 2');
  });
});

describe('View mode toggle, 1-Col details, digital banner lifecycle, and catalog copy', () => {
  it('toggles Grid vs 1-Col view, restores saved single mode, manages digital banner, and copies catalog #', async () => {
    const catalog = makeRichTestCatalog();
    const prefix = deriveStoragePrefix({ meta: catalog.meta, items: catalog.items });

    const app = await bootApp({
      catalogObject: catalog,
      initialStorage: {
        [prefix + '_view_mode_v1']: 'single',
        [prefix + '_note_dismissed_v1']: '1'
      }
    });

    // Restores single view mode & dismissed note banner
    assert.equal(app.elements.get('viewModeLabel').textContent, 'Grid View');
    assert.equal(app.elements.get('albumGrid').className, 'cd-single-col');
    assert.equal(app.elements.get('digitalNoteBanner').classList.contains('hidden'), true);
    assert.equal(app.elements.get('compactCountBar').classList.contains('hidden'), false);
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('どこで探す:'));
    assert.ok(app.elements.get('digitalGrid').innerHTML.includes('Note:'));

    // Toggle digital item does NOT change physical counter, updates digital button text
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 2');
    assert.ok(app.elements.get('digitalGrid').innerHTML.includes('Saved / Streamed'));

    // Restore note banner, then dismiss it again
    await app.clickElement('restoreNoteBtn');
    assert.equal(app.elements.get('digitalNoteBanner').classList.contains('hidden'), false);
    assert.equal(app.elements.get('compactCountBar').classList.contains('hidden'), true);
    assert.equal(app.localStorage.getItem(prefix + '_note_dismissed_v1'), null);

    await app.clickElement('dismissNoteBtn');
    assert.equal(app.elements.get('digitalNoteBanner').classList.contains('hidden'), true);
    assert.equal(app.localStorage.getItem(prefix + '_note_dismissed_v1'), '1');

    // Toggle view mode back to Grid
    await app.clickElement('viewModeBtn');
    assert.equal(app.elements.get('viewModeLabel').textContent, '1-Col View');
    assert.equal(app.elements.get('albumGrid').className, 'cd-grid');
    assert.equal(app.localStorage.getItem(prefix + '_view_mode_v1'), 'grid');

    // Copy catalog number via data-action="copy-cat"
    app.triggerDocumentClick('copy-cat', { 'data-catno': 'CPCA-1004' });
    await app.flush();
    assert.ok(app.copiedTexts.includes('CPCA-1004'));
  });
});

describe('Two-stage cover resolution, variant selection/cycling, fallback, and broken image recovery', () => {
  it('resolves covers via IntersectionObserver, prioritizes Regular Edition, switches/refetches variants, and drops broken images', async () => {
    const catalog = makeRichTestCatalog({ includeDigital: false });
    const prefix = deriveStoragePrefix({ meta: catalog.meta, items: catalog.items });

    class PassingImage {
      set src(_) {
        this.naturalWidth = 500;
        this.naturalHeight = 500;
        if (this.onload) this.onload();
      }
    }

    const app = await bootApp({
      catalogObject: catalog,
      imageImpl: PassingImage,
      fetchImpl: async (url) => {
        if (url.includes('catno:SRCL-12539')) {
          return { ok: true, async json() { return { releases: [{ id: 'mb-reg' }] }; } };
        }
        if (url.includes('catno:SRCL-12540')) {
          return { ok: true, async json() { return { releases: [{ id: 'mb-ani' }] }; } };
        }
        if (url.includes('itunes.apple.com') && url.includes('slash') && url.includes('country=jp')) {
          return {
            ok: true,
            async json() {
              return {
                results: [
                  { trackName: 'slash', collectionName: 'slash (通常盤)', artistName: 'yama', artworkUrl100: 'https://img.ex/reg/100x100bb.jpg' }
                ]
              };
            }
          };
        }
        return { ok: true, async json() { return { results: [], releases: [] }; } };
      }
    });

    // Trigger IntersectionObserver for cd-01
    await app.triggerIntersection('cd-01');
    const cacheAfterLookup = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cacheAfterLookup['cd-01'].variants.length, 3);
    assert.equal(cacheAfterLookup['cd-01'].variants[0].isRegular, true);
    assert.equal(cacheAfterLookup['cd-01'].variants[0].url, 'https://coverartarchive.org/release/mb-reg/front-500');
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('1/3'));

    // Cycle variant with cycle-one and step-var and check carousel animation classes
    app.triggerDocumentClick('cycle-one', { 'data-id': 'cd-01' });
    await app.flush();
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('2/3'));
    assert.equal(app.elements.get('art-slot-cd-01').classList.contains('carousel-anim-next'), true);

    app.triggerDocumentClick('step-var', { 'data-id': 'cd-01', 'data-delta': '-1' });
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('1/3'));
    assert.equal(app.elements.get('art-slot-cd-01').classList.contains('carousel-anim-prev'), true);

    // Select specific variant index (2 > 0 -> carousel-anim-next)
    app.triggerDocumentClick('select-var', { 'data-id': 'cd-01', 'data-idx': '2' });
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('3/3'));
    assert.equal(app.elements.get('art-slot-cd-01').classList.contains('carousel-anim-next'), true);

    // Simulate broken cover image onerror -> splices active variant out and saves updated cache
    app.triggerImageError('cd-01');
    const cacheAfterBroken = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cacheAfterBroken['cd-01'].variants.length, 2);

    // Fetch cd-02 (returns empty results from mock API) -> falls back to SVG toast
    app.triggerDocumentClick('cycle-one', { 'data-id': 'cd-02' });
    await app.flush();
    assert.equal(app.elements.get('toast').textContent, 'Using bespoke Jewel Case SVG');

    // Force refetch cd-01 via refetch-one -> restores all 3 variants and shows toast
    app.triggerDocumentClick('refetch-one', { 'data-id': 'cd-01' });
    await app.flush();
    assert.ok(app.elements.get('toast').textContent.includes('Loaded 3 cover(s)'));
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('1/3'));

    // Refresh All while lightbox closed clears cover cache cleanly
    await app.clickElement('refreshAllBtn');
    assert.equal(app.localStorage.getItem(prefix + '_cover_cache_v6'), null);
    assert.equal(app.elements.get('toast').textContent, 'Cache cleared — resolving 通常盤 Regular covers first');

    // Refresh All while lightbox is open clears cache and immediately re-fetches active item
    await app.clickElement('openCrateFlipBtn');
    await app.clickElement('refreshAllBtn');
    assert.equal(app.elements.get('toast').textContent, 'Cache cleared — resolving 通常盤 Regular covers first');
    const refreshedCache = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.ok(refreshedCache && refreshedCache['cd-01']);
    assert.equal(refreshedCache['cd-02'], undefined);
  });

  it('enqueues cover lookups immediately when IntersectionObserver is unavailable', async () => {
    const catalog = makeRichTestCatalog({ includeDigital: false });
    class PassingImage {
      set src(_) {
        this.naturalWidth = 500;
        this.naturalHeight = 500;
        if (this.onload) this.onload();
      }
    }
    const app = await bootApp({
      catalogObject: catalog,
      disableIntersectionObserver: true,
      imageImpl: PassingImage,
      fetchImpl: async () => ({ ok: true, async json() { return { releases: [], results: [] }; } })
    });
    assert.equal(app.observedTargets.length, 0);
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('cd-01'));
  });
});

describe('Crate Flip Lightbox modal, navigation, and custom cover variant management', () => {
  it('opens, steps via buttons/keyboard/touch, manages custom variants, toggles acquired, and closes on Escape or empty filter', async () => {
    const catalog = makeRichTestCatalog();
    const prefix = deriveStoragePrefix({ meta: catalog.meta, items: catalog.items });

    const app = await bootApp({
      catalogObject: catalog,
      fetchImpl: async () => ({ ok: true, async json() { return { releases: [], results: [] }; } })
    });

    // Open via #openCrateFlipBtn (applies flip entrance)
    await app.clickElement('openCrateFlipBtn');
    const modal = app.elements.get('lightboxModal');
    const lbArtBox = app.elements.get('lbArtBox');
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(lbArtBox.classList.contains('carousel-anim-flip'), true);
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    assert.equal(app.elements.get('lbArtist').textContent, 'yama');

    // Step via buttons (directional carousel classes)
    await app.clickElement('lbNextBtn');
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    assert.equal(app.elements.get('lbArtist').textContent, 'Yoshino Aoki');
    assert.equal(lbArtBox.classList.contains('carousel-anim-next'), true);
    await app.clickElement('lbPrevBtn');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    assert.equal(lbArtBox.classList.contains('carousel-anim-prev'), true);

    // Step via keyboard (ignores when INPUT focused)
    await app.triggerKeydown('ArrowRight', 'INPUT');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    await app.triggerKeydown('ArrowRight');
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    assert.equal(lbArtBox.classList.contains('carousel-anim-next'), true);
    await app.triggerKeydown('ArrowLeft');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    assert.equal(lbArtBox.classList.contains('carousel-anim-prev'), true);

    // Swipe navigation restricted to #lbCoverFrame (dx < -45 -> next, dx > 45 -> prev; ignores #lbStage & vertical gestures)
    await app.swipeLightbox(-80, { targetId: 'lbStage' });
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    await app.swipeLightbox(-50, { dy: 120 });
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    await app.swipeLightbox(-80);
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    assert.equal(lbArtBox.classList.contains('carousel-anim-next'), true);
    await app.swipeLightbox(80);
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    assert.equal(lbArtBox.classList.contains('carousel-anim-prev'), true);

    // Rapid consecutive synchronous clicks never block or drop steps
    const nextBtn = app.elements.get('lbNextBtn');
    nextBtn.click();
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    nextBtn.click();
    assert.equal(app.elements.get('lbCounter').textContent, '3 / 3');
    assert.equal(app.elements.get('lbArtist').textContent, 'Hanatan');
    app.elements.get('lbPrevBtn').click();
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    app.elements.get('lbPrevBtn').click();
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    await app.flush();

    // Copy catalog in lightbox & toggle acquired
    await app.clickElement('lbCatalogBtn');
    assert.ok(app.copiedTexts.includes('SRCL-12539'));
    await app.clickElement('lbAcquireBtn');
    assert.equal(app.elements.get('lbAcquireBtn').textContent, '✓ In Crate (Acquired)');

    // Custom cover variant drawer: toggle, save Custom 通常盤 variant, preserve across refetch, then delete
    await app.clickElement('lbToggleCustomBtn');
    assert.equal(app.elements.get('customCoverDrawer').classList.contains('open'), true);
    app.elements.get('customCoverInput').value = 'https://custom.example/cover.jpg';
    app.elements.get('customCoverLabel').value = '通常盤 Custom';
    await app.clickElement('saveCustomCoverBtn');

    let cache = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cache['cd-01'].variants.length, 1);
    assert.equal(cache['cd-01'].variants[0].isRegular, true);
    assert.equal(app.elements.get('lbVariantsPanel').classList.contains('hidden'), false);
    assert.ok(app.elements.get('lbVariantsList').innerHTML.includes('通常盤 Custom'));

    // Refresh inside lightbox preserves custom variant even if APIs return empty
    await app.clickElement('lbRefreshCoverBtn');
    cache = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cache['cd-01'].variants.length, 1);

    // Delete variant via del-var
    app.triggerDocumentClick('del-var', { 'data-id': 'cd-01', 'data-idx': '0' });
    cache = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cache['cd-01'].variants.length, 0);
    assert.equal(app.elements.get('lbVariantsPanel').classList.contains('hidden'), true);

    // Navigate via filmstrip (open-lb while modal already open) and verify directional animation & digital button label
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '2' });
    assert.equal(lbArtBox.classList.contains('carousel-anim-next'), true);
    assert.equal(app.elements.get('lbAcquireBtn').textContent, '+ Mark Saved (Digital)');

    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '0' });
    assert.equal(lbArtBox.classList.contains('carousel-anim-prev'), true);

    // Escape closes lightbox
    await app.triggerKeydown('Escape');
    assert.equal(modal.classList.contains('open'), false);

    // Filter to 1 remaining unacquired item with Hunting Only, open lightbox, acquire it -> lightbox auto-closes
    app.triggerDocumentClick('set-cat', { 'data-cat': 'Games & OSTs' });
    await app.clickElement('huntingOnlyBtn');
    await app.clickElement('openCrateFlipBtn');
    assert.equal(modal.classList.contains('open'), true);
    await app.clickElement('lbAcquireBtn');
    assert.equal(modal.classList.contains('open'), false);
  });
});

describe('Backup & Restore modal, clipboard fallback, and legacy storage formats', () => {
  it('exports/imports backup JSON, handles invalid JSON, purges v1-v5 cover caches, and syncs legacy array checklists', async () => {
    const catalog = makeRichTestCatalog({ includeDigital: false });
    const prefix = deriveStoragePrefix({ meta: catalog.meta, items: catalog.items });

    const app = await bootApp({
      catalogObject: catalog,
      clipboardMode: 'reject',
      initialStorage: {
        [prefix + '_checklist_v2']: JSON.stringify([
          { id: 'cd-01', checked: false },
          { id: 'cd-02', checked: true }
        ]),
        [prefix + '_cover_cache_v1']: '{}',
        [prefix + '_cover_cache_v5']: '{}'
      }
    });

    // Legacy v1-v5 keys purged on load; legacy array checklist read
    assert.equal(app.localStorage.getItem(prefix + '_cover_cache_v1'), null);
    assert.equal(app.localStorage.getItem(prefix + '_cover_cache_v5'), null);
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 2');

    // Open backup modal -> copy falls back to execCommand on clipboard rejection
    await app.clickElement('backupBtn');
    assert.equal(app.elements.get('backupModal').classList.contains('open'), true);
    await app.clickElement('copyBackupBtn');
    assert.equal(app.copiedTexts.length, 1);
    assert.ok(app.elements.get('toast').textContent.startsWith('Copied:'));

    // Import valid JSON updating checklist, covers, and viewMode
    app.elements.get('backupTextarea').value = JSON.stringify({
      checklist: { 'cd-01': true, 'cd-02': true },
      covers: { 'cd-01': { variants: [{ url: 'https://ex.com/a.jpg', label: 'Reg', source: 'custom', isRegular: true }], selectedIndex: 0 } },
      viewMode: 'single'
    });
    await app.clickElement('importBackupBtn');
    assert.equal(app.elements.get('backupModal').classList.contains('open'), false);
    assert.equal(app.elements.get('progressBadge').textContent, '2 / 2');
    assert.equal(app.elements.get('viewModeLabel').textContent, 'Grid View');

    // Syncing an existing array checklist preserves array format on toggle
    const arrayKey = prefix + '_checklist_v2';
    app.localStorage.setItem(arrayKey, JSON.stringify([{ id: 'cd-01', checked: true }, { id: 'cd-02', checked: true }]));
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'cd-02' });
    const savedArray = JSON.parse(app.localStorage.getItem(arrayKey));
    assert.equal(Array.isArray(savedArray), true);
    assert.deepEqual(savedArray, [{ id: 'cd-01', checked: true }, { id: 'cd-02', checked: false }]);

    // Invalid JSON in backup textarea -> toast error, modal stays open
    await app.clickElement('backupBtn');
    app.elements.get('backupTextarea').value = '{invalid json';
    await app.clickElement('importBackupBtn');
    assert.equal(app.elements.get('toast').textContent, 'Invalid JSON format');
    await app.clickElement('closeBackupBtn');
    assert.equal(app.elements.get('backupModal').classList.contains('open'), false);
  });

  it('handles unavailable clipboard and throwing execCommand safely', async () => {
    const app = await bootApp({
      catalogObject: makeRichTestCatalog({ includeDigital: false }),
      clipboardMode: 'unavailable',
      execCommandThrow: true
    });
    app.triggerDocumentClick('copy-cat', { 'data-catno': 'SRCL-12539' });
    await app.flush();
    assert.equal(app.elements.get('toast').textContent, 'Copy failed');
  });
});

describe('Catalog Loader UI interactions and error edge cases', () => {
  it('supports Enter submit, Cancel button, explicit preset URLs, FileReader fallback, and loader errors', async () => {
    const remoteCatalog = makeValidRemoteCatalog();
    const indexWithExplicitUrl = {
      schemaVersion: 1,
      catalogs: [
        {
          id: 'explicit',
          title: 'Explicit Blob Preset',
          url: 'https://github.com/ex/repo/blob/main/explicit.json'
        }
      ]
    };

    const app = await bootApp({
      fetchImpl: async (url) => {
        if (url === 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json') {
          return { ok: true, status: 200, async json() { return indexWithExplicitUrl; } };
        }
        if (url === 'https://raw.githubusercontent.com/ex/repo/main/explicit.json') {
          return { ok: true, status: 200, async json() { return remoteCatalog; } };
        }
        return { ok: false, status: 404 };
      }
    });

    // Clicking Close before loading anything is a no-op
    await app.clickElement('closeCatalogLoaderBtn');
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), false);

    // Preset normalized from entry.url appears in #catalogPresetsList
    assert.ok(app.elements.get('catalogPresetsList').innerHTML.includes('https://raw.githubusercontent.com/ex/repo/main/explicit.json'));

    // Empty URL submit shows errorBanner
    app.elements.get('catalogUrlInput').value = '   ';
    await app.pressKey('catalogUrlInput', 'Enter');
    assert.equal(app.elements.get('errorBanner').style.display, 'block');
    assert.ok(app.elements.get('errorBanner').textContent.includes('valid metadata JSON'));

    // Non-existent remote URL HTTP 404 shows errorBanner
    app.elements.get('catalogUrlInput').value = 'https://example.com/missing.json';
    await app.pressKey('catalogUrlInput', 'Enter');
    assert.equal(app.elements.get('errorBanner').style.display, 'block');
    assert.ok(app.elements.get('errorBanner').textContent.includes('HTTP 404'));

    // Valid URL via Enter key loads catalog
    app.elements.get('catalogUrlInput').value = 'https://github.com/ex/repo/blob/main/explicit.json';
    await app.pressKey('catalogUrlInput', 'Enter');
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');

    // Open loader again and click Cancel -> closes cleanly & re-renders
    await app.clickElement('openCatalogLoaderBtn');
    assert.equal(app.elements.get('closeCatalogLoaderBtn').classList.contains('hidden'), false);
    await app.clickElement('closeCatalogLoaderBtn');
    assert.equal(app.elements.get('catalogLoaderScreen').classList.contains('hidden'), true);

    // FileReader fallback path (valid JSON, then malformed JSON, then read error)
    await app.selectLocalFile('reader-ok.json', makeRichTestCatalog({ includeDigital: false }), { useFileReader: true });
    assert.equal(app.elements.get('brandTitle').textContent, 'Rich Test Hunt');

    await app.selectLocalFile('reader-bad.json', '{not valid json', { useFileReader: true });
    assert.equal(app.elements.get('errorBanner').style.display, 'block');

    await app.selectLocalFile('reader-err.json', '{}', { useFileReader: true, failRead: true });
    assert.equal(app.elements.get('errorBanner').style.display, 'block');
    assert.ok(app.elements.get('errorBanner').textContent.includes('Failed to read file'));
  });

  it('displays offline preset fallback and empty index message appropriately', async () => {
    const appEmpty = await bootApp({
      fetchImpl: async () => ({ ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } })
    });
    assert.ok(appEmpty.elements.get('catalogPresetsList').innerHTML.includes('No presets found in index.json'));

    const appOffline = await bootApp({
      fetchImpl: async () => {
        throw new Error('offline');
      }
    });
    assert.ok(appOffline.elements.get('catalogPresetsList').innerHTML.includes('Presets unavailable offline'));
  });
});

function makeFakeSyncJwt(payload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      purpose: 'session',
      sub: '4242',
      login: 'alice',
      avatarUrl: 'https://avatars.githubusercontent.com/u/4242',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload
    })
  ).toString('base64url');
  return `${header}.${body}.dummy-sig`;
}

describe('GitHub Cloud Sync integration', () => {
  it('hides auth and sync controls when syncApiUrl is empty and redirects via location.assign when enabled', async () => {
    const appDisabled = await bootApp({
      catalogObject: JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8')),
      syncApiUrl: ''
    });
    assert.equal(appDisabled.elements.get('githubAuthBtn').classList.contains('hidden'), true);
    assert.equal(appDisabled.elements.get('githubSignOutBtn').classList.contains('hidden'), true);
    assert.equal(appDisabled.elements.get('syncStatusPill').classList.contains('hidden'), true);

    const appEnabled = await bootApp({
      catalogObject: JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8')),
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev'
    });
    assert.equal(appEnabled.elements.get('githubAuthBtn').classList.contains('hidden'), false);
    assert.equal(appEnabled.elements.get('githubSignOutBtn').classList.contains('hidden'), true);

    await appEnabled.clickElement('githubAuthBtn');
    assert.equal(appEnabled.locationNavigations.length, 1);
    assert.ok(
      appEnabled.locationNavigations[0].startsWith(
        'https://cd-hunt-sync.tndo.workers.dev/auth/login?redirect='
      )
    );
  });

  it('captures #auth_token hash, pulls cloud state to restore catalog/progress, and preserves local progress on sign-out', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const catalogUrl = 'https://cdn.example/sample-catalog.json';
    const prefix = deriveStoragePrefix({
      sourceUrl: catalogUrl,
      meta: sampleCatalog.meta,
      items: sampleCatalog.items
    });
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const putCalls = [];

    const app = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      hash: '#auth_token=' + encodeURIComponent(jwt),
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                user: { login: 'alice' },
                updatedAt: 1700000005000,
                state: {
                  schemaVersion: 1,
                  updatedAt: 1700000005000,
                  activeCatalogUrl: catalogUrl,
                  catalogs: {
                    [prefix]: {
                      updatedAt: 1700000005000,
                      checklist: { 'sample-01': true },
                      viewMode: 'grid',
                      noteDismissed: true,
                      customCovers: {
                        'sample-01': {
                          variants: [{ url: 'https://img.example/custom.jpg', label: 'Cloud Custom', catNo: '', source: 'custom', isRegular: true }],
                          selectedIndex: 0
                        }
                      },
                      selectedVariants: {
                        'sample-01': { url: 'https://img.example/custom.jpg', selectedIndex: 0 }
                      }
                    }
                  }
                }
              };
            }
          };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          putCalls.push(JSON.parse(init.body));
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (url === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    assert.equal(app.localStorage.getItem('cd_hunt_sync_token_v1'), jwt);
    assert.ok(app.historyUpdates.length >= 1);
    assert.equal(app.localStorage.getItem('cd_hunt_catalog_url_v1'), catalogUrl);
    assert.equal(app.elements.get('githubAuthBtn').classList.contains('hidden'), true);
    assert.equal(app.elements.get('githubSignOutBtn').classList.contains('hidden'), false);
    assert.ok(app.elements.get('syncStatusPill').textContent.includes('alice'));

    const checklistMap = JSON.parse(app.localStorage.getItem(prefix + '_checklist_v2'));
    assert.equal(checklistMap['sample-01'], true);
    const cache = JSON.parse(app.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.equal(cache['sample-01'].variants[0].label, 'Cloud Custom');
    assert.equal(cache['sample-01'].variants[0].source, 'custom');

    // Sign out preserves local catalog & acquired progress while clearing session token
    await app.clickElement('githubSignOutBtn');
    assert.equal(app.localStorage.getItem('cd_hunt_sync_token_v1'), null);
    assert.equal(app.elements.get('githubAuthBtn').classList.contains('hidden'), false);
    assert.equal(app.elements.get('githubSignOutBtn').classList.contains('hidden'), true);
    assert.equal(JSON.parse(app.localStorage.getItem(prefix + '_checklist_v2'))['sample-01'], true);
  });

  it('pushes debounced compact custom-cover-only payloads without public MusicBrainz bloat', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const catalogUrl = 'https://cdn.example/sample-catalog.json';
    const prefix = deriveStoragePrefix({
      sourceUrl: catalogUrl,
      meta: sampleCatalog.meta,
      items: sampleCatalog.items
    });
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const putRequests = [];

    const app = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      savedCatalogUrl: catalogUrl,
      initialStorage: {
        cd_hunt_sync_token_v1: jwt,
        [prefix + '_cover_cache_v6']: {
          'dig-01': {
            variants: [{ url: 'https://coverartarchive.org/release/mb-1/front-500.jpg', label: 'Regular', catNo: 'SRCL-1', source: 'musicbrainz', isRegular: true }],
            selectedIndex: 0
          }
        }
      },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return { user: { login: 'alice' }, state: null, updatedAt: null };
            }
          };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          putRequests.push({
            auth: init.headers && (init.headers.Authorization || init.headers.authorization),
            body: JSON.parse(init.body)
          });
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (url === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    const initialPuts = putRequests.length;

    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '0' });
    await app.clickElement('lbToggleCustomBtn');
    app.elements.get('customCoverInput').value = 'https://img.example/only-custom.jpg';
    app.elements.get('customCoverLabel').value = 'Custom Edition';
    await app.clickElement('saveCustomCoverBtn');
    await app.flush();

    assert.ok(putRequests.length > initialPuts, 'Expected debounced PUT /api/state request');
    const latest = putRequests[putRequests.length - 1];
    assert.equal(latest.auth, 'Bearer ' + jwt);
    const catState = latest.body.catalogs[prefix];
    assert.equal(catState.checklist['sample-01'], true);
    assert.ok(catState.customCovers['sample-01']);
    assert.equal(catState.customCovers['sample-01'].variants[0].url, 'https://img.example/only-custom.jpg');
    assert.equal(catState.customCovers['dig-01'], undefined, 'Public MusicBrainz covers must not be synced');
  });

  it('auto-discovers <login>/cd-metadata/main/index.json when signed in without an active catalog and falls back cleanly on 404', async () => {
    const userCatalogUrl = 'https://raw.githubusercontent.com/alice/cd-metadata/main/main.json';
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const requestedUrls = [];

    const appFound = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        requestedUrls.push(String(url));
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (url === 'https://raw.githubusercontent.com/alice/cd-metadata/main/index.json') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                schemaVersion: 1,
                catalogs: [{ title: 'Alice Custom', url: userCatalogUrl }]
              };
            }
          };
        }
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    assert.ok(requestedUrls.includes('https://raw.githubusercontent.com/alice/cd-metadata/main/index.json'));
    assert.equal(appFound.elements.get('catalogLoaderScreen').classList.contains('hidden'), false);
    assert.equal(
      appFound.elements.get('catalogUrlInput').value,
      'https://raw.githubusercontent.com/alice/cd-metadata/main/index.json'
    );
    assert.ok(appFound.elements.get('activeCatalogInfo').textContent.includes('Loaded alice/cd-metadata'));
    assert.ok(appFound.elements.get('catalogPresetsList').innerHTML.includes('Alice Custom'));

    const app404 = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (url === 'https://raw.githubusercontent.com/alice/cd-metadata/main/index.json') {
          return { ok: false, status: 404, async json() { return {}; } };
        }
        if (String(url).endsWith('/index.json')) {
          return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    assert.equal(app404.localStorage.getItem('cd_hunt_catalog_url_v1'), null);
    assert.equal(app404.elements.get('catalogLoaderScreen').classList.contains('hidden'), false);
  });

  it('degrades gracefully on 503 paused, 429 rate-limited, 401 expired session, and offline pull errors', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const jwt = makeFakeSyncJwt({ login: 'alice' });

    const app503 = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url) => {
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state') {
          return { ok: false, status: 503, async json() { return { paused: true, resetsAt: '00:00 UTC' }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    assert.ok(app503.elements.get('syncStatusPill').textContent.includes('Paused until 00:00 UTC'));

    const app429 = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          return { ok: false, status: 429, headers: new Map([['Retry-After', '30']]), async json() { return { retryAfterSeconds: 30 }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    app429.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app429.flush();
    assert.ok(app429.elements.get('syncStatusPill').textContent.includes('Rate limited'));

    const app401 = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url) => {
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state') {
          return { ok: false, status: 401, async json() { return { error: 'Unauthorized' }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    assert.ok(app401.elements.get('syncStatusPill').textContent.includes('Session expired'));
    assert.equal(app401.localStorage.getItem('cd_hunt_sync_token_v1'), null);
    assert.equal(app401.elements.get('githubAuthBtn').classList.contains('hidden'), false);

    const appOffline = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url) => {
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state') {
          throw new Error('network down');
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    assert.ok(appOffline.elements.get('syncStatusPill').textContent.includes('Offline'));
  });

  it('flushes pending debounced pushes immediately with keepalive on visibilitychange/pagehide and skips when idle or signed out', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const catalogUrl = 'https://cdn.example/sample-catalog.json';
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const putCalls = [];

    const app = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 5000,
      savedCatalogUrl: catalogUrl,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                user: { login: 'alice' },
                updatedAt: 1000,
                state: { schemaVersion: 1, updatedAt: 1000, activeCatalogUrl: catalogUrl, catalogs: {} }
              };
            }
          };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          putCalls.push({ keepalive: init.keepalive, body: JSON.parse(init.body) });
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (url === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    // No pending timer -> visibilitychange / pagehide do not fire redundant PUTs
    await app.triggerVisibilityChange('hidden');
    await app.triggerPageHide();
    assert.equal(putCalls.length, 0);

    // Pending edit -> visibilitychange('hidden') immediately flushes once with keepalive: true
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app.triggerVisibilityChange('hidden');
    await app.triggerPageHide();
    assert.equal(putCalls.length, 1);
    assert.equal(putCalls[0].keepalive, true);

    // Sign out with pending edit -> cleared timer must not fire on pagehide
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app.clickElement('githubSignOutBtn');
    await app.triggerPageHide();
    assert.equal(putCalls.length, 1);
  });

  it('handles mid-session PUT 413, 401, 503 paused short-circuit, and offline PUT failures', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const jwt = makeFakeSyncJwt({ login: 'alice' });

    let nextPutStatus = 413;
    let putCount = 0;

    const app = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 10,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          putCount++;
          if (nextPutStatus === 'offline') {
            throw new Error('put network error');
          }
          if (nextPutStatus === 413) {
            return { ok: false, status: 413, async json() { return { error: 'Payload too large' }; } };
          }
          if (nextPutStatus === 503) {
            return { ok: false, status: 503, async json() { return { paused: true, resetsAt: '00:00 UTC' }; } };
          }
          if (nextPutStatus === 401) {
            return { ok: false, status: 401, async json() { return { error: 'Unauthorized' }; } };
          }
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    // 413 Payload Too Large
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app.flush();
    assert.ok(app.elements.get('syncStatusPill').textContent.includes('Too large for cloud'));

    // Network failure on PUT -> Offline status
    nextPutStatus = 'offline';
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app.flush();
    assert.ok(app.elements.get('syncStatusPill').textContent.includes('Offline — saved locally'));

    // 503 Paused on PUT -> enters paused state and short-circuits further PUT requests
    nextPutStatus = 503;
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app.flush();
    assert.ok(app.elements.get('syncStatusPill').textContent.includes('Paused until 00:00 UTC'));
    const countWhenPaused = putCount;
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'dig-01' });
    await app.flush();
    assert.equal(putCount, countWhenPaused, 'Paused client must not hammer /api/state');

    // Fresh boot for mid-session 401 Unauthorized on PUT
    const app401Put = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 10,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          return { ok: false, status: 401, async json() { return { error: 'Unauthorized' }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    app401Put.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    await app401Put.flush();
    assert.equal(app401Put.localStorage.getItem('cd_hunt_sync_token_v1'), null);
    assert.equal(app401Put.elements.get('githubAuthBtn').classList.contains('hidden'), false);
    assert.ok(app401Put.elements.get('syncStatusPill').textContent.includes('Session expired'));
  });

  it('conserves D1 write quota across rapid toggles and background cover lookups while pushing UI mutations and honoring ?syncApi= safely', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const catalogUrl = 'https://cdn.example/sample-catalog.json';
    const prefix = deriveStoragePrefix({
      sourceUrl: catalogUrl,
      meta: sampleCatalog.meta,
      items: sampleCatalog.items
    });
    const jwt = makeFakeSyncJwt({ login: 'alice' });

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

    // 1) Coalescing rapid toggles + zero PUTs during background cover resolution
    const coalescePuts = [];
    const appCoalesce = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 40,
      savedCatalogUrl: catalogUrl,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      imageImpl: MockVerifiedImage,
      fetchImpl: async (url, init = {}) => {
        const s = String(url);
        const method = String(init.method || 'GET').toUpperCase();
        if (s === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                user: { login: 'alice' },
                updatedAt: 1000,
                state: { schemaVersion: 1, updatedAt: 1000, activeCatalogUrl: catalogUrl, catalogs: {} }
              };
            }
          };
        }
        if (s === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          coalescePuts.push(JSON.parse(init.body));
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (s === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        if (s.includes('musicbrainz.org/ws/2/release/')) {
          return { ok: true, status: 200, async json() { return { releases: [{ id: 'mb-rel-1', status: 'Official' }] }; } };
        }
        if (s.includes('coverartarchive.org/release/mb-rel-1')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { images: [{ front: true, thumbnails: { '500': 'https://img.example/mb-front-500.jpg' } }] };
            }
          };
        }
        if (s.includes('itunes.apple.com/search')) {
          return { ok: true, status: 200, async json() { return { results: [] }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    // Background MusicBrainz cover resolution caches locally but makes 0 cloud PUTs
    await appCoalesce.triggerIntersection('sample-01');
    await new Promise((r) => setTimeout(r, 60));
    const localCache = JSON.parse(appCoalesce.localStorage.getItem(prefix + '_cover_cache_v6'));
    assert.ok(localCache && localCache['sample-01'] && localCache['sample-01'].variants.length > 0);
    assert.equal(coalescePuts.length, 0, 'Background cover resolution must not trigger cloud PUTs');

    // 5 rapid synchronous clicks coalesce into 1 PUT
    for (let i = 0; i < 5; i++) {
      appCoalesce.triggerDocumentClick('toggle-acq', { 'data-id': 'sample-01' });
    }
    await new Promise((r) => setTimeout(r, 75));
    assert.equal(coalescePuts.length, 1);

    // 2) All explicit user mutation entrypoints trigger a cloud push + ?syncApi= override validation
    const requestedUrlsLoopback = [];
    const appMutations = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      search: '?syncApi=http://127.0.0.1:8787',
      syncDebounceMs: 10,
      savedCatalogUrl: catalogUrl,
      initialStorage: {
        cd_hunt_sync_token_v1: jwt,
        [prefix + '_cover_cache_v6']: {
          'sample-01': {
            variants: [
              { url: 'https://custom.example/a.jpg', label: 'A', catNo: '', source: 'custom', isRegular: true },
              { url: 'https://custom.example/b.jpg', label: 'B', catNo: '', source: 'custom', isRegular: false }
            ],
            selectedIndex: 0
          }
        }
      },
      fetchImpl: async (url, init = {}) => {
        const s = String(url);
        requestedUrlsLoopback.push(`${String(init.method || 'GET').toUpperCase()} ${s}`);
        const method = String(init.method || 'GET').toUpperCase();
        if (s === 'http://127.0.0.1:8787/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (s === 'http://127.0.0.1:8787/api/state' && method === 'PUT') {
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (s === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    const countPuts = () => requestedUrlsLoopback.filter((x) => x === 'PUT http://127.0.0.1:8787/api/state').length;
    await appMutations.flush();
    const basePuts = countPuts();

    await appMutations.clickElement('viewModeBtn');
    assert.equal(countPuts(), basePuts + 1, 'viewModeBtn should push');

    await appMutations.clickElement('dismissNoteBtn');
    assert.equal(countPuts(), basePuts + 2, 'dismissNoteBtn should push');

    await appMutations.clickElement('restoreNoteBtn');
    assert.equal(countPuts(), basePuts + 3, 'restoreNoteBtn should push');

    appMutations.triggerDocumentClick('select-var', { 'data-id': 'sample-01', 'data-idx': '1' });
    await appMutations.flush();
    assert.equal(countPuts(), basePuts + 4, 'select-var should push');

    appMutations.triggerDocumentClick('del-var', { 'data-id': 'sample-01', 'data-idx': '1' });
    await appMutations.flush();
    assert.equal(countPuts(), basePuts + 5, 'del-var should push');

    appMutations.elements.get('backupTextarea').value = JSON.stringify({
      checklist: { 'sample-01': true },
      covers: {},
      viewMode: 'grid'
    });
    await appMutations.clickElement('importBackupBtn');
    assert.equal(countPuts(), basePuts + 6, 'importBackupBtn should push');

    // Non-loopback ?syncApi=https://evil.example must be ignored in favor of config.syncApiUrl
    const evilUrls = [];
    await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      search: '?syncApi=https://evil.example',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url) => {
        evilUrls.push(String(url));
        return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, state: null, updatedAt: null }; } };
      }
    });
    assert.equal(evilUrls.some((u) => u.includes('evil.example')), false);
    assert.ok(evilUrls.includes('https://cd-hunt-sync.tndo.workers.dev/api/state'));
  });
});

describe('Priority and Recommended Shops rendering', () => {
  it('renders priority badge and recommended shops in 1-Col view and Crate Flip lightbox when provided, and hides them when omitted', async () => {
    const customCatalog = {
      schemaVersion: 1,
      meta: {
        title: 'Shops & Priority Test',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/example123/edit'
      },
      categories: [
        { key: 'All', label: 'All', dot: '#a1a1aa' },
        { key: 'Game', label: 'Game', dot: '#f59e0b' }
      ],
      items: [
        {
          id: 'prio-01',
          category: 'Game',
          artist: 'Capcom',
          title: 'Breath of Fire III OST',
          regCatNo: 'CPCA-1004',
          catalog: 'CPCA-1004 (通常盤)',
          kana: 'フ / B',
          filing: 'ブ (Breath of Fire)',
          price: '¥3,000–¥6,000',
          priority: 'High',
          recommendedShops: 'Mandarake Grandchaos, Suruga-ya'
        },
        {
          id: 'prio-02',
          category: 'Game',
          artist: 'Generic Artist',
          title: 'Plain Album',
          regCatNo: 'ABCD-0001',
          catalog: 'ABCD-0001',
          kana: 'シ / G',
          filing: 'シ (Generic)',
          price: '¥500–¥900'
        },
        {
          id: 'prio-03',
          category: 'Game',
          artist: 'Low Artist',
          title: 'Low Prio Album',
          regCatNo: 'LOW-0001',
          catalog: 'LOW-0001',
          kana: 'ロ / L',
          filing: 'ロ (Low)',
          price: '¥200–¥400',
          priority: 'Low',
          recommendedShops: 'Book Off'
        }
      ]
    };

    const app = await bootApp({ catalogObject: customCatalog });

    // Switch to 1-Col view and verify inline priority badge + recommended shops render cleanly
    await app.clickElement('viewModeBtn');
    const gridHtml = app.elements.get('albumGrid').innerHTML;
    assert.ok(gridHtml.includes('Priority: High'));
    assert.ok(gridHtml.includes('priority-high'));
    assert.ok(gridHtml.includes('Priority: Low'));
    assert.ok(gridHtml.includes('priority-low'));
    assert.ok(gridHtml.includes('Mandarake Grandchaos, Suruga-ya'));

    // Lightbox item 0 (has priority + recommendedShops)
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '0' });
    assert.equal(app.elements.get('lbPriorityBadge').classList.contains('hidden'), false);
    assert.equal(app.elements.get('lbPriorityBadge').textContent, 'Priority: High');
    assert.equal(app.elements.get('lbShopsRow').classList.contains('hidden'), false);
    assert.equal(app.elements.get('lbShops').textContent, 'Mandarake Grandchaos, Suruga-ya');

    // Lightbox item 1 (omits both priority + recommendedShops -> cleanly hidden)
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '1' });
    assert.equal(app.elements.get('lbPriorityBadge').classList.contains('hidden'), true);
    assert.equal(app.elements.get('lbPriorityBadge').textContent, '');
    assert.equal(app.elements.get('lbShopsRow').classList.contains('hidden'), true);
    assert.equal(app.elements.get('lbShops').textContent, '');
  });
});

describe('Google Sheet direct loading, JSON hybrid overlay, and Agent Link button', () => {
  it('loads a public Google Sheet URL directly via CSV export, applies Got it? checkmarks, and renders items', async () => {
    const csvText = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'sample-catalog-sheet.csv'), 'utf8')
      .replace('FALSE,Video Game Soundtracks,Capcom', 'TRUE,Video Game Soundtracks,Capcom');
    const fetchedUrls = [];

    const app = await bootApp({
      search: '?catalog=' + encodeURIComponent('https://docs.google.com/spreadsheets/d/sheet123abc/edit?usp=drivesdk'),
      fetchImpl: async (url) => {
        fetchedUrls.push(String(url));
        if (String(url) === 'https://docs.google.com/spreadsheets/d/sheet123abc/export?format=csv') {
          return {
            ok: true,
            status: 200,
            async text() {
              return csvText;
            }
          };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    assert.ok(fetchedUrls.includes('https://docs.google.com/spreadsheets/d/sheet123abc/export?format=csv'));
    assert.notEqual(app.elements.get('errorBanner').style.display, 'block');
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 3');
    const gridHtml = app.elements.get('albumGrid').innerHTML;
    assert.ok(gridHtml.includes('Capcom'));
    assert.ok(gridHtml.includes('CPCA-1004'));
    assert.ok(app.elements.get('digitalGrid').innerHTML.includes('Hanatan'));
  });

  it('merges live Google Sheet overlay onto JSON catalog with meta.googleSheetUrl and falls back offline', async () => {
    const baseJson = {
      schemaVersion: 1,
      meta: {
        title: 'Hybrid Hunt',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/hybrid999/edit'
      },
      categories: [
        { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
        { key: 'J-Rock', label: 'J-Rock', dot: '#f43f5e' }
      ],
      items: [
        {
          id: 'cur-akfg',
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
    };

    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'TRUE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,High,"Book Off, Disk Union"',
      'FALSE,Game OST,Keiichi Okabe,NieR:Automata OST,SQEX-10589~91,Look under ナ,¥2,500,Medium,Mandarake'
    ].join('\n');

    const appMerged = await bootApp({
      search: '?catalog=' + encodeURIComponent('https://cdn.example/hybrid.json'),
      fetchImpl: async (url) => {
        if (String(url) === 'https://cdn.example/hybrid.json') {
          return { ok: true, status: 200, async json() { return baseJson; } };
        }
        if (String(url) === 'https://docs.google.com/spreadsheets/d/hybrid999/export?format=csv') {
          return { ok: true, status: 200, async text() { return sheetCsv; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });

    assert.equal(appMerged.elements.get('progressBadge').textContent, '1 / 2');
    assert.ok(appMerged.elements.get('albumGrid').innerHTML.includes('NieR:Automata OST'));

    // Offline fallback when Google Sheet CSV fails to load
    const appFallback = await bootApp({
      search: '?catalog=' + encodeURIComponent('https://cdn.example/hybrid.json'),
      fetchImpl: async (url) => {
        if (String(url) === 'https://cdn.example/hybrid.json') {
          return { ok: true, status: 200, async json() { return baseJson; } };
        }
        if (String(url) === 'https://docs.google.com/spreadsheets/d/hybrid999/export?format=csv') {
          throw new Error('Sheet unreachable offline');
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });
    assert.equal(appFallback.elements.get('progressBadge').textContent, '0 / 1');
    assert.notEqual(appFallback.elements.get('errorBanner').style.display, 'block');
  });

  it('reveals #copyAgentLinkBtn when pullCloudState returns shareUrl and copies Markdown share link', async () => {
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const shareUrl = 'https://cd-hunt-sync.tndo.workers.dev/api/share/signed-share-token-abc';

    const app = await bootApp({
      catalogObject: sampleCatalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                user: { login: 'alice' },
                state: null,
                updatedAt: null,
                shareToken: 'signed-share-token-abc',
                shareUrl
              };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    const agentBtn = app.elements.get('copyAgentLinkBtn');
    assert.equal(agentBtn.classList.contains('hidden'), false);
    await app.clickElement('copyAgentLinkBtn');
    assert.ok(app.copiedTexts.includes(shareUrl + '?format=markdown'));
    assert.equal(app.elements.get('toast').textContent, 'Copied semi-private Agent status link');

    await app.clickElement('githubSignOutBtn');
    assert.equal(agentBtn.classList.contains('hidden'), true);
  });

  it('loads local .csv files via #catalogFileInput without needing JSON', async () => {
    const csvText = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'sample-catalog-sheet.csv'), 'utf8')
      .replace('FALSE,Video Game Soundtracks,Capcom', 'TRUE,Video Game Soundtracks,Capcom');

    const app = await bootApp();
    await app.selectLocalFile('trip-sheet.csv', csvText);

    assert.equal(app.elements.get('progressBadge').textContent, '1 / 3');
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('CPCA-1004'));
    assert.equal(app.elements.get('toast').textContent, 'Loaded local CSV: trip-sheet.csv');
    assert.equal(app.elements.get('copyShareLinkBtn').classList.contains('hidden'), true);

    // Also handles CSV content even if filename lacks .csv extension (both Disk Crate and legacy CD Hunt headers)
    await app.selectLocalFile('exported-sheet.txt', csvText);
    assert.equal(app.elements.get('toast').textContent, 'Loaded local CSV: exported-sheet.txt');

    const legacyPrefixCsvText = csvText.replace(
      'Disk Crate Physical & Digital Release Checklist',
      'CD Hunt Physical & Digital Release Checklist'
    );
    await app.selectLocalFile('legacy-exported-sheet.txt', legacyPrefixCsvText);
    assert.equal(app.elements.get('toast').textContent, 'Loaded local CSV: legacy-exported-sheet.txt');
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 3');
  });

  it('caches Google Sheet CSV offline and preserves explicit local unchecks across Sheet reloads', async () => {
    const csvText = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'TRUE,Game OST,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,¥3000,High,Mandarake',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
    ].join('\n');
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/offlineSheet1/edit';
    const exportUrl = 'https://docs.google.com/spreadsheets/d/offlineSheet1/export?format=csv';

    // 1. Initial online load: seeds CPCA-1004 (TRUE in Sheet) and caches CSV locally
    const app1 = await bootApp({
      search: '?catalog=' + encodeURIComponent(sheetUrl),
      fetchImpl: async (url) => {
        if (String(url) === exportUrl) {
          return { ok: true, status: 200, async text() { return csvText; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });
    assert.equal(app1.elements.get('progressBadge').textContent, '1 / 2');

    // User explicitly unchecks CPCA-1004 inside cd-hunt
    app1.triggerDocumentClick('toggle-acq', { 'data-id': 'sheet-cpca-1004' });
    assert.equal(app1.elements.get('progressBadge').textContent, '0 / 2');

    // 2. Subsequent offline reload with saved localStorage: restores CSV from offline cache
    //    AND preserves explicit uncheck instead of re-checking CPCA-1004 from stale TRUE in Sheet
    const savedSnapshot = Object.fromEntries(app1.localStorage._store.entries());
    const appOffline = await bootApp({
      initialStorage: savedSnapshot,
      fetchImpl: async (url) => {
        if (String(url) === exportUrl) {
          throw new Error('Device offline');
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });
    assert.equal(appOffline.elements.get('toast').textContent, 'Loaded cached Google Sheet (offline)');
    assert.equal(appOffline.elements.get('progressBadge').textContent, '0 / 2');
    assert.ok(appOffline.elements.get('albumGrid').innerHTML.includes('Sol-fa'));
  });

  it('reveals #sheetSyncBotBanner with Service Account email when /api/status reports configured, and hides when unconfigured', async () => {
    const botEmail = 'cd-hunt-sync@cd-hunt-sheets.iam.gserviceaccount.com';
    const appConfigured = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      fetchImpl: async (url) => {
        if (String(url) === 'https://cd-hunt-sync.tndo.workers.dev/api/status') {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, sheetSync: { configured: true, serviceAccountEmail: botEmail } };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    const banner = appConfigured.elements.get('sheetSyncBotBanner');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.ok(appConfigured.elements.get('sheetSyncBotText').textContent.includes(botEmail));
    await appConfigured.clickElement('copySheetBotEmailBtn');
    assert.ok(appConfigured.copiedTexts.includes(botEmail));

    const appUnconfigured = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      fetchImpl: async (url) => {
        if (String(url) === 'https://cd-hunt-sync.tndo.workers.dev/api/status') {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, sheetSync: { configured: false, serviceAccountEmail: null } };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    assert.equal(appUnconfigured.elements.get('sheetSyncBotBanner').classList.contains('hidden'), true);
  });

  it('auto-deduplicates duplicate rows across Google Sheet URL, local CSV, hybrid overlay, and warns on duplicate JSON', async () => {
    const dupSheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Game OST,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,¥3000,,',
      'TRUE,Game OST,Capcom,Breath of Fire III OST (Dup),CPCA-1004,Look under ブ,¥3500,High,Mandarake',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
    ].join('\n');

    // 1) Direct Google Sheet load via submit UI -> deduplicates 3 rows to 2 cards & shows warning toast
    const appSheet = await bootApp({
      fetchImpl: async (url) => {
        if (String(url).includes('export?format=csv')) {
          return { ok: true, status: 200, async text() { return dupSheetCsv; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    await appSheet.inputText('catalogUrlInput', 'https://docs.google.com/spreadsheets/d/dupSheet99/edit');
    await appSheet.clickElement('loadCatalogUrlBtn');
    assert.equal(appSheet.elements.get('progressBadge').textContent, '1 / 2');
    assert.ok(appSheet.elements.get('toast').textContent.includes('Merged 1 duplicate row (CPCA-1004)'));

    // 2) Local .csv upload -> deduplicates & includes merge notice in toast
    await appSheet.selectLocalFile('dups.csv', dupSheetCsv);
    assert.equal(appSheet.elements.get('progressBadge').textContent, '1 / 2');
    assert.ok(appSheet.elements.get('toast').textContent.includes('Loaded local CSV: dups.csv'));
    assert.ok(appSheet.elements.get('toast').textContent.includes('Merged 1 duplicate row'));

    // 3) Standalone JSON catalog containing duplicate regCatNo -> shows non-blocking warning toast
    const dupJsonCatalog = {
      schemaVersion: 1,
      meta: { title: 'Dup JSON Check' },
      items: [
        {
          id: 'j1',
          category: 'Rock',
          artist: 'AKFG',
          title: 'Sol-fa',
          regCatNo: 'KSCL-737',
          catalog: 'KSCL-737',
          kana: 'ア',
          filing: 'Look under ア',
          price: '¥500'
        },
        {
          id: 'j2',
          category: 'Rock',
          artist: 'AKFG',
          title: 'Sol-fa Duplicate',
          regCatNo: 'KSCL-737',
          catalog: 'KSCL-737',
          kana: 'ア',
          filing: 'Look under ア',
          price: '¥500'
        }
      ]
    };
    const appJson = await bootApp({
      search: '?catalog=' + encodeURIComponent('https://cdn.example/dup.json'),
      fetchImpl: async (url) => {
        if (String(url) === 'https://cdn.example/dup.json') {
          return { ok: true, status: 200, async json() { return dupJsonCatalog; } };
        }
        throw new Error('Unexpected fetch: ' + url);
      }
    });
    assert.ok(appJson.elements.get('toast').textContent.includes('Warning: 1 duplicate catalog entry (KSCL-737)'));
  });

  it('handles hybrid JSON + Google Sheet deduplication, offline cached duplicate Sheet reload, local duplicate JSON, and content-sniffed CSV upload', async () => {
    const hybridJson = {
      schemaVersion: 1,
      meta: {
        title: 'Hybrid Dup',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/hybridDup1/edit'
      },
      items: [
        {
          id: 'cur-akfg',
          category: 'J-Rock',
          artist: 'Asian Kung-Fu Generation',
          title: 'Sol-fa',
          regCatNo: 'KSCL-737',
          catalog: 'KSCL-737',
          kana: 'ア',
          filing: 'Look under ア',
          price: '¥500'
        }
      ]
    };
    const hybridSheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off',
      'FALSE,Game OST,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,"¥3,000",,',
      'TRUE,Game OST,Capcom,Breath of Fire III OST (Dup),CPCA-1004,Look under ブ,"¥3,500",High,Mandarake'
    ].join('\n');

    // 1) Hybrid JSON + meta.googleSheetUrl with duplicate Sheet rows
    const appHybrid = await bootApp({
      fetchImpl: async (url) => {
        if (String(url) === 'https://cdn.example/hybrid-dup.json') {
          return { ok: true, status: 200, async json() { return hybridJson; } };
        }
        if (String(url) === 'https://docs.google.com/spreadsheets/d/hybridDup1/export?format=csv') {
          return { ok: true, status: 200, async text() { return hybridSheetCsv; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    await appHybrid.inputText('catalogUrlInput', 'https://cdn.example/hybrid-dup.json');
    await appHybrid.clickElement('loadCatalogUrlBtn');
    assert.equal(appHybrid.elements.get('progressBadge').textContent, '1 / 2');
    assert.ok(appHybrid.elements.get('toast').textContent.includes('Merged 1 duplicate row (CPCA-1004)'));
    await appHybrid.clickElement('viewModeBtn');
    const gridHtml = appHybrid.elements.get('albumGrid').innerHTML;
    assert.ok(gridHtml.includes('Priority: High'));
    assert.ok(gridHtml.includes('Mandarake'));

    // 2) Offline cached Google Sheet reload with duplicates (app.js line 473)
    const dupSheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Game OST,Capcom,Breath of Fire III OST,CPCA-1004,Look under ブ,"¥3,000",,',
      'TRUE,Game OST,Capcom,Breath of Fire III OST (Dup),CPCA-1004,Look under ブ,"¥3,500",High,Mandarake',
      'FALSE,J-Rock,Asian Kung-Fu Generation,Sol-fa,KSCL-737,Look under ア,¥500,Medium,Book Off'
    ].join('\n');

    const appOnline = await bootApp({
      fetchImpl: async (url) => {
        if (String(url) === 'https://docs.google.com/spreadsheets/d/dupCache99/export?format=csv') {
          return { ok: true, status: 200, async text() { return dupSheetCsv; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    await appOnline.inputText('catalogUrlInput', 'https://docs.google.com/spreadsheets/d/dupCache99/edit');
    await appOnline.clickElement('loadCatalogUrlBtn');
    assert.equal(appOnline.elements.get('progressBadge').textContent, '1 / 2');

    const cachedSnapshot = Object.fromEntries(appOnline.localStorage._store.entries());
    const appOffline = await bootApp({
      initialStorage: cachedSnapshot,
      fetchImpl: async (url) => {
        if (String(url).includes('export?format=csv')) {
          throw new Error('offline');
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });
    const offlineToast = appOffline.elements.get('toast').textContent;
    assert.ok(offlineToast.includes('Loaded cached Google Sheet (offline)'));
    assert.ok(offlineToast.includes('Merged 1 duplicate row (CPCA-1004)'));
    assert.equal(appOffline.elements.get('progressBadge').textContent, '1 / 2');

    // 3) Local .json upload with duplicate regCatNo
    const dupJsonCatalog = {
      schemaVersion: 1,
      meta: { title: 'Local Dup JSON' },
      items: [
        { id: 'j1', category: 'Rock', artist: 'AKFG', title: 'Sol-fa', regCatNo: 'KSCL-737', catalog: 'KSCL-737', kana: 'ア', filing: 'Look under ア', price: '¥500' },
        { id: 'j2', category: 'Rock', artist: 'AKFG', title: 'Sol-fa Dup', regCatNo: 'KSCL-737', catalog: 'KSCL-737', kana: 'ア', filing: 'Look under ア', price: '¥500' }
      ]
    };
    await appOffline.selectLocalFile('dup-local.json', JSON.stringify(dupJsonCatalog));
    const localJsonToast = appOffline.elements.get('toast').textContent;
    assert.ok(localJsonToast.includes('Loaded local file: dup-local.json'));
    assert.ok(localJsonToast.includes('Warning: 1 duplicate catalog entry (KSCL-737)'));

    // 4) Content-sniffed CSV upload with non-.csv extension
    await appOffline.selectLocalFile('sheet-export.txt', dupSheetCsv);
    assert.equal(appOffline.elements.get('progressBadge').textContent, '1 / 2');
    const sniffToast = appOffline.elements.get('toast').textContent;
    assert.ok(sniffToast.includes('Loaded local CSV: sheet-export.txt'));
    assert.ok(sniffToast.includes('Merged 1 duplicate row (CPCA-1004)'));
  });

  it('produces clean Crate Flip jacket search links and resolves iTunes covers from real-world Sheet rows', async () => {
    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Anime,(K)NoW_NAME,"""KNOCK on the CORE / Ash-like Snow"" (Fairy gone S1 OP & ED)",THCS-60240,Look under ノ,¥700,Medium,Suruga-ya',
      'FALSE,Seiyuu,Rico Sasaki (佐々木李子),スタート! (Start!) (Artist Editions ONLY for Track 4 "フレンドパスワード" — Skip AKCY-58073),AKCY-58075 (Artist CD+Photobook) / AKCY-58074/B (Artist CD+DVD),Look under サ,¥1200,High,Animate',
      'FALSE,Digital-Only,Rokudenashi (ロクデナシ),"""ホウキボシ"" (Houkiboshi)",N/A (Digital Only),Digital only,,Low,iTunes JP'
    ].join('\n');

    class VerifiedMockImg {
      set src(_) {
        this.naturalWidth = 600;
        this.naturalHeight = 600;
        if (this.onload) this.onload();
      }
    }

    const seenItunesUrls = [];
    const app = await bootApp({
      imageImpl: VerifiedMockImg,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('export?format=csv')) {
          return { ok: true, status: 200, async text() { return sheetCsv; } };
        }
        if (u.includes('musicbrainz.org')) {
          return { ok: true, status: 200, async json() { return { releases: [] }; } };
        }
        if (u.includes('itunes.apple.com')) {
          seenItunesUrls.push(u);
          if (u.includes(encodeURIComponent('(K)NoW_NAME KNOCK on the CORE')) && u.includes('country=jp')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  results: [
                    {
                      trackName: 'KNOCK on the CORE',
                      collectionName: 'TVアニメ『Fairy gone』OP&ED「KNOCK on the CORE/Ash-like Snow」 - EP',
                      artistName: '(K)NoW_NAME',
                      artworkUrl100: 'https://img.example/know/100x100bb.jpg'
                    }
                  ]
                };
              }
            };
          }
          if (u.includes(encodeURIComponent('佐々木李子 スタート!'))) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  results: [
                    {
                      trackName: 'スタート!',
                      collectionName: 'スタート! - Single',
                      artistName: '佐々木 李子',
                      artworkUrl100: 'https://img.example/rico/100x100bb.jpg'
                    }
                  ]
                };
              }
            };
          }
          return { ok: true, status: 200, async json() { return { results: [] }; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    await app.inputText('catalogUrlInput', 'https://docs.google.com/spreadsheets/d/realPatternSheet/edit');
    await app.clickElement('loadCatalogUrlBtn');
    await app.triggerIntersection('sheet-thcs-60240');
    await app.triggerIntersection('sheet-akcy-58075');

    assert.ok(app.elements.get('art-slot-sheet-thcs-60240').innerHTML.includes('https://img.example/know/600x600bb.jpg'));
    assert.ok(app.elements.get('art-slot-sheet-akcy-58075').innerHTML.includes('https://img.example/rico/600x600bb.jpg'));
    assert.ok(seenItunesUrls.some((u) => u.includes(encodeURIComponent('佐々木李子 スタート!'))));

    // Check clean Jacket Google Search links in Crate Flip lightbox for both physical and digital items
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '1' });
    const ricoHref = decodeURIComponent(app.elements.get('lbGoogleSearchLink').href);
    assert.ok(ricoHref.includes('AKCY-58075 Rico Sasaki スタート! 通常盤 CD'));
    assert.equal(ricoHref.includes('AKCY-58073'), false);

    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '2' });
    const digHref = decodeURIComponent(app.elements.get('lbGoogleSearchLink').href);
    assert.ok(digHref.includes('Rokudenashi ホウキボシ ジャケット'));
    assert.equal(digHref.includes('通常盤 CD'), false);
  });
});

describe('Phase 1 Track Lists UI, lazy MusicBrainz/iTunes resolution, IndexedDB cache, overrides, and track search', () => {
  function makeMockIDBFactory(backing = new Map()) {
    function makeReq() {
      return { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    }
    return {
      open(dbName) {
        const req = makeReq();
        queueMicrotask(() => {
          if (!backing.has(dbName)) {
            backing.set(dbName, new Map());
          }
          const storeData = backing.get(dbName);
          const dbObj = {
            objectStoreNames: {
              contains(name) { return storeData.has(name); }
            },
            createObjectStore(name) {
              if (!storeData.has(name)) storeData.set(name, new Map());
              return {};
            },
            transaction(storeName) {
              if (!storeData.has(storeName)) storeData.set(storeName, new Map());
              const map = storeData.get(storeName);
              const tx = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore() {
                  return {
                    get(key) {
                      const r = makeReq();
                      queueMicrotask(() => {
                        r.result = map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : undefined;
                        if (r.onsuccess) r.onsuccess();
                        if (tx.oncomplete) tx.oncomplete();
                      });
                      return r;
                    },
                    put(val) {
                      const r = makeReq();
                      queueMicrotask(() => {
                        map.set(val.releaseKey, JSON.parse(JSON.stringify(val)));
                        r.result = val.releaseKey;
                        if (r.onsuccess) r.onsuccess();
                        if (tx.oncomplete) tx.oncomplete();
                      });
                      return r;
                    },
                    delete(key) {
                      const r = makeReq();
                      queueMicrotask(() => {
                        map.delete(key);
                        if (r.onsuccess) r.onsuccess();
                        if (tx.oncomplete) tx.oncomplete();
                      });
                      return r;
                    },
                    getAll() {
                      const r = makeReq();
                      queueMicrotask(() => {
                        r.result = Array.from(map.values()).map((v) => JSON.parse(JSON.stringify(v)));
                        if (r.onsuccess) r.onsuccess();
                        if (tx.oncomplete) tx.oncomplete();
                      });
                      return r;
                    },
                    clear() {
                      const r = makeReq();
                      queueMicrotask(() => {
                        map.clear();
                        if (r.onsuccess) r.onsuccess();
                        if (tx.oncomplete) tx.oncomplete();
                      });
                      return r;
                    }
                  };
                }
              };
              return tx;
            },
            close() {}
          };
          req.result = dbObj;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: dbObj } });
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      }
    };
  }

  it('renders embedded multi-disc catalog tracks expanded immediately and filters cards by track title without network requests', async () => {
    let fetchCalls = 0;
    const catalog = {
      schemaVersion: 1,
      meta: { title: 'Track Catalog Test' },
      items: [
        {
          id: 'tr-01',
          category: 'Anime Themes & Chara',
          artist: 'yama',
          artistJa: 'yama (ヤマ)',
          title: 'slash (Limited CD+BD)',
          titleJa: 'slash',
          regCatNo: 'SRCL-12539',
          catalog: 'SRCL-12539 (通常盤) / SRCL-12536~38 (初回 CD+BD)',
          barcode: '4547366611397',
          kana: 'ヤ / Y',
          filing: 'Look under ヤ',
          price: '¥500',
          tracks: [
            { disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 221000 },
            { disc: 1, mediaType: 'CD', number: 2, title: 'Hidden Coupling Star', titleJa: '隠れ星', artist: 'Guest Composer', durationMs: 252000, notes: 'Instrumental' },
            { disc: 2, mediaType: 'BD', number: 1, title: 'Non-Credit Opening', durationMs: 90000 }
          ]
        },
        {
          id: 'tr-02',
          category: 'J-Rock',
          artist: 'Asian Kung-Fu Generation',
          title: 'Sol-fa',
          regCatNo: 'KSCL-737',
          catalog: 'KSCL-737',
          kana: 'ア / A',
          filing: 'Look under ア',
          price: '¥400'
        }
      ]
    };

    const app = await bootApp({
      catalogObject: catalog,
      fetchImpl: async (url) => {
        fetchCalls++;
        throw new Error('Unexpected network call: ' + url);
      }
    });

    await app.clickElement('openCrateFlipBtn');
    assert.equal(app.elements.get('lbTracksToggleBtn').getAttribute('aria-expanded'), 'true');
    assert.equal(app.elements.get('lbTracksBody').classList.contains('hidden'), false);
    assert.equal(app.elements.get('lbTracksHeading').textContent, 'Track List (3 tracks · 2 discs)');
    assert.equal(app.elements.get('lbTrackSourceBadge').textContent, 'Catalog · SRCL-12539');
    assert.equal(app.elements.get('lbTrackDisclaimer').classList.contains('hidden'), true);

    const listHtml = app.elements.get('lbTracksList').innerHTML;
    assert.ok(listHtml.includes('Disc 1 · CD'));
    assert.ok(listHtml.includes('Disc 2 · BD'));
    assert.ok(listHtml.includes('Hidden Coupling Star'));
    assert.ok(listHtml.includes('隠れ星'));
    assert.ok(listHtml.includes('Guest Composer'));
    assert.ok(listHtml.includes('Instrumental'));
    assert.ok(listHtml.includes('4:12'));
    assert.equal(fetchCalls, 0);

    // Track title search (English + Japanese) matches album card and shows compact track chip in both Grid & 1-Col
    await app.inputText('searchInput', '隠れ星');
    assert.equal(app.elements.get('visibleCountText').textContent, 'Showing 1 of 2 physical covers');
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('track-match-chip'));
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('Hidden Coupling Star'));

    await app.clickElement('viewModeBtn');
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('track-match-chip'));
  });

  it('lazily resolves tracks from MusicBrainz and iTunes, switches sources cleanly, and persists manual overrides in IndexedDB without cloud pushes', async () => {
    const sharedBacking = new Map();
    const fetchedUrls = [];
    let cloudPutCount = 0;

    const catalog = {
      schemaVersion: 1,
      meta: { title: 'Lazy Track Hunt' },
      items: [
        {
          id: 'lz-01',
          category: 'Anime Themes & Chara',
          artist: 'Example Artist',
          artistJa: 'サンプル',
          title: 'Moonlight Single',
          regCatNo: 'LACM-24156',
          catalog: 'LACM-24156 (通常盤)',
          mbEditions: [{ catno: 'LACM-24156', label: '通常盤 Regular' }],
          itunesQuery: 'Moonlight Example Artist',
          requiredGroups: [['moonlight'], ['example']],
          kana: 'サ / S',
          filing: 'Look under サ',
          price: '¥500'
        }
      ]
    };

    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const jwtPayload = Buffer.from(JSON.stringify({ purpose: 'session', sub: '101', login: 'alice', exp: 9999999999 })).toString('base64url');
    const fakeJwt = `${jwtHeader}.${jwtPayload}.sig`;

    function makeFetchImpl() {
      return async (url, init = {}) => {
        const u = String(url);
        const method = String(init.method || 'GET').toUpperCase();
        fetchedUrls.push({ url: u, method });
        if (u === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return { ok: true, status: 200, async json() { return { ok: true, user: { login: 'alice' }, state: null, updatedAt: null }; } };
        }
        if (u === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'PUT') {
          cloudPutCount++;
          return { ok: true, status: 200, async json() { return { ok: true, updatedAt: Date.now() }; } };
        }
        if (u.startsWith('https://musicbrainz.org/ws/2/release/?query=catno%3ALACM-24156')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                releases: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Moonlight', status: 'Official', 'label-info': [{ 'catalog-number': 'LACM-24156' }] }]
              };
            }
          };
        }
        if (u.startsWith('https://musicbrainz.org/ws/2/release/11111111-1111-4111-8111-111111111111')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: '11111111-1111-4111-8111-111111111111',
                title: 'Moonlight',
                'label-info': [{ 'catalog-number': 'LACM-24156' }],
                media: [
                  {
                    position: 1,
                    format: 'CD',
                    tracks: [
                      { position: 1, title: 'Moonlight Overture', length: 245000, 'artist-credit': [{ name: 'Example Artist' }] },
                      { position: 2, title: 'Moonlight Overture (Off Vocal)', length: 245000, 'artist-credit': [{ name: 'Example Artist' }] }
                    ]
                  }
                ]
              };
            }
          };
        }
        if (u.startsWith('https://itunes.apple.com/search?')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                results: [
                  { collectionId: 999111, collectionName: 'Moonlight - EP', artistName: 'Example Artist' }
                ]
              };
            }
          };
        }
        if (u.startsWith('https://itunes.apple.com/lookup?id=999111')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                results: [
                  { wrapperType: 'collection', collectionId: 999111 },
                  { wrapperType: 'track', discNumber: 1, trackNumber: 1, trackName: 'Moonlight (Digital Mix)', artistName: 'Example Artist', trackTimeMillis: 240000 }
                ]
              };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { releases: [], results: [] }; } };
      };
    }

    const app = await bootApp({
      catalogObject: catalog,
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      initialStorage: { cd_hunt_sync_token_v1: fakeJwt },
      indexedDBImpl: makeMockIDBFactory(sharedBacking),
      fetchImpl: makeFetchImpl()
    });

    // Opening Crate Flip leaves empty Track List collapsed and fires zero MusicBrainz/iTunes tracklist requests
    await app.clickElement('openCrateFlipBtn');
    assert.equal(app.elements.get('lbTracksBody').classList.contains('hidden'), true);
    assert.equal(
      fetchedUrls.some((f) => f.url.includes('inc=recordings') || f.url.includes('itunes.apple.com/lookup')),
      false
    );

    // Expanding triggers lazy MusicBrainz fetch & caches into IndexedDB with zero cloud PUTs
    await app.clickElement('lbTracksToggleBtn');
    await app.flush();
    assert.equal(app.elements.get('lbTracksBody').classList.contains('hidden'), false);
    assert.equal(app.elements.get('lbTrackSourceBadge').textContent, 'MusicBrainz · LACM-24156');
    assert.ok(app.elements.get('lbTracksList').innerHTML.includes('Moonlight Overture'));
    assert.equal(app.elements.get('lbTrackDisclaimer').classList.contains('hidden'), true);
    assert.equal(cloudPutCount, 0);

    // Switching source loads iTunes and displays digital-vs-physical disclaimer
    await app.clickElement('lbSwitchTrackSourceBtn');
    await app.flush();
    assert.equal(app.elements.get('lbTrackSourceBadge').textContent, 'iTunes · Digital');
    assert.equal(app.elements.get('lbTrackDisclaimer').classList.contains('hidden'), false);
    assert.ok(app.elements.get('lbTrackDisclaimer').textContent.includes('may differ from physical CD'));
    assert.ok(app.elements.get('lbTracksList').innerHTML.includes('Moonlight (Digital Mix)'));

    // Edit & paste custom multi-disc override -> Layer 1 wins & persists across reload
    await app.clickElement('lbEditTracksBtn');
    assert.equal(app.elements.get('lbTrackEditorDrawer').classList.contains('hidden'), false);
    await app.inputText('lbTrackEditorInput', 'Disc 1 (CD)\n01. Custom Vocal Track (4:00)\nDisc 2 (BD)\n01. Live Footage (15:00)');
    assert.equal(app.elements.get('lbTrackEditorPreview').textContent, '2 tracks · 2 discs');
    await app.clickElement('saveManualTracksBtn');
    await app.flush();

    assert.equal(app.elements.get('lbTrackSourceBadge').textContent, 'Custom');
    assert.equal(app.elements.get('lbTrackDisclaimer').classList.contains('hidden'), true);
    assert.equal(app.elements.get('lbResetTracksBtn').classList.contains('hidden'), false);

    // Attempted auto-fetch does not overwrite active custom override
    const fetchCountBefore = fetchedUrls.length;
    await app.clickElement('lbFetchTracksBtn');
    assert.equal(fetchedUrls.length, fetchCountBefore);
    assert.ok(app.elements.get('toast').textContent.includes('Reset Override first'));

    // Second boot reading from shared IndexedDB restores Custom override offline and makes it searchable
    const appReload = await bootApp({
      catalogObject: catalog,
      indexedDBImpl: makeMockIDBFactory(sharedBacking),
      fetchImpl: async (url) => {
        throw new Error('Reload should use IndexedDB offline without fetching: ' + url);
      }
    });
    await appReload.clickElement('openCrateFlipBtn');
    assert.equal(appReload.elements.get('lbTrackSourceBadge').textContent, 'Custom');
    assert.ok(appReload.elements.get('lbTracksList').innerHTML.includes('Custom Vocal Track'));

    await appReload.inputText('searchInput', 'Live Footage');
    assert.equal(appReload.elements.get('visibleCountText').textContent, 'Showing 1 of 1 physical covers');
    assert.ok(appReload.elements.get('albumGrid').innerHTML.includes('Live Footage'));

    // Resetting override falls back cleanly to underlying cached iTunes entry
    await appReload.clickElement('lbResetTracksBtn');
    await appReload.flush();
    assert.equal(appReload.elements.get('lbTrackSourceBadge').textContent, 'iTunes · Digital');
    assert.equal(appReload.elements.get('lbResetTracksBtn').classList.contains('hidden'), true);
  });
});

describe('Phase 2 Owned Collection, Cross-Referencing, Graduation & Shared releaseKey Integration', () => {
  function makeMockIDBFactoryLocal(backing) {
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

  it('reuses shared releaseKey IndexedDB tracks across different Hunt catalogs and Collection without refetching, and enriches Sheet+JSON hybrid overlays', async () => {
    const sharedBacking = { stores: new Map() };
    const catJsonUrl = 'https://cdn.example/hybrid-tracks.json';
    const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/hybridTrackSheet/export?format=csv&gid=12';

    const hybridBaseCatalog = {
      schemaVersion: 1,
      meta: {
        title: 'Hybrid Overlay Catalog',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/hybridTrackSheet/edit#gid=12'
      },
      items: [
        {
          id: 'hyb-lacm-24156',
          category: 'Anime',
          artist: 'ChouCho',
          title: 'Moonlight',
          regCatNo: 'LACM-24156',
          catalog: 'LACM-24156 (通常盤)',
          barcode: '4540774241569',
          mbid: '11111111-1111-4111-8111-111111111111',
          trackSource: 'catalog',
          tracks: [
            { disc: 1, mediaType: 'CD', number: 1, title: 'Hybrid Overlay Opening', durationMs: 240000 }
          ],
          kana: 'チ',
          filing: 'Shelf A',
          price: '¥1,320'
        },
        {
          id: 'hyb-lazy',
          category: 'Anime',
          artist: 'yama',
          title: 'slash',
          regCatNo: 'SRCL-12539',
          catalog: 'SRCL-12539 (通常盤)',
          kana: 'ヤ',
          filing: 'Shelf B',
          price: '¥1,200'
        }
      ]
    };

    const sheetCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title,Catalog Number,Where to Find,Price,Priority,Recommended Shops',
      'FALSE,Anime,ChouCho,Moonlight,LACM-24156,Shelf A,¥1320,High,Tower Records',
      'TRUE,Game,Capcom,Battle OST,CPCA-9001,Shelf C,¥2000,Med,Book Off'
    ].join('\n');

    let trackFetchCalls = 0;
    const appA = await bootApp({
      savedCatalogUrl: catJsonUrl,
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking),
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === catJsonUrl) return { ok: true, status: 200, async json() { return hybridBaseCatalog; } };
        if (u === sheetCsvUrl) return { ok: true, status: 200, async text() { return sheetCsv; } };
        if (u.startsWith('https://musicbrainz.org/ws/2/release/?query=catno%3ASRCL-12539')) {
          trackFetchCalls++;
          return {
            ok: true,
            status: 200,
            async json() {
              return { releases: [{ id: '99999999-9999-4999-8999-999999999999', title: 'slash', status: 'Official', 'label-info': [{ 'catalog-number': 'SRCL-12539' }] }] };
            }
          };
        }
        if (u.startsWith('https://musicbrainz.org/ws/2/release/99999999-9999-4999-8999-999999999999')) {
          trackFetchCalls++;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: '99999999-9999-4999-8999-999999999999',
                title: 'slash',
                'label-info': [{ 'catalog-number': 'SRCL-12539' }],
                media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Shared Cached slash Track', length: 215000 }] }]
              };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { releases: [], results: [] }; } };
      }
    });

    // Hybrid overlay kept JSON tracks/barcode/mbid while merging Sheet's priority & extra CPCA-9001 row
    for (let i = 0; i < 20 && !appA.elements.get('albumGrid').innerHTML.includes('ChouCho'); i++) {
      await appA.flush();
    }
    await appA.clickElement('openCrateFlipBtn');
    assert.equal(appA.elements.get('lbTrackSourceBadge').textContent, 'Catalog · LACM-24156');
    assert.ok(appA.elements.get('lbTracksList').innerHTML.includes('Hybrid Overlay Opening'));
    assert.equal(appA.elements.get('lbPriorityBadge').textContent, 'Priority: High');

    // Step to SRCL-12539, lazily fetch its tracks into shared IndexedDB track_cache
    await appA.clickElement('lbNextBtn');
    await appA.clickElement('lbTracksToggleBtn');
    await appA.flush();
    assert.ok(appA.elements.get('lbTracksList').innerHTML.includes('Shared Cached slash Track'));
    assert.ok(trackFetchCalls >= 1);

    // Boot completely different Catalog B (different ID 'alt-srcl') referencing the same SRCL-12539 offline
    const altCatalog = {
      schemaVersion: 1,
      meta: { title: 'Catalog B' },
      items: [
        {
          id: 'alt-srcl-different-id',
          category: 'Rock',
          artist: 'yama',
          title: 'slash (Re-Listed)',
          regCatNo: 'SRCL-12539',
          catalog: 'SRCL-12539',
          kana: 'ヤ',
          filing: 'Row 2',
          price: '¥1,100'
        }
      ]
    };

    const appB = await bootApp({
      catalogObject: altCatalog,
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking),
      fetchImpl: async (url) => {
        throw new Error('Catalog B & Collection must reuse shared releaseKey without fetching: ' + url);
      }
    });

    // Hunt Catalog B immediately renders SRCL-12539 tracks from shared IndexedDB cache
    await appB.clickElement('openCrateFlipBtn');
    assert.ok(appB.elements.get('lbTracksList').innerHTML.includes('Shared Cached slash Track'));

    // Switch to Collection mode and add SRCL-12539 with empty track editor -> shares releaseKey cache immediately
    await appB.clickElement('modeCollectionBtn');
    await appB.clickElement('addReleaseBtn');
    await appB.inputText('rfArtist', 'yama');
    await appB.inputText('rfTitle', 'slash');
    await appB.inputText('rfCatNo', 'SRCL-12539');
    await appB.clickElement('saveReleaseFormBtn');
    await appB.clickElement('openCrateFlipBtn');
    assert.ok(appB.elements.get('lbTracksList').innerHTML.includes('Shared Cached slash Track'));
  });

  it('supports Hunt <-> Collection mode switching, MB lookup, CRUD, graduation, Owned & Track Overlap badges, JSON Merge/Replace, and Sheet sync', async () => {
    const sharedBacking = { stores: new Map() };
    const huntCatalog = {
      schemaVersion: 1,
      meta: { title: 'Cross-Ref Hunt List' },
      items: [
        {
          id: 'hunt-01',
          category: 'Anime',
          artist: 'yama',
          title: 'slash',
          regCatNo: 'SRCL-12539',
          catalog: 'SRCL-12539 (通常盤)',
          kana: 'ヤ',
          filing: 'Shelf 1',
          price: '¥1,200',
          tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 210000 }]
        },
        {
          id: 'hunt-02',
          category: 'Anime',
          artist: 'yama',
          title: 'the meaning of life',
          regCatNo: 'SRCL-99999',
          catalog: 'SRCL-99999 (Limited)',
          kana: 'ヤ',
          filing: 'Shelf 2',
          price: '¥4,000',
          tracks: [
            { disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 210000 },
            { disc: 1, mediaType: 'CD', number: 2, title: 'Bonus Live Track', durationMs: 240000 }
          ]
        }
      ]
    };

    const ownedSheetCsv = [
      'Catalog Number,Edition,Category,Artist,Title,Barcode,Purchase Price,Purchase Shop,Purchase Date,Track Count,Notes',
      'SRCL-12539,通常盤 Regular,Anime,yama,slash,4547366000001,¥850,Book Off,2026-11-24,1,Updated shop note',
      'KICM-7777,初回盤,Game,Square,Imported Sheet Release,4988003000099,¥1900,Surugaya,2026-11-25,0,Mint'
    ].join('\n');

    const app = await bootApp({
      catalogObject: huntCatalog,
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking),
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.startsWith('https://musicbrainz.org/ws/2/release/?query=barcode%3A4547366000001')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { releases: [{ id: '44444444-4444-4444-8444-444444444444', title: 'slash', barcode: '4547366000001' }] };
            }
          };
        }
        if (u.startsWith('https://musicbrainz.org/ws/2/release/44444444-4444-4444-8444-444444444444')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: '44444444-4444-4444-8444-444444444444',
                title: 'slash',
                barcode: '4547366000001',
                'artist-credit': [{ name: 'yama' }],
                'label-info': [{ 'catalog-number': 'SRCL-12539' }],
                media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'slash', length: 210000 }] }]
              };
            }
          };
        }
        if (u === 'https://docs.google.com/spreadsheets/d/myOwnedSheet1/export?format=csv') {
          return { ok: true, status: 200, async text() { return ownedSheetCsv; } };
        }
        return { ok: true, status: 200, async json() { return { releases: [], results: [] }; } };
      }
    });

    // Switch to Collection -> Add release via Barcode Lookup
    await app.clickElement('modeCollectionBtn');
    assert.equal(app.elements.get('addReleaseBtn').classList.contains('hidden'), false);
    assert.equal(app.elements.get('progressBadge').textContent, '0 releases · 0 tracks');

    await app.clickElement('addReleaseBtn');
    await app.inputText('releaseLookupInput', '4547366000001');
    await app.clickElement('releaseLookupBtn');
    await app.clickLookupCandidate(0);
    assert.equal(app.elements.get('rfCatNo').value, 'SRCL-12539');
    assert.equal(app.elements.get('rfArtist').value, 'yama');
    await app.inputText('rfNotes', 'Original local note');
    await app.clickElement('saveReleaseFormBtn');

    assert.equal(app.elements.get('progressBadge').textContent, '1 release · 1 track');

    // Add second release without tracks manually -> test quick filters
    await app.clickElement('addReleaseBtn');
    await app.inputText('rfArtist', 'yama');
    await app.inputText('rfTitle', 'the meaning of life');
    await app.inputText('rfCatNo', 'SRCL-99900');
    await app.inputText('rfCategory', 'Anime');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '2 releases · 1 track');

    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'missing-tracks' });
    await app.flush();
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('SRCL-99900'));
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('SRCL-12539'), false);
    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'all' });
    await app.flush();

    // Switch back to Hunt -> Owned badge, Other Edition Owned badge, and Tracks Owned badge appear!
    await app.clickElement('modeHuntBtn');
    const huntHtml = app.elements.get('albumGrid').innerHTML;
    assert.ok(huntHtml.includes('✓ Owned'));
    assert.ok(huntHtml.includes('Other Ed. Owned (SRCL-99900)'));
    assert.ok(huntHtml.includes('Tracks Owned: 1/2'));

    // Open Crate Flip on hunt-02 -> verify #lbOwnedCrossRefBox & Graduate modal
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '1' });
    await app.flush();
    assert.equal(app.elements.get('lbOwnedCrossRefBox').classList.contains('hidden'), false);
    assert.ok(app.elements.get('lbOwnedCrossRefBox').innerHTML.includes('SRCL-99900'));
    assert.ok(app.elements.get('lbOwnedCrossRefBox').innerHTML.includes('SRCL-12539 (slash)'));
    await app.clickElement('lbGraduateBtn');
    assert.equal(app.elements.get('rfCatNo').value, 'SRCL-99999');
    await app.clickElement('saveReleaseFormBtn');
    await app.clickElement('closeLightboxBtn');

    // Check off both Hunt items, graduate physical via batch button (hunt-01 & hunt-02 already exact-owned -> batch button hidden cleanly)
    assert.equal(app.elements.get('batchGraduateBtn').classList.contains('hidden'), true);

    // Switch back to Collection -> Import Owned Google Sheet non-destructively (updates shop/notes while preserving slash tracks)
    await app.clickElement('modeCollectionBtn');
    await app.clickElement('collectionBackupBtn');
    await app.inputText('ownedSheetUrlInput', 'https://docs.google.com/spreadsheets/d/myOwnedSheet1/edit');
    await app.clickElement('importOwnedSheetBtn');
    await app.flush();

    assert.ok(app.elements.get('albumGrid').innerHTML.includes('KICM-7777'));
    // Soft-delete first item via Crate Flip Delete button -> reload retains remaining items and omits soft-deleted item
    await app.clickElement('openCrateFlipBtn');
    await app.clickElement('lbDeleteReleaseBtn');
    await app.clickElement('closeLightboxBtn');

    // Test JSON Replace import
    await app.clickElement('collectionBackupBtn');
    const snapshotText = JSON.stringify({
      schemaVersion: 1,
      items: [{ id: 'own-replaced', artist: 'Replaced Artist', title: 'Replaced Title', category: 'Rock', catNo: 'REP-001' }]
    });
    await app.inputText('collectionBackupTextarea', snapshotText);
    await app.clickElement('importCollectionReplaceBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '1 release · 0 tracks');
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('REP-001'));
  });

  it('supports batch graduation (#batchGraduateBtn), Collection quick filters, owned custom cover persistence, and JSON Merge import + validation errors', async () => {
    const sharedBacking = { stores: new Map() };
    const huntCatalog = {
      schemaVersion: 1,
      meta: { title: 'Batch Grad Catalog' },
      items: [
        {
          id: 'p1',
          category: 'Anime',
          artist: 'Artist 1',
          title: 'Already Owned Disc',
          regCatNo: 'OWN-001',
          catalog: 'OWN-001',
          kana: 'ア',
          filing: 'Shelf A',
          price: '¥500',
          tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: 'Owned Track 1' }]
        },
        {
          id: 'p2',
          category: 'Game',
          artist: 'Artist 2',
          title: 'Graduate With Cover & Tracks',
          regCatNo: 'GRAD-002',
          catalog: 'GRAD-002',
          kana: 'カ',
          filing: 'Shelf B',
          price: '¥1,200',
          tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: 'Battle Theme' }]
        },
        {
          id: 'p3',
          category: 'Rock',
          artist: 'Artist 3',
          title: 'Trackless Graduate',
          regCatNo: 'GRAD-003',
          catalog: 'GRAD-003',
          kana: 'サ',
          filing: 'Shelf C',
          price: '¥800'
        },
        {
          id: 'd1',
          digitalOnly: true,
          category: 'Digital-Only',
          artist: 'Digital Artist',
          title: 'Digital Track',
          regCatNo: 'DIGITAL-ONLY',
          catalog: 'DIGITAL-ONLY',
          kana: 'ハ',
          filing: 'Digital',
          price: 'Digital Only'
        }
      ]
    };

    const app = await bootApp({
      catalogObject: huntCatalog,
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking)
    });

    // Seed p1 (OWN-001) in Collection beforehand
    await app.clickElement('modeCollectionBtn');
    await app.clickElement('addReleaseBtn');
    await app.inputText('rfArtist', 'Artist 1');
    await app.inputText('rfTitle', 'Already Owned Disc');
    await app.inputText('rfCatNo', 'OWN-001');
    await app.inputText('rfCategory', 'Anime');
    await app.inputText('rfNotes', 'Bought in Osaka');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '1 release · 0 tracks');

    // Back in Hunt mode: add a custom cover on p2, then check off p1, p2, p3, and digital d1
    await app.clickElement('modeHuntBtn');
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '1' });
    await app.flush();
    await app.clickElement('lbToggleCustomBtn');
    await app.inputText('customCoverInput', 'https://custom.example/hunt-grad-cover.jpg');
    await app.inputText('customCoverLabel', 'Usually Custom');
    await app.clickElement('saveCustomCoverBtn');
    await app.clickElement('closeLightboxBtn');

    app.triggerDocumentClick('toggle-acq', { 'data-id': 'p1' });
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'p2' });
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'p3' });
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'd1' });
    await app.flush();

    // Only p2 and p3 are un-owned physical items -> Move Found to Collection (2)
    assert.equal(app.elements.get('batchGraduateBtn').classList.contains('hidden'), false);
    assert.equal(app.elements.get('batchGraduateBtn').textContent, 'Move Found to Collection (2)');

    await app.clickElement('batchGraduateBtn');
    assert.ok(app.elements.get('toast').textContent.includes('Added 2 releases to Owned Collection'));
    assert.equal(app.elements.get('batchGraduateBtn').classList.contains('hidden'), true);

    // Switch to Collection -> verify 3 total releases (p1 not duplicated, d1 skipped, p2 kept cover + tracks)
    await app.clickElement('modeCollectionBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '3 releases · 1 track');

    const dbClient = app.window.DiskCrate.db.createDbClient({
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking)
    });
    const allOwnedAfterGrad = await dbClient.getAllOwnedReleases();
    const grad2Row = allOwnedAfterGrad.find((r) => r.catNo === 'GRAD-002');
    assert.ok(grad2Row, 'GRAD-002 must exist in IndexedDB owned_releases');
    assert.equal(grad2Row.tracks[0].title, 'Battle Theme');
    assert.equal(grad2Row.customCovers.variants[0].url, 'https://custom.example/hunt-grad-cover.jpg');

    // Quick filters: has-tracks, missing-tracks, has-notes, all
    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'has-tracks' });
    await app.flush();
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('GRAD-002'));
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('GRAD-003'), false);

    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'missing-tracks' });
    await app.flush();
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('OWN-001'));
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('GRAD-003'));
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('GRAD-002'), false);

    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'has-notes' });
    await app.flush();
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('OWN-001'));
    assert.equal(app.elements.get('albumGrid').innerHTML.includes('GRAD-003'), false);

    app.triggerDocumentClick('set-col-filter', { 'data-filter': 'all' });
    await app.flush();

    // Add and then remove custom cover directly in Collection Crate Flip -> persists cleanly to IndexedDB
    const grad3RowBefore = (await dbClient.getAllOwnedReleases()).find((r) => r.catNo === 'GRAD-003');
    app.triggerDocumentClick('open-lb', { 'data-lb-catno': 'GRAD-003', 'data-lb-idx': '0' });
    // Ensure we open GRAD-003 cleanly by filtering search first so idx 0 is GRAD-003
    await app.inputText('searchInput', 'GRAD-003');
    await app.clickElement('openCrateFlipBtn');
    await app.clickElement('lbToggleCustomBtn');
    await app.inputText('customCoverInput', 'https://custom.example/col-only-cover.jpg');
    await app.inputText('customCoverLabel', 'Direct Collection Cover');
    await app.clickElement('saveCustomCoverBtn');
    await app.flush();

    const grad3WithCover = await dbClient.getOwnedRelease(grad3RowBefore.id);
    assert.equal(grad3WithCover.customCovers.variants[0].url, 'https://custom.example/col-only-cover.jpg');
    assert.equal(grad3WithCover.selectedVariant.url, 'https://custom.example/col-only-cover.jpg');

    app.triggerDocumentClick('del-var', { 'data-id': grad3RowBefore.id, 'data-idx': '0' });
    await app.flush();
    const grad3AfterDel = await dbClient.getOwnedRelease(grad3RowBefore.id);
    assert.equal(grad3AfterDel.customCovers, undefined);

    await app.clickElement('closeLightboxBtn');
    await app.clickElement('clearSearchBtn');

    // Collection Backup modal: invalid JSON & schema validation errors, then valid Merge import
    await app.clickElement('collectionBackupBtn');
    await app.inputText('collectionBackupTextarea', '{ broken json');
    await app.clickElement('importCollectionMergeBtn');
    assert.equal(app.elements.get('toast').textContent, 'Invalid JSON format');

    await app.inputText('collectionBackupTextarea', JSON.stringify({ schemaVersion: 99, items: [] }));
    await app.clickElement('importCollectionMergeBtn');
    assert.ok(app.elements.get('toast').textContent.startsWith('Validation failed:'));

    await app.inputText(
      'collectionBackupTextarea',
      JSON.stringify({
        schemaVersion: 1,
        items: [{ id: 'own-mrg-001', artist: 'Merge Artist', title: 'Merge Album', category: 'Rock', catNo: 'MRG-001' }]
      })
    );
    await app.clickElement('importCollectionMergeBtn');
    assert.equal(app.elements.get('collectionBackupModal').classList.contains('open'), false);
    assert.ok(app.elements.get('toast').textContent.includes('Collection import (merge): +1 added'));
    assert.equal(app.elements.get('progressBadge').textContent, '4 releases · 1 track');
    assert.ok(app.elements.get('albumGrid').innerHTML.includes('MRG-001'));
  });

  it('copies Collection Agent Link (&include=collection) and flushes debounced Collection writes immediately with keepalive on visibilitychange and pagehide', async () => {
    const sharedBacking = { stores: new Map() };
    const sampleCatalog = JSON.parse(fs.readFileSync(SAMPLE_CATALOG_PATH, 'utf8'));
    const catalogUrl = 'https://cdn.example/sample-catalog.json';
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    const shareUrl = 'https://cd-hunt-sync.tndo.workers.dev/api/share/tok_alice_123';
    const batchCalls = [];

    const app = await bootApp({
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 5000,
      savedCatalogUrl: catalogUrl,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      indexedDBImpl: makeMockIDBFactoryLocal(sharedBacking),
      fetchImpl: async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/state' && method === 'GET') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                user: { login: 'alice' },
                updatedAt: 1000,
                shareUrl,
                state: { schemaVersion: 1, updatedAt: 1000, activeCatalogUrl: catalogUrl, catalogs: {} }
              };
            }
          };
        }
        if (String(url).startsWith('https://cd-hunt-sync.tndo.workers.dev/api/collection') && method === 'GET') {
          return { ok: true, status: 200, async json() { return { ok: true, paused: false, items: [], hasMore: false, latestSeq: 0 }; } };
        }
        if (url === 'https://cd-hunt-sync.tndo.workers.dev/api/collection/batch' && method === 'POST') {
          const parsed = JSON.parse(init.body);
          batchCalls.push({ keepalive: init.keepalive, count: parsed.items.length, ids: parsed.items.map((x) => x.id) });
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                paused: false,
                accepted: parsed.items.map((x, i) => ({
                  id: x.id,
                  syncSeq: batchCalls.length * 10 + i + 1,
                  clientUpdatedAt: x.clientUpdatedAt,
                  deletedAt: x.deletedAt || null
                })),
                conflicts: [],
                latestSeq: batchCalls.length * 10 + parsed.items.length
              };
            }
          };
        }
        if (url === catalogUrl) {
          return { ok: true, status: 200, async json() { return sampleCatalog; } };
        }
        return { ok: true, status: 200, async json() { return { schemaVersion: 1, catalogs: [] }; } };
      }
    });

    // Hunt mode Agent Link -> ?format=markdown without include=collection
    await app.clickElement('copyAgentLinkBtn');
    assert.equal(app.copiedTexts[0], `${shareUrl}?format=markdown`);

    // Collection mode Agent Link -> &include=collection
    await app.clickElement('modeCollectionBtn');
    await app.clickElement('copyAgentLinkBtn');
    assert.equal(app.copiedTexts[1], `${shareUrl}?format=markdown&include=collection`);

    // Backup modal Copy Collection Agent Link button
    await app.clickElement('collectionBackupBtn');
    await app.clickElement('copyCollectionAgentLinkBtn');
    assert.equal(app.copiedTexts[2], `${shareUrl}?format=markdown&include=collection`);
    assert.equal(app.elements.get('toast').textContent, 'Copied Agent Collection status link');
    await app.clickElement('closeCollectionBackupBtn');

    // Add first Owned release (schedules 5s debounce -> 0 immediate POSTs) -> visibilitychange('hidden') flushes with keepalive: true
    await app.clickElement('addReleaseBtn');
    await app.inputText('rfArtist', 'Flush Artist 1');
    await app.inputText('rfTitle', 'Flush Album 1');
    await app.inputText('rfCatNo', 'FLSH-001');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(batchCalls.length, 0);

    await app.triggerVisibilityChange('hidden');
    assert.equal(batchCalls.length, 1);
    assert.equal(batchCalls[0].keepalive, true);

    // Add second Owned release -> pagehide flushes immediately with keepalive: true
    await app.clickElement('addReleaseBtn');
    await app.inputText('rfArtist', 'Flush Artist 2');
    await app.inputText('rfTitle', 'Flush Album 2');
    await app.inputText('rfCatNo', 'FLSH-002');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(batchCalls.length, 1);

    await app.triggerPageHide();
    assert.equal(batchCalls.length, 2);
    assert.equal(batchCalls[1].keepalive, true);
  });
});

describe('Phase 3a Opt-In Scanner Engine Integration', () => {
  function makeCacheStorageMock() {
    const buckets = new Map();
    return {
      async has(name) { return buckets.has(name); },
      async open(name) {
        if (!buckets.has(name)) buckets.set(name, new Map());
        const map = buckets.get(name);
        return {
          async put(k, res) {
            const urlKey = typeof k === 'string' ? k : k.url;
            const buf = Buffer.from(await res.arrayBuffer());
            map.set(urlKey, buf);
          },
          async match(k) {
            const urlKey = typeof k === 'string' ? k : k.url;
            const buf = map.get(urlKey);
            if (!buf) return undefined;
            return {
              ok: true,
              status: 200,
              async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
              async json() { return JSON.parse(buf.toString('utf8')); }
            };
          },
          async delete(k) {
            return map.delete(typeof k === 'string' ? k : k.url);
          }
        };
      },
      async delete(name) { return buckets.delete(name); },
      _buckets: buckets
    };
  }

  it('keeps scanner runtime at 0 KB until #openScannerBtn, gates WASM download until confirmed, runs worker + manual lookup, and wipes safely without touching Hunt/Owned data', async () => {
    const { buildEngineShellWasmBytes, buildScannerManifest } = await import('../scripts/build-scanner-assets.mjs');
    const wasmBytes = buildEngineShellWasmBytes();
    const manifest = buildScannerManifest(wasmBytes);
    const scannerWorkerMod = require('../js/scanner-worker.js');

    const requestedUrls = [];
    const cachesImpl = makeCacheStorageMock();
    const workerEvents = { inits: 0, frames: 0, terminated: 0 };
    let failWasmOnce = true;
    let camMode = 'ok';
    let failTorchApply = false;
    let torchCalls = [];
    let camStopCount = 0;

    class MockScannerWorker {
      constructor() {
        this._core = scannerWorkerMod.createScannerWorkerCore();
        this.onmessage = null;
      }
      postMessage(msg) {
        if (msg && msg.type === 'init') workerEvents.inits++;
        if (msg && msg.type === 'frame') workerEvents.frames++;
        Promise.resolve(this._core.handleMessage(msg)).then((reply) => {
          if (reply && typeof this.onmessage === 'function') {
            this.onmessage({ data: reply });
          }
        });
      }
      terminate() {
        workerEvents.terminated++;
      }
    }

    const mockTrack = {
      getCapabilities() { return { torch: true }; },
      async applyConstraints(c) {
        torchCalls.push(c);
        if (failTorchApply) throw new Error('torch locked');
      },
      stop() { camStopCount++; }
    };

    const huntCatalog = {
      schemaVersion: 1,
      meta: { title: 'Scanner Integ Catalog' },
      items: [
        {
          id: 'hunt-scan-01',
          category: 'Game',
          artist: 'Capcom',
          title: 'Breath of Fire III OST',
          regCatNo: 'CPCA-1004',
          catalog: 'CPCA-1004 (通常盤)',
          barcode: '4976219256789',
          kana: 'カ',
          filing: 'Shelf G1',
          price: '¥1,500'
        }
      ]
    };

    const backing = { stores: new Map() };
    const app = await bootApp({
      catalogObject: huntCatalog,
      cachesImpl,
      workerCtor: MockScannerWorker,
      extraNavigator: {
        mediaDevices: {
          async getUserMedia() {
            if (camMode === 'denied') {
              const e = new Error('Permission denied');
              e.name = 'NotAllowedError';
              throw e;
            }
            if (camMode === 'missing') {
              throw new Error('Requested device not found');
            }
            return {
              getTracks: () => [mockTrack],
              getVideoTracks: () => [mockTrack]
            };
          }
        }
      },
      indexedDBImpl: {
        open() {
          const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
          queueMicrotask(() => {
            const dbObj = {
              objectStoreNames: { contains: (s) => backing.stores.has(s) },
              createObjectStore: (s, opts) => {
                if (!backing.stores.has(s)) backing.stores.set(s, { keyPath: opts.keyPath, rows: new Map() });
                return { indexNames: { contains: () => true }, createIndex: () => {} };
              },
              transaction: (storeName) => {
                const storeMeta = backing.stores.get(storeName);
                const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                const makeReq = (exec) => {
                  const r = { result: undefined, error: null, onsuccess: null, onerror: null };
                  queueMicrotask(() => { exec(r); });
                  return r;
                };
                tx.objectStore = () => ({
                  get: (k) => makeReq((r) => { r.result = storeMeta.rows.get(k); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  put: (v) => makeReq((r) => { storeMeta.rows.set(v[storeMeta.keyPath], JSON.parse(JSON.stringify(v))); r.result = v[storeMeta.keyPath]; if (r.onsuccess) r.onsuccess({ target: r }); }),
                  delete: (k) => makeReq((r) => { storeMeta.rows.delete(k); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  getAll: () => makeReq((r) => { r.result = Array.from(storeMeta.rows.values()).map((v) => JSON.parse(JSON.stringify(v))); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  clear: () => makeReq((r) => { storeMeta.rows.clear(); if (r.onsuccess) r.onsuccess({ target: r }); })
                });
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
      },
      fetchImpl: async (url) => {
        const u = String(url);
        requestedUrls.push(u);
        if (u.endsWith('scanner-assets/v1/manifest.json')) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (u.endsWith('scanner-assets/v1/engine-shell.wasm')) {
          if (failWasmOnce) {
            failWasmOnce = false;
            return new Response('err', { status: 500 });
          }
          return new Response(wasmBytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
        }
        return new Response(JSON.stringify({ releases: [], results: [] }), { status: 200 });
      }
    });

    // Startup: 0 dynamic scanner scripts/CSS and 0 scanner asset network requests
    assert.equal(app.loadedDynamicAssets.length, 0);
    assert.equal(requestedUrls.some((u) => u.includes('scanner')), false);

    // Seed Owned item + mark Hunt checklist item before opening scanner
    app.triggerDocumentClick('toggle-acq', { 'data-id': 'hunt-scan-01' });
    await app.clickElement('modeCollectionBtn');
    await app.clickElement('addReleaseBtn');
    await app.inputText('rfArtist', 'Owned Scanner Artist');
    await app.inputText('rfTitle', 'Owned Scanner Album');
    await app.inputText('rfCatNo', 'OWN-SCN-9');
    await app.inputText('rfBarcode', '4900000000099');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '1 release · 0 tracks');

    // Click #openScannerBtn -> lazy-loads scanner JS/CSS + fetches manifest ONLY (0 WASM requests until confirmed!)
    await app.clickElement('openScannerBtn');
    assert.ok(app.loadedDynamicAssets.includes('./css/scanner.css'));
    assert.ok(app.loadedDynamicAssets.includes('./js/scanner-manager.js'));
    assert.ok(app.loadedDynamicAssets.includes('./js/scanner-ui.js'));
    assert.equal(app.elements.get('scannerModal').classList.contains('open'), true);
    assert.equal(app.elements.get('scannerGatePanel').classList.contains('hidden'), false);
    assert.ok(app.elements.get('scannerGateSizeText').textContent.includes('54 B'));
    assert.equal(requestedUrls.some((u) => u.endsWith('engine-shell.wasm')), false);
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), false);

    // Attach mock video & canvas properties for frame sampler + torch testing
    const videoEl = app.elements.get('scannerVideo');
    videoEl.readyState = 4;
    videoEl.videoWidth = 320;
    videoEl.videoHeight = 240;
    videoEl.play = async () => {};
    const canvasEl = app.elements.get('scannerCanvas');
    canvasEl.getContext = () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 48 * 4).fill(180) })
    });

    // Gate cancel & open Manager before confirming
    await app.clickElement('scannerCancelGateBtn');
    assert.equal(app.elements.get('scannerModal').classList.contains('open'), false);
    await app.clickElement('openScannerBtn');

    // First confirm hits HTTP 500 -> shows #scannerGateError without opening viewfinder
    await app.clickElement('scannerConfirmDownloadBtn');
    assert.equal(app.elements.get('scannerGateError').classList.contains('hidden'), false);
    assert.match(app.elements.get('scannerGateError').textContent, /HTTP 500/);

    // Second confirm succeeds -> downloads & verifies WASM, opens viewfinder, boots WASM worker & starts camera
    await app.clickElement('scannerConfirmDownloadBtn');
    await app.flush();
    assert.equal(requestedUrls.some((u) => u.endsWith('engine-shell.wasm')), true);
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), true);
    assert.equal(workerEvents.inits, 1);
    assert.equal(app.elements.get('scannerViewfinderPanel').classList.contains('hidden'), false);
    assert.ok(app.elements.get('scannerHudStatus').textContent.includes('ping 301'));

    // Wait briefly so 333ms frame sampler executes at least 1 frame -> updates #scannerFrameCounter & HUD
    await new Promise((r) => setTimeout(r, 380));
    assert.ok(workerEvents.frames >= 1);
    assert.ok(app.elements.get('scannerFrameCounter').textContent.includes('frame'));

    // Exercise Torch toggle (on + failure toast), Guide toggle, & Switch Camera
    await app.clickElement('scannerTorchBtn');
    assert.equal(app.elements.get('scannerTorchBtn').textContent, 'Torch: On');
    failTorchApply = true;
    await app.clickElement('scannerTorchBtn');
    assert.equal(app.elements.get('toast').textContent, 'Torch unavailable on this camera');
    failTorchApply = false;
    await app.clickElement('scannerGuideToggleBtn');
    assert.equal(app.elements.get('scannerReticle').classList.contains('scanner-reticle--square'), true);
    await app.clickElement('scannerSwitchCamBtn');

    // Test camera permission denied & missing errors cleanly
    camMode = 'denied';
    await app.clickElement('scannerStartCamBtn');
    assert.match(app.elements.get('scannerCamError').textContent, /permission denied/i);
    camMode = 'missing';
    await app.clickElement('scannerStartCamBtn');
    assert.match(app.elements.get('scannerCamError').textContent, /No live camera detected/i);
    camMode = 'ok';

    // Manual lookup: empty clear, Enter key on Hunt catno, jump to Hunt, Owned jump, and Add unknown code -> Release Form
    await app.inputText('scannerManualInput', '');
    await app.clickElement('scannerManualSubmitBtn');
    assert.equal(app.elements.get('scannerManualResult').classList.contains('hidden'), true);

    await app.inputText('scannerManualInput', 'CPCA-1004');
    await app.pressKey('scannerManualInput', 'Enter');
    assert.ok(app.elements.get('scannerManualResult').innerHTML.includes('On Hunt List'));
    app.elements.get('scannerManualResult').dispatchEvent({
      type: 'click',
      target: {
        closest: () => ({
          getAttribute: (k) => (k === 'data-scanner-jump' ? 'hunt' : k === 'data-target-id' ? 'hunt-scan-01' : null)
        })
      }
    });
    await app.flush();
    assert.equal(app.elements.get('lightboxModal').classList.contains('open'), true);
    await app.clickElement('closeLightboxBtn');

    // Reopen straight into viewfinder, lookup Owned barcode, jump to Owned Crate Flip
    await app.clickElement('openScannerBtn');
    await app.inputText('scannerManualInput', '4900000000099');
    await app.clickElement('scannerManualSubmitBtn');
    assert.ok(app.elements.get('scannerManualResult').innerHTML.includes('Already Owned'));
    app.elements.get('scannerManualResult').dispatchEvent({
      type: 'click',
      target: {
        closest: () => ({
          getAttribute: (k) => (k === 'data-scanner-jump' ? 'owned' : k === 'data-target-id' ? 'own-own-scn-9' : null)
        })
      }
    });
    await app.flush();
    assert.equal(app.elements.get('lightboxModal').classList.contains('open'), true);
    await app.clickElement('closeLightboxBtn');

    // Unknown barcode -> "+ Add to Collection" opens #releaseFormModal prefilled with barcode
    await app.clickElement('openScannerBtn');
    await app.inputText('scannerManualInput', '4988001122334');
    await app.clickElement('scannerManualSubmitBtn');
    app.elements.get('scannerManualResult').dispatchEvent({
      type: 'click',
      target: {
        closest: () => ({
          getAttribute: (k) => (k === 'data-scanner-add' ? '4988001122334' : null)
        })
      }
    });
    await app.flush();
    assert.equal(app.elements.get('releaseFormModal').classList.contains('open'), true);
    assert.equal(app.elements.get('rfBarcode').value, '4988001122334');
    await app.clickElement('cancelReleaseFormBtn');

    // Engine Manager: per-pack Remove/Download, Back -> gate & viewfinder, Pre-Download, Backdrop/Escape/visibility/pagehide, & Wipe
    await app.clickElement('openScannerBtn');
    await app.clickElement('scannerViewManagerBtn');
    assert.equal(app.elements.get('scannerManagerPanel').classList.contains('hidden'), false);
    const packsListEl = app.elements.get('scannerManagerPacksList');
    packsListEl.dispatchEvent({
      type: 'click',
      target: { getAttribute: (k) => (k === 'data-scanner-del' ? 'engine-shell' : null) }
    });
    await app.flush();
    await app.clickElement('scannerBackToScanBtn');
    assert.equal(app.elements.get('scannerGatePanel').classList.contains('hidden'), false);

    await app.clickElement('scannerOpenManagerBtn');
    packsListEl.dispatchEvent({
      type: 'click',
      target: { getAttribute: (k) => (k === 'data-scanner-dl' ? 'engine-shell' : null) }
    });
    await app.flush();
    await app.clickElement('scannerPreDownloadAllBtn');
    await app.clickElement('scannerBackToScanBtn');
    assert.equal(app.elements.get('scannerViewfinderPanel').classList.contains('hidden'), false);

    // Escape, backdrop click, visibilitychange('hidden'), and pagehide cleanly close & tear down
    await app.triggerKeydown('Escape');
    assert.equal(app.elements.get('scannerModal').classList.contains('open'), false);
    await app.clickElement('openScannerBtn');
    await app.triggerVisibilityChange('hidden');
    assert.equal(app.elements.get('scannerModal').classList.contains('open'), false);
    app.document.visibilityState = 'visible';
    await app.clickElement('openScannerBtn');
    await app.triggerPageHide();
    assert.equal(app.elements.get('scannerModal').classList.contains('open'), false);

    // Reopen, Wipe cleanly, verify Hunt & Owned data preserved
    await app.clickElement('openScannerBtn');
    await app.clickElement('scannerViewManagerBtn');
    await app.clickElement('scannerWipeBtn');
    assert.ok(workerEvents.terminated >= 1);
    assert.ok(camStopCount >= 1);
    assert.equal(await cachesImpl.has('disk-crate-scanner-assets-v1'), false);

    await app.clickElement('closeScannerModalBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '1 release · 0 tracks');
    await app.clickElement('modeHuntBtn');
    assert.equal(app.elements.get('progressBadge').textContent, '1 / 1');
  });

  it('covers Collection 1-Col view, release form validations, JSON download/file upload, Owned Sheet errors, and session 401 expiry', async () => {
    const sharedBacking = { stores: new Map() };
    const jwt = makeFakeSyncJwt({ login: 'alice' });
    let sheetPushMode = 'ok';
    let return401OnBatch = false;

    const app = await bootApp({
      catalogObject: {
        schemaVersion: 1,
        meta: { title: 'Col 1-Col Catalog' },
        items: [
          { id: 'c1', category: 'OST', artist: 'A', title: 'T', regCatNo: 'C-1', catalog: 'C-1', kana: 'ア', filing: 'S1', price: '¥500' }
        ]
      },
      syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev',
      syncDebounceMs: 10,
      initialStorage: { cd_hunt_sync_token_v1: jwt },
      indexedDBImpl: {
        open() {
          const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
          queueMicrotask(() => {
            const dbObj = {
              objectStoreNames: { contains: (s) => sharedBacking.stores.has(s) },
              createObjectStore: (s, opts) => {
                if (!sharedBacking.stores.has(s)) sharedBacking.stores.set(s, { keyPath: opts.keyPath, rows: new Map() });
                return { indexNames: { contains: () => true }, createIndex: () => {} };
              },
              transaction: (storeName) => {
                const storeMeta = sharedBacking.stores.get(storeName);
                const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                const makeReq = (exec) => {
                  const r = { result: undefined, error: null, onsuccess: null, onerror: null };
                  queueMicrotask(() => { exec(r); });
                  return r;
                };
                tx.objectStore = () => ({
                  get: (k) => makeReq((r) => { r.result = storeMeta.rows.get(k); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  put: (v) => makeReq((r) => { storeMeta.rows.set(v[storeMeta.keyPath], JSON.parse(JSON.stringify(v))); r.result = v[storeMeta.keyPath]; if (r.onsuccess) r.onsuccess({ target: r }); }),
                  delete: (k) => makeReq((r) => { storeMeta.rows.delete(k); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  getAll: () => makeReq((r) => { r.result = Array.from(storeMeta.rows.values()).map((v) => JSON.parse(JSON.stringify(v))); if (r.onsuccess) r.onsuccess({ target: r }); }),
                  clear: () => makeReq((r) => { storeMeta.rows.clear(); if (r.onsuccess) r.onsuccess({ target: r }); })
                });
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
      },
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        const m = String(init.method || 'GET').toUpperCase();
        if (u.endsWith('/api/status')) {
          return { ok: true, status: 200, async json() { return { ok: true, sheetSync: { configured: true, serviceAccountEmail: 'bot@e.iam' } }; } };
        }
        if (u.endsWith('/api/state') && m === 'GET') {
          return { ok: true, status: 200, async json() { return { user: { login: 'alice' }, updatedAt: 1, shareUrl: 'https://cd-hunt-sync.tndo.workers.dev/api/share/tok', state: null }; } };
        }
        if (u.includes('/api/collection/batch')) {
          if (return401OnBatch) return { ok: false, status: 401, async json() { return { ok: false }; } };
          const body = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, accepted: body.items.map((x, idx) => ({ id: x.id, syncSeq: idx + 1, clientUpdatedAt: x.clientUpdatedAt })), conflicts: [], latestSeq: body.items.length };
            }
          };
        }
        if (u.includes('/api/collection/sheet-sync')) {
          if (sheetPushMode === 'skipped') return { ok: true, status: 200, async json() { return { ok: false, skipped: true }; } };
          if (sheetPushMode === 'err') return { ok: false, status: 502, async json() { return { error: 'sheet api 502' }; } };
          return { ok: true, status: 200, async json() { return { ok: true, writtenRows: 1 }; } };
        }
        if (u.includes('/api/collection')) {
          return { ok: true, status: 200, async json() { return { ok: true, items: [], hasMore: false, latestSeq: 0 }; } };
        }
        if (u.includes('docs.google.com/spreadsheets/d/badOwned/')) {
          return { ok: false, status: 500 };
        }
        if (u.includes('musicbrainz.org')) {
          if (u.includes('offline-throw')) throw new Error('MB offline');
          return { ok: true, status: 200, async json() { return { releases: [] }; } };
        }
        return { ok: true, status: 200, async json() { return { results: [] }; } };
      }
    });

    // Release Form validation & lookup edge cases
    await app.clickElement('modeCollectionBtn');
    await app.clickElement('addReleaseBtn');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('toast').textContent, 'Artist, Title, and Catalog Number are required');

    await app.inputText('rfArtist', 'Single Col Artist');
    await app.inputText('rfTitle', 'Single Col Title');
    await app.inputText('rfCatNo', 'SCOL-001');
    await app.inputText('rfBarcode', '123');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('toast').textContent, 'Barcode must contain 8 to 14 digits');

    await app.inputText('rfBarcode', '4900000000123');
    await app.inputText('rfMbid', 'not-a-uuid');
    await app.clickElement('saveReleaseFormBtn');
    assert.equal(app.elements.get('toast').textContent, 'MusicBrainz ID must be a valid UUID');
    await app.inputText('rfMbid', '');

    await app.inputText('releaseLookupInput', 'no-hits');
    await app.pressKey('releaseLookupInput', 'Enter');
    assert.ok(app.elements.get('releaseLookupResults').innerHTML.includes('No matching releases found'));
    const origLookup = app.window.DiskCrate.trackResolver.lookupReleaseCandidates;
    app.window.DiskCrate.trackResolver.lookupReleaseCandidates = async () => { throw new Error('MB offline'); };
    await app.inputText('releaseLookupInput', 'offline-throw');
    await app.clickElement('releaseLookupBtn');
    app.window.DiskCrate.trackResolver.lookupReleaseCandidates = origLookup;
    assert.ok(app.elements.get('releaseLookupResults').innerHTML.includes('Lookup unavailable offline'));

    await app.inputText('rfPurchaseShop', 'Mandarake');
    await app.inputText('rfPurchaseDate', '2026-11-28');
    await app.inputText('rfPurchasePrice', '¥900');
    await app.inputText('rfNotes', 'Obi mint');
    await app.inputText('rfTracksInput', '1. Initial Track (3:00)');
    await app.clickElement('saveReleaseFormBtn');

    // Switch to 1-Column View in Collection mode -> exercises 1-Col markup + edit-owned / delete-owned
    await app.clickElement('viewModeBtn');
    const colHtml = app.elements.get('albumGrid').innerHTML;
    assert.ok(colHtml.includes('Mandarake'));
    assert.ok(colHtml.includes('Single Col Artist'));

    // Edit tracks in Crate Flip (save & clear) -> syncOwnedReleaseTracksChange
    await app.clickElement('openCrateFlipBtn');
    await app.clickElement('lbEditTracksBtn');
    await app.inputText('lbTrackEditorInput', '1. Overridden Collection Track (4:00)');
    await app.clickElement('saveManualTracksBtn');
    await app.clickElement('lbResetTracksBtn');
    assert.ok(app.elements.get('toast').textContent.includes('Cleared custom track list'));
    await app.clickElement('closeLightboxBtn');

    // Backup Modal: Copy, Download fallback & Blob, File Upload text/FileReader/error, Sheet Import & Push branches
    await app.clickElement('collectionBackupBtn');
    await app.clickElement('copyCollectionBackupBtn');
    assert.equal(app.elements.get('toast').textContent, 'Copied Collection JSON');

    const OrigURL = app.window.URL;
    app.window.Blob = function (parts) { this.parts = parts; };
    app.window.URL = { createObjectURL: () => 'blob:mock-1', revokeObjectURL: () => {} };
    await app.clickElement('downloadCollectionJsonBtn');
    assert.equal(app.elements.get('toast').textContent, 'Downloaded owned-collection.json');

    app.window.URL = {};
    await app.clickElement('downloadCollectionJsonBtn');
    assert.equal(app.elements.get('toast').textContent, 'Copied Collection JSON');
    app.window.URL = OrigURL;

    const colFileIn = app.elements.get('collectionJsonFileInput');
    await app.clickElement('uploadCollectionJsonBtn');
    colFileIn.files = [{ name: 'col.json', async text() { return JSON.stringify({ schemaVersion: 1, items: [] }); } }];
    colFileIn.dispatchEvent({ type: 'change', target: colFileIn });
    await app.flush();
    assert.ok(app.elements.get('toast').textContent.includes('Loaded col.json'));

    colFileIn.files = [{ name: 'fr.json', _content: JSON.stringify({ schemaVersion: 1, items: [] }) }];
    colFileIn.dispatchEvent({ type: 'change', target: colFileIn });
    await app.flush();
    assert.ok(app.elements.get('toast').textContent.includes('Loaded fr.json'));

    colFileIn.files = [{ name: 'bad.json', _failRead: true }];
    colFileIn.dispatchEvent({ type: 'change', target: colFileIn });
    await app.flush();
    assert.equal(app.elements.get('toast').textContent, 'Failed to read JSON file');

    await app.inputText('ownedSheetUrlInput', 'https://example.com/invalid');
    await app.clickElement('importOwnedSheetBtn');
    assert.equal(app.elements.get('toast').textContent, 'Enter a valid Google Sheet URL');

    await app.inputText('ownedSheetUrlInput', 'https://docs.google.com/spreadsheets/d/badOwned/edit');
    await app.clickElement('importOwnedSheetBtn');
    assert.match(app.elements.get('toast').textContent, /Failed to import Owned Sheet/);

    await app.clickElement('pushOwnedSheetBtn');
    assert.ok(app.elements.get('toast').textContent.includes('Synced 1 owned row'));
    sheetPushMode = 'skipped';
    await app.clickElement('pushOwnedSheetBtn');
    assert.ok(app.elements.get('toast').textContent.includes('service account not configured'));
    sheetPushMode = 'err';
    await app.clickElement('pushOwnedSheetBtn');
    assert.match(app.elements.get('toast').textContent, /Google Sheet sync failed/);

    await app.inputText('ownedSheetUrlInput', 'bad-url');
    await app.clickElement('pushOwnedSheetBtn');
    assert.equal(app.elements.get('toast').textContent, 'Enter a valid Google Sheet URL');

    await app.clickElement('closeCollectionBackupBtn');
    await app.clickElement('closeReleaseFormBtn');

    // Trigger edit-owned & delete-owned -> 401 session expiry clears session cleanly
    app.triggerDocumentClick('edit-owned', { 'data-id': 'own-scol-001' });
    await app.clickElement('cancelReleaseFormBtn');
    return401OnBatch = true;
    app.triggerDocumentClick('delete-owned', { 'data-id': 'own-scol-001' });
    await new Promise((r) => setTimeout(r, 65));
    assert.ok(app.elements.get('syncStatusPill').textContent.includes('Session expired'));

    // Signed out pushOwnedSheetBtn guard
    await app.clickElement('collectionBackupBtn');
    await app.clickElement('pushOwnedSheetBtn');
    assert.equal(app.elements.get('toast').textContent, 'Sign in with GitHub first to sync to Google Sheets');
  });
});
