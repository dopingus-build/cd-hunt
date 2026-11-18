'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT_DIR, 'osaka_cd_cover_album.html');
const CSS_PATH = path.join(ROOT_DIR, 'css', 'styles.css');
const CATALOG_PATH = path.join(ROOT_DIR, 'data', 'catalog.js');
const VALIDATE_PATH = path.join(ROOT_DIR, 'js', 'validate.js');
const STORAGE_PATH = path.join(ROOT_DIR, 'js', 'storage.js');
const COVER_RESOLVER_PATH = path.join(ROOT_DIR, 'js', 'cover-resolver.js');
const APP_PATH = path.join(ROOT_DIR, 'js', 'app.js');

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

async function bootApp({ catalogObject, useRealCatalogFile = false, search = '', fetchImpl } = {}) {
  const html = readAppHtml();
  const validatorSource = readValidatorSource();
  const storageSource = fs.readFileSync(STORAGE_PATH, 'utf8');
  const coverResolverSource = fs.readFileSync(COVER_RESOLVER_PATH, 'utf8');
  const appScript = fs.readFileSync(APP_PATH, 'utf8');
  const elements = buildDomElements(html);
  const docListeners = {};
  const localStorage = createStorage();

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
    location: { search },
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error('Unexpected network fetch in offline test');
      })
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // Load catalog/data + js modules in HTML script order
  if (useRealCatalogFile) {
    vm.runInContext(fs.readFileSync(CATALOG_PATH, 'utf8'), context);
  } else if (catalogObject !== undefined) {
    context.CD_HUNT_CATALOG = catalogObject;
  }

  vm.runInContext(validatorSource, context);
  vm.runInContext(storageSource, context);
  vm.runInContext(coverResolverSource, context);
  vm.runInContext(appScript, context);

  // Wait for async initApp() microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 15));

  return {
    elements,
    localStorage,
    document: documentStub,
    window: context,
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
    meta: {
      title: 'Tokyo Vinyl & CD Hunt',
      subtitle: 'Disk Union Crate Browser',
      documentTitle: 'Tokyo Hunt',
      storagePrefix: 'tokyo_hunt',
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

describe('HTML asset & script wiring', () => {
  it('links ./css/styles.css and loads data & modular js scripts in order', () => {
    const html = readAppHtml();
    assert.ok(fs.existsSync(CSS_PATH), 'css/styles.css must exist');
    assert.ok(
      html.includes('<link rel="stylesheet" href="./css/styles.css" />'),
      'Expected <link rel="stylesheet" href="./css/styles.css" /> in HTML'
    );

    const expectedScripts = [
      '<script src="./data/catalog.js"></script>',
      '<script src="./js/validate.js"></script>',
      '<script src="./js/storage.js"></script>',
      '<script src="./js/cover-resolver.js"></script>',
      '<script src="./js/app.js"></script>'
    ];

    let lastIdx = -1;
    for (const tag of expectedScripts) {
      const idx = html.indexOf(tag);
      assert.notEqual(idx, -1, `Expected ${tag} in HTML`);
      assert.ok(idx > lastIdx, `Expected ${tag} to appear in dependency order`);
      lastIdx = idx;
    }
  });
});

describe('Browser and Node dual export for js/validate.js', () => {
  it('attaches window.validateCatalog when executed in a browser global context', () => {
    const validatorSource = readValidatorSource();
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(validatorSource, sandbox);

    assert.equal(typeof sandbox.window.validateCatalog, 'function');
    assert.equal(typeof sandbox.window.CDHunt.validateCatalog, 'function');
    const result = sandbox.window.validateCatalog(makeValidRemoteCatalog());
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true, errors: [] });
  });
});

