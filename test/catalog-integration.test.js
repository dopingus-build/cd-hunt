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
  origin = 'https://dopingus-build.github.io',
  pathname = '/cd-hunt/',
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
  const locationObj = { search, origin, pathname };
  let lastCreatedElement = null;

  const documentStub = {
    title: '',
    readyState: 'complete',
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
    URLSearchParams,
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
    history: {
      replaceState(_state, _title, nextUrl) {
        historyUpdates.push(nextUrl);
        const qIdx = String(nextUrl).indexOf('?');
        locationObj.search = qIdx !== -1 ? String(nextUrl).slice(qIdx) : '';
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
  vm.runInContext(appScript, context, { filename: APP_PATH });

  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await flush();

  return {
    elements,
    localStorage,
    historyUpdates,
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

    const expectedScripts = [
      '<script src="./js/validate.js"></script>',
      '<script src="./js/storage.js"></script>',
      '<script src="./js/cover-resolver.js"></script>',
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

    // Cycle variant with cycle-one and step-var
    app.triggerDocumentClick('cycle-one', { 'data-id': 'cd-01' });
    await app.flush();
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('2/3'));

    app.triggerDocumentClick('step-var', { 'data-id': 'cd-01', 'data-delta': '-1' });
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('1/3'));

    // Select specific variant index
    app.triggerDocumentClick('select-var', { 'data-id': 'cd-01', 'data-idx': '2' });
    assert.ok(app.elements.get('art-slot-cd-01').innerHTML.includes('3/3'));

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

    // Open via #openCrateFlipBtn
    await app.clickElement('openCrateFlipBtn');
    const modal = app.elements.get('lightboxModal');
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    assert.equal(app.elements.get('lbArtist').textContent, 'yama');

    // Step via buttons
    await app.clickElement('lbNextBtn');
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    assert.equal(app.elements.get('lbArtist').textContent, 'Yoshino Aoki');
    await app.clickElement('lbPrevBtn');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');

    // Step via keyboard (ignores when INPUT focused)
    await app.triggerKeydown('ArrowRight', 'INPUT');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');
    await app.triggerKeydown('ArrowRight');
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    await app.triggerKeydown('ArrowLeft');
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');

    // Swipe navigation on #lbStage (dx < -45 -> next, dx > 45 -> prev)
    await app.swipeLightbox(-80);
    assert.equal(app.elements.get('lbCounter').textContent, '2 / 3');
    await app.swipeLightbox(80);
    assert.equal(app.elements.get('lbCounter').textContent, '1 / 3');

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

    // Navigate to digital item in lightbox and verify button label
    app.triggerDocumentClick('open-lb', { 'data-lb-idx': '2' });
    assert.equal(app.elements.get('lbAcquireBtn').textContent, '+ Mark Saved (Digital)');

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
