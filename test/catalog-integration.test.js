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
    expectedTitle: 'Sample CD Hunt',
    expectedPhysical: 1,
    expectedDigital: 1
  };
}
const VALIDATE_PATH = path.join(ROOT_DIR, 'js', 'validate.js');
const STORAGE_PATH = path.join(ROOT_DIR, 'js', 'storage.js');
const COVER_RESOLVER_PATH = path.join(ROOT_DIR, 'js', 'cover-resolver.js');
const CONFIG_PATH = path.join(ROOT_DIR, 'js', 'config.js');
const SYNC_PATH = path.join(ROOT_DIR, 'js', 'sync.js');
const SHEET_ADAPTER_PATH = path.join(ROOT_DIR, 'js', 'sheet-adapter.js');
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
  pathname = '/cd-hunt/',
  syncApiUrl = '',
  syncDebounceMs = 10,
  fetchImpl,
  imageImpl,
  disableIntersectionObserver = false,
  clipboardMode = 'async',
  execCommandThrow = false
} = {}) {
  const html = readAppHtml();
  const validatorSource = readValidatorSource();
  const storageSource = fs.readFileSync(STORAGE_PATH, 'utf8');
  const coverResolverSource = fs.readFileSync(COVER_RESOLVER_PATH, 'utf8');
  const configSource = fs.readFileSync(CONFIG_PATH, 'utf8');
  const syncSource = fs.readFileSync(SYNC_PATH, 'utf8');
  const sheetAdapterSource = fs.readFileSync(SHEET_ADAPTER_PATH, 'utf8');
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
    assign(nextUrl) {
      locationNavigations.push(nextUrl);
    }
  };
  let lastCreatedElement = null;

  const winListeners = {};
  const documentStub = {
    title: '',
    readyState: 'complete',
    visibilityState: 'visible',
    body: {
      appendChild() {},
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

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    Image: imageImpl || MockImage,
    FileReader: MockFileReader,
    setTimeout,
    clearTimeout,
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
  vm.runInContext(coverResolverSource, context, { filename: COVER_RESOLVER_PATH });
  vm.runInContext(configSource, context, { filename: CONFIG_PATH });
  context.CDHunt.config.syncApiUrl = syncApiUrl;
  context.CDHunt.config.syncDebounceMs = syncDebounceMs;
  vm.runInContext(syncSource, context, { filename: SYNC_PATH });
  vm.runInContext(sheetAdapterSource, context, { filename: SHEET_ADAPTER_PATH });
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
    async swipeLightbox(dx) {
      const stage = elements.get('lbStage');
      assert.ok(stage, 'Element #lbStage must exist');
      stage.dispatchEvent({ type: 'touchstart', changedTouches: [{ screenX: 200 }] });
      stage.dispatchEvent({ type: 'touchend', changedTouches: [{ screenX: 200 + dx }] });
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
    $schema: 'https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json',
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
    assert.ok(html.includes('<title>CD Hunt'), 'index.html should use generic CD Hunt default title');
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
      '<script src="./js/cover-resolver.js"></script>',
      '<script src="./js/config.js"></script>',
      '<script src="./js/sync.js"></script>',
      '<script src="./js/sheet-adapter.js"></script>',
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
    assert.equal(typeof sandbox.window.CDHunt.validateCatalog, 'function');
    assert.equal(typeof sandbox.window.CDHunt.normalizeCatalogUrl, 'function');
    const result = sandbox.window.validateCatalog(makeValidRemoteCatalog());
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true, errors: [] });
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
      'https://dopingus-build.github.io/cd-hunt/?catalog=' + encodeURIComponent(expectedRaw)
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
    $schema: 'https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json',
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

    // Swipe navigation on #lbStage (dx < -45 -> next, dx > 45 -> prev)
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

    // Also handles CSV content even if filename lacks .csv extension
    await app.selectLocalFile('exported-sheet.txt', csvText);
    assert.equal(app.elements.get('toast').textContent, 'Loaded local CSV: exported-sheet.txt');
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
});