describe('Default catalog startup integration (data/catalog.js + js/* + HTML)', () => {
  it('boots cleanly, displays 53 physical cards and 2 digital-only cards with hidden errorBanner', async () => {
    const app = await bootApp({ useRealCatalogFile: true });
    const errorBanner = app.elements.get('errorBanner');
    const brandTitle = app.elements.get('brandTitle');
    const progressBadge = app.elements.get('progressBadge');
    const albumGrid = app.elements.get('albumGrid');
    const digitalGrid = app.elements.get('digitalGrid');

    assert.notEqual(errorBanner.style.display, 'block', `Unexpected errorBanner: ${errorBanner.textContent}`);
    assert.equal(brandTitle.textContent, 'Osaka CD Cover Album');
    assert.equal(progressBadge.textContent, '0 / 53');

    const physicalCards = albumGrid.innerHTML.match(/<article class="cd-card/g) || [];
    const digitalCards = digitalGrid.innerHTML.match(/<article class="cd-card/g) || [];
    assert.equal(physicalCards.length, 53);
    assert.equal(digitalCards.length, 2);
  });
});

describe('Invalid catalog rejection on startup', () => {
  it('displays errorBanner and leaves albumGrid empty for duplicate item IDs', async () => {
    const base = makeValidRemoteCatalog();
    base.items.push(Object.assign({}, base.items[0], { title: 'Duplicate ID Item' }));

    const app = await bootApp({ catalogObject: base });
    const errorBanner = app.elements.get('errorBanner');
    const albumGrid = app.elements.get('albumGrid');

    assert.equal(errorBanner.style.display, 'block');
    assert.ok(errorBanner.textContent.toLowerCase().includes('duplicate'));
    assert.equal(albumGrid.innerHTML, '');
  });

  it('displays errorBanner and leaves albumGrid empty when required fields are missing', async () => {
    const bad = makeValidRemoteCatalog();
    delete bad.items[0].artist;

    const app = await bootApp({ catalogObject: bad });
    const errorBanner = app.elements.get('errorBanner');
    const albumGrid = app.elements.get('albumGrid');

    assert.equal(errorBanner.style.display, 'block');
    assert.ok(errorBanner.textContent.includes('artist'));
    assert.equal(albumGrid.innerHTML, '');
  });

  it('displays errorBanner when itunesQuery is provided without requiredGroups', async () => {
    const bad = makeValidRemoteCatalog();
    delete bad.items[0].requiredGroups;

    const app = await bootApp({ catalogObject: bad });
    const errorBanner = app.elements.get('errorBanner');
    const albumGrid = app.elements.get('albumGrid');

    assert.equal(errorBanner.style.display, 'block');
    assert.ok(errorBanner.textContent.includes('requiredGroups'));
    assert.equal(albumGrid.innerHTML, '');
  });
});

describe('Remote ?catalog=<url> JSON loading and validation', () => {
  it('loads valid remote JSON, updates branding, auto-derives categories, and hides digital-only UI when none exist', async () => {
    const remoteCatalog = makeValidRemoteCatalog();
    let requestedUrl = null;

    const app = await bootApp({
      search: '?catalog=https://example.com/custom.json',
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

    assert.equal(requestedUrl, 'https://example.com/custom.json');
    assert.notEqual(app.elements.get('errorBanner').style.display, 'block');
    assert.equal(app.elements.get('brandTitle').textContent, 'Tokyo Vinyl & CD Hunt');
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');
    assert.ok(app.elements.get('digitalNoteBanner').classList.contains('hidden'));
    assert.ok(app.elements.get('digitalOnlySection').classList.contains('hidden'));

    const pillsHtml = app.elements.get('categoryPills').innerHTML;
    assert.ok(pillsHtml.includes('All Releases'));
    assert.ok(pillsHtml.includes('J-Rock'));
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

describe('Storage namespacing and checklist persistence integration', () => {
  it('persists acquired state under <storagePrefix>_checklist_v2 and updates progressBadge', async () => {
    const catalog = makeValidRemoteCatalog();
    catalog.meta.storagePrefix = 'custom_prefix';

    const app = await bootApp({ catalogObject: catalog });
    assert.equal(app.elements.get('progressBadge').textContent, '0 / 1');

    app.triggerDocumentClick('toggle-acq', { 'data-id': 'tok-01' });

    assert.equal(app.elements.get('progressBadge').textContent, '1 / 1');
    assert.deepEqual(
      JSON.parse(app.localStorage.getItem('custom_prefix_checklist_v2')),
      { 'tok-01': true }
    );
  });
});
