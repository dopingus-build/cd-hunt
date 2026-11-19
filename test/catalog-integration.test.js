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
const OSAKA_METADATA_PATH = path.join(ROOT_DIR, '..', 'cd-metadata', '2026-japan.json');
const OSAKA_INDEX_PATH = path.join(ROOT_DIR, '..', 'cd-metadata', 'index.json');
const SAMPLE_CATALOG_PATH = path.join(ROOT_DIR, 'docs', 'sample-catalog.json');

function getPresetTestFixtures() {
  if (fs.existsSync(OSAKA_INDEX_PATH) && fs.existsSync(OSAKA_METADATA_PATH)) {
    const catalogJson = JSON.parse(fs.readFileSync(OSAKA_METADATA_PATH, 'utf8'));
    return {
      indexJson: JSON.parse(fs.readFileSync(OSAKA_INDEX_PATH, 'utf8')),
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

function createElementStub(id, initialClasses = []) {
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

function buildDomElements(html) {
  const elements = new Map();
  const tagRegex = /<[^>]*\bid=["']([^"']+)["'][^>]*>/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const id = match[1];
    const classMatch = fullTag.match(/\bclass=["']([^"']+)["']/);
    const initialClasses = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    elements.set(id, createElementStub(id, initialClasses));
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
  search = '',
  origin = 'https://dopingus-build.github.io',
  pathname = '/cd-hunt/',
  fetchImpl
} = {}) {
  const html = readAppHtml();
  const validatorSource = readValidatorSource();
  const storageSource = fs.readFileSync(STORAGE_PATH, 'utf8');
  const coverResolverSource = fs.readFileSync(COVER_RESOLVER_PATH, 'utf8');
  const appScript = fs.readFileSync(APP_PATH, 'utf8');
  const elements = buildDomElements(html);
  const docListeners = {};
  const localStorage = createStorage();
  if (savedCatalogUrl) {
    localStorage.setItem('cd_hunt_catalog_url_v1', savedCatalogUrl);
  }

  const copiedTexts = [];
  const historyUpdates = [];
  const locationObj = { search, origin, pathname };

  const documentStub = {
    title: '',
    readyState: 'complete',
    body: {
      appendChild() {},
      removeChild() {}
    },
    getElementById(id) {
      return elements.get(id) || null;
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
      return [];
    },
    createElement() {
      return createElementStub('dynamic');
    },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    }
  };

  class NoopIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  class MockImage {
    set src(_) {}
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    IntersectionObserver: NoopIntersectionObserver,
    Image: MockImage,
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
        if (String(url).endsWith('/index.json') && fs.existsSync(OSAKA_INDEX_PATH)) {
          return {
            ok: true,
            status: 200,
            async json() {
              return JSON.parse(fs.readFileSync(OSAKA_INDEX_PATH, 'utf8'));
            }
          };
        }
        throw new Error('Unexpected network fetch in offline test: ' + url);
      })
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  if (catalogObject !== undefined) {
    context.CD_HUNT_CATALOG = catalogObject;
  }

  vm.runInContext(validatorSource, context);
  vm.runInContext(storageSource, context);
  vm.runInContext(coverResolverSource, context);
  vm.runInContext(appScript, context);

  async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await flush();

  return {
    elements,
    localStorage,
    historyUpdates,
    copiedTexts,
    document: documentStub,
    window: context,
    flush,
    async clickElement(id) {
      const el = elements.get(id);
      assert.ok(el, `Element #${id} must exist`);
      el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
      await flush();
    },
    async selectLocalFile(name, jsonContent) {
      const fileInput = elements.get('catalogFileInput');
      assert.ok(fileInput, 'Element #catalogFileInput must exist');
      const fileObj = {
        name,
        async text() {
          return typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);
        }
      };
      fileInput.files = [fileObj];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
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
