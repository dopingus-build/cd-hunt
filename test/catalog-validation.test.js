'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vm = require('node:vm');

let validateCatalog = null;
let normalizeCatalogUrl = null;
let extractGoogleSheetId = null;
let storageModule = null;
let deriveStoragePrefix = null;
let coverResolverModule = null;
let sheetAdapterModule = null;
let loadError = null;

try {
  ({ validateCatalog, normalizeCatalogUrl, extractGoogleSheetId } = require('../js/validate.js'));
  storageModule = require('../js/storage.js');
  ({ deriveStoragePrefix } = storageModule);
  coverResolverModule = require('../js/cover-resolver.js');
  sheetAdapterModule = require('../js/sheet-adapter.js');
} catch (err) {
  loadError = err;
}

function getValidator() {
  assert.ifError(loadError);
  assert.equal(typeof validateCatalog, 'function', 'js/validate.js must export a validateCatalog function');
  return validateCatalog;
}

function getNormalizer() {
  assert.ifError(loadError);
  assert.equal(typeof normalizeCatalogUrl, 'function', 'js/validate.js must export a normalizeCatalogUrl function');
  return normalizeCatalogUrl;
}

function getPrefixDeriver() {
  assert.ifError(loadError);
  assert.equal(typeof deriveStoragePrefix, 'function', 'js/storage.js must export deriveStoragePrefix');
  return deriveStoragePrefix;
}

function makeValidItem(overrides = {}) {
  return Object.assign(
    {
      id: 'cd-01',
      category: 'Anime Themes & Chara',
      artist: 'Example Artist',
      artistJa: 'アーティスト',
      title: 'Example Album',
      titleJa: 'アルバム',
      regCatNo: 'ABCD-1001',
      catalog: 'ABCD-1001 (通常盤)',
      mbEditions: [{ catno: 'ABCD-1001', label: '通常盤 Regular' }],
      kana: 'ア / A',
      filing: 'ア (Example Artist) — Anime aisle',
      price: '¥500–¥1,000',
      itunesQuery: 'Example Album Example Artist',
      requiredGroups: [['example'], ['album']],
      accent: '#e11d48'
    },
    overrides
  );
}

function makeValidCatalog(overrides = {}) {
  return Object.assign(
    {
      $schema: 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json',
      schemaVersion: 1,
      meta: {
        title: 'Test CD Cover Album',
        subtitle: 'Crate Browser (通常盤 Priority)',
        documentTitle: 'Test CD Cover Album & Checklist',
        searchPlaceholder: 'Search artist or catalog...',
        digitalSectionTitle: 'Digital-Only Releases',
        digitalSectionSubtitle: 'No physical CD exists.'
      },
      categories: [
        { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
        { key: 'Anime Themes & Chara', label: 'Anime Themes & Chara', dot: '#f43f5e' }
      ],
      items: [makeValidItem()]
    },
    overrides
  );
}

describe('Catalog validation & storage module exports', () => {
  it('exports validateCatalog, normalizeCatalogUrl, and deriveStoragePrefix', () => {
    getValidator();
    getNormalizer();
    getPrefixDeriver();
  });
});

describe('Versioned JSON Schema (schemas/catalog.v1.schema.json)', () => {
  it('exists, parses cleanly, and enforces schemaVersion: 1 and no storagePrefix', () => {
    const schemaPath = path.join(__dirname, '..', 'schemas', 'catalog.v1.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.$id, 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json');
    assert.deepEqual(schema.required, ['schemaVersion', 'items']);
    assert.equal(schema.properties.schemaVersion.const, 1);
    assert.equal(schema.properties.meta.additionalProperties, false);
    assert.equal(schema.properties.meta.properties.storagePrefix, undefined);
  });
});

describe('Sample catalog (docs/sample-catalog.json)', () => {
  it('passes validation with zero errors and declares schemaVersion: 1', () => {
    const validate = getValidator();
    const samplePath = path.join(__dirname, '..', 'docs', 'sample-catalog.json');
    const data = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.$schema, 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json');
    assert.equal(data.meta.storagePrefix, undefined);
    assert.deepEqual(validate(data), { valid: true, errors: [] });
  });
});

describe('External metadata repository (cd-metadata)', () => {
  it('validates 2026-japan.json and index.json when sibling cd-metadata repo is present', () => {
    const validate = getValidator();
    const osakaPath = path.join(__dirname, '..', '..', 'cd-metadata', '2026-japan.json');
    const indexPath = path.join(__dirname, '..', '..', 'cd-metadata', 'index.json');
    if (!fs.existsSync(osakaPath)) return;

    const data = JSON.parse(fs.readFileSync(osakaPath, 'utf8'));
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.$schema, 'https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json');
    assert.equal(data.meta.storagePrefix, undefined);
    assert.deepEqual(validate(data), { valid: true, errors: [] });
    assert.equal(data.items.filter((i) => !i.digitalOnly).length, 53);
    assert.equal(data.items.filter((i) => !!i.digitalOnly).length, 2);

    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(indexData.schemaVersion, 1);
    assert.ok(Array.isArray(indexData.catalogs));
    assert.ok(indexData.catalogs.some((c) => c.file === '2026-japan.json'));
  });
});

describe('deriveStoragePrefix uniqueness & determinism', () => {
  it('derives deterministic unique prefixes for distinct URLs, filenames, and inline catalogs', () => {
    const derive = getPrefixDeriver();
    const urlA = derive({ sourceUrl: 'https://raw.githubusercontent.com/alice/cds/main/japan.json', meta: { title: 'Japan CD Hunt' } });
    const urlB = derive({ sourceUrl: 'https://raw.githubusercontent.com/bob/cds/main/japan.json', meta: { title: 'Japan CD Hunt' } });
    const fileA = derive({ fileName: 'list-a.json', meta: { title: 'My Hunt' } });
    const fileB = derive({ fileName: 'list-b.json', meta: { title: 'My Hunt' } });
    const inlineA = derive({ meta: { title: 'Shared Title' }, items: [{ id: 'cd-01' }] });
    const inlineB = derive({ meta: { title: 'Shared Title' }, items: [{ id: 'cd-02' }] });

    assert.match(urlA, /^cd_hunt_[a-z0-9_]+_[0-9a-f]{8}$/);
    assert.equal(urlA, derive({ sourceUrl: 'https://raw.githubusercontent.com/alice/cds/main/japan.json', meta: { title: 'Japan CD Hunt' } }));
    assert.notEqual(urlA, urlB);
    assert.notEqual(fileA, fileB);
    assert.notEqual(inlineA, inlineB);
  });
});

describe('normalizeCatalogUrl helper', () => {
  it('converts GitHub blob URLs to raw.githubusercontent.com URLs', () => {
    const normalize = getNormalizer();
    assert.equal(
      normalize('  https://github.com/dopingus-build/cd-metadata/blob/main/2026-japan.json  '),
      'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json'
    );
  });

  it('strips query/hash fragments when converting GitHub blob or raw URLs', () => {
    const normalize = getNormalizer();
    assert.equal(
      normalize('https://github.com/owner/repo/blob/main/nested/list.json?plain=1#L1'),
      'https://raw.githubusercontent.com/owner/repo/main/nested/list.json'
    );
    assert.equal(
      normalize('https://github.com/owner/repo/raw/main/list.json'),
      'https://raw.githubusercontent.com/owner/repo/main/list.json'
    );
  });

  it('converts bare GitHub repository and branch tree URLs to raw index.json URLs', () => {
    const normalize = getNormalizer();
    assert.equal(
      normalize('https://github.com/owner/cd-metadata'),
      'https://raw.githubusercontent.com/owner/cd-metadata/main/index.json'
    );
    assert.equal(
      normalize('https://github.com/owner/cd-metadata/'),
      'https://raw.githubusercontent.com/owner/cd-metadata/main/index.json'
    );
    assert.equal(
      normalize('https://github.com/owner/cd-metadata.git?tab=readme-ov-file#readme'),
      'https://raw.githubusercontent.com/owner/cd-metadata/main/index.json'
    );
    assert.equal(
      normalize('https://github.com/owner/cd-metadata/tree/dev'),
      'https://raw.githubusercontent.com/owner/cd-metadata/dev/index.json'
    );
    assert.equal(
      normalize('https://github.com/owner/cd-metadata/tree/feature/v2/'),
      'https://raw.githubusercontent.com/owner/cd-metadata/feature/v2/index.json'
    );
  });

  it('preserves already-raw and arbitrary JSON URLs and handles empty input', () => {
    const normalize = getNormalizer();
    const rawUrl = 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json';
    assert.equal(normalize(rawUrl), rawUrl);
    assert.equal(normalize('https://example.com/catalog.json'), 'https://example.com/catalog.json');
    assert.equal(normalize(''), '');
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
  });
});

describe('Top-level structure validation', () => {
  for (const [label, invalidRoot] of [
    ['null', null],
    ['undefined', undefined],
    ['string', 'catalog'],
    ['number', 42],
    ['boolean', true],
    ['array', []]
  ]) {
    it(`rejects root catalog of type ${label}`, () => {
      const validate = getValidator();
      const result = validate(invalidRoot);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  }

  it('rejects missing items property', () => {
    const validate = getValidator();
    const catalog = makeValidCatalog();
    delete catalog.items;
    const result = validate(catalog);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects non-array items property', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: {} }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects empty items array', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('accepts a complete valid catalog', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog());
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it('accepts a valid catalog when optional $schema, meta, and categories are omitted', () => {
    const validate = getValidator();
    const result = validate({ schemaVersion: 1, items: [makeValidItem()] });
    assert.deepEqual(result, { valid: true, errors: [] });
  });
});

describe('schemaVersion and $schema validation', () => {
  it('rejects missing schemaVersion', () => {
    const validate = getValidator();
    const catalog = makeValidCatalog();
    delete catalog.schemaVersion;
    const result = validate(catalog);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
  });

  for (const [label, badVer] of [
    ['string', '1'],
    ['float', 1.5],
    ['null', null],
    ['unsupported version 2', 2],
    ['unsupported version 0', 0]
  ]) {
    it(`rejects invalid schemaVersion (${label})`, () => {
      const validate = getValidator();
      const result = validate(makeValidCatalog({ schemaVersion: badVer }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
    });
  }

  for (const [label, badSchema] of [
    ['empty string', '   '],
    ['number', 123]
  ]) {
    it(`rejects invalid $schema (${label})`, () => {
      const validate = getValidator();
      const result = validate(makeValidCatalog({ $schema: badSchema }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('$schema')));
    });
  }
});

describe('meta object validation', () => {
  for (const [label, invalidMeta] of [
    ['array', []],
    ['string', 'meta'],
    ['null', null]
  ]) {
    it(`rejects non-object meta (${label})`, () => {
      const validate = getValidator();
      const result = validate(makeValidCatalog({ meta: invalidMeta }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  }

  for (const field of [
    'title',
    'subtitle',
    'documentTitle',
    'searchPlaceholder',
    'digitalSectionTitle',
    'digitalSectionSubtitle',
    'googleSheetUrl'
  ]) {
    it(`rejects non-string meta.${field}`, () => {
      const validate = getValidator();
      const catalog = makeValidCatalog();
      catalog.meta[field] = 123;
      const result = validate(catalog);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });
  }

  it('rejects deprecated meta.storagePrefix', () => {
    const validate = getValidator();
    const catalog = makeValidCatalog();
    catalog.meta.storagePrefix = 'custom_prefix';
    const result = validate(catalog);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('storagePrefix')));
  });
});

describe('categories array validation', () => {
  it('rejects non-array categories', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ categories: {} }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects non-object category entries', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ categories: ['All'] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  for (const field of ['key', 'label', 'dot']) {
    it(`rejects category missing required string ${field}`, () => {
      const validate = getValidator();
      const categories = [
        { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
        { key: 'Anime Themes & Chara', label: 'Anime Themes & Chara', dot: '#f43f5e' }
      ];
      delete categories[1][field];
      const result = validate(makeValidCatalog({ categories }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });

    it(`rejects category with empty string ${field}`, () => {
      const validate = getValidator();
      const categories = [
        { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
        { key: 'Anime Themes & Chara', label: 'Anime Themes & Chara', dot: '#f43f5e' }
      ];
      categories[1][field] = '   ';
      const result = validate(makeValidCatalog({ categories }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });
  }

  it('rejects duplicate category keys', () => {
    const validate = getValidator();
    const categories = [
      { key: 'All', label: 'All Releases', dot: '#a1a1aa' },
      { key: 'Anime Themes & Chara', label: 'Anime 1', dot: '#f43f5e' },
      { key: 'Anime Themes & Chara', label: 'Anime 2', dot: '#e11d48' }
    ];
    const result = validate(makeValidCatalog({ categories }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('duplicate')));
  });

  it('rejects non-empty categories omitting the "All" key', () => {
    const validate = getValidator();
    const categories = [
      { key: 'Anime Themes & Chara', label: 'Anime Themes & Chara', dot: '#f43f5e' }
    ];
    const result = validate(makeValidCatalog({ categories }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('All')));
  });

  it('accepts an empty categories array for auto-derivation', () => {
    const validate = getValidator();
    assert.deepEqual(validate(makeValidCatalog({ categories: [] })), { valid: true, errors: [] });
  });

  it('rejects item whose category is not in provided non-empty categories', () => {
    const validate = getValidator();
    const result = validate(
      makeValidCatalog({
        items: [makeValidItem({ category: 'Unknown Category' })]
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Unknown Category') || e.includes('category')));
  });
});

describe('items required fields and ID uniqueness', () => {
  it('rejects non-object item entries', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: ['not-an-object'] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  for (const field of ['id', 'category', 'artist', 'title', 'catalog', 'kana', 'filing']) {
    it(`rejects item missing required field ${field}`, () => {
      const validate = getValidator();
      const item = makeValidItem();
      delete item[field];
      const result = validate(makeValidCatalog({ items: [item] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });

    it(`rejects item with empty/whitespace-only ${field}`, () => {
      const validate = getValidator();
      const item = makeValidItem({ [field]: '   ' });
      const result = validate(makeValidCatalog({ items: [item] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });
  }

  for (const badId of ['cd 01', 'cd/01', 'cd.01', 'cd:01']) {
    it(`rejects invalid id characters (${JSON.stringify(badId)})`, () => {
      const validate = getValidator();
      const result = validate(makeValidCatalog({ items: [makeValidItem({ id: badId })] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('id')));
    });
  }

  it('rejects duplicate item IDs', () => {
    const validate = getValidator();
    const result = validate(
      makeValidCatalog({
        items: [makeValidItem({ id: 'cd-01' }), makeValidItem({ id: 'cd-01', title: 'Another' })]
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('duplicate')));
  });

  it('rejects missing price', () => {
    const validate = getValidator();
    const item = makeValidItem();
    delete item.price;
    const result = validate(makeValidCatalog({ items: [item] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('price')));
  });

  it('rejects non-string price', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: [makeValidItem({ price: 500 })] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('price')));
  });

  it('accepts empty string price "" so price.split("(") remains safe', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: [makeValidItem({ price: '' })] }));
    assert.deepEqual(result, { valid: true, errors: [] });
  });
});

describe('items optional fields and cover resolution rules', () => {
  it('rejects non-boolean digitalOnly', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: [makeValidItem({ digitalOnly: 'true' })] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('digitalOnly')));
  });

  for (const field of ['artistJa', 'titleJa', 'regCatNo', 'itunesQuery', 'accent']) {
    it(`rejects non-string optional field ${field}`, () => {
      const validate = getValidator();
      const result = validate(makeValidCatalog({ items: [makeValidItem({ [field]: 999 })] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(field)));
    });
  }

  it('rejects non-array mbEditions', () => {
    const validate = getValidator();
    const result = validate(makeValidCatalog({ items: [makeValidItem({ mbEditions: 'ABCD-1001' })] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('mbEditions')));
  });

  it('rejects mbEditions entries missing non-empty catno', () => {
    const validate = getValidator();
    const result = validate(
      makeValidCatalog({
        items: [makeValidItem({ mbEditions: [{ catno: '  ', label: '通常盤 Regular' }] })]
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('catno')));
  });

  it('rejects mbEditions entries with non-string label', () => {
    const validate = getValidator();
    const result = validate(
      makeValidCatalog({
        items: [makeValidItem({ mbEditions: [{ catno: 'ABCD-1001', label: 123 }] })]
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('label')));
  });

  it('rejects non-empty itunesQuery when requiredGroups is missing', () => {
    const validate = getValidator();
    const item = makeValidItem({ itunesQuery: 'Some Album' });
    delete item.requiredGroups;
    const result = validate(makeValidCatalog({ items: [item] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requiredGroups')));
  });

  it('rejects non-empty itunesQuery when requiredGroups is empty', () => {
    const validate = getValidator();
    const result = validate(
      makeValidCatalog({
        items: [makeValidItem({ itunesQuery: 'Some Album', requiredGroups: [] })]
      })
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requiredGroups')));
  });

  for (const [label, badGroups] of [
    ['non-array', 'example'],
    ['empty outer array', []],
    ['non-array inner group', ['example']],
    ['empty inner group', [[]]],
    ['non-string keyword', [[123]]],
    ['empty string keyword', [['  ']]]
  ]) {
    it(`rejects malformed requiredGroups (${label})`, () => {
      const validate = getValidator();
      const result = validate(
        makeValidCatalog({
          items: [makeValidItem({ requiredGroups: badGroups })]
        })
      );
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('requiredGroups')));
    });
  }

  for (const domain of ['vgmdb.net', 'wikia.nocookie.net', 'fandom.com', 'cdjapan.co.jp']) {
    it(`rejects prohibited hotlinked domain (${domain}) in item fields`, () => {
      const validate = getValidator();
      const result = validate(
        makeValidCatalog({
          items: [makeValidItem({ filing: `https://${domain}/cover.jpg` })]
        })
      );
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes(domain)));
    });
  }

  it('rejects non-object entries inside mbEditions', () => {
    const validate = getValidator();
    const resultNull = validate(
      makeValidCatalog({
        items: [makeValidItem({ mbEditions: [null] })]
      })
    );
    assert.equal(resultNull.valid, false);
    assert.ok(resultNull.errors.includes('items[0].mbEditions[0] must be an object'));

    const resultStr = validate(
      makeValidCatalog({
        items: [makeValidItem({ mbEditions: ['ABCD-1001'] })]
      })
    );
    assert.equal(resultStr.valid, false);
    assert.ok(resultStr.errors.includes('items[0].mbEditions[0] must be an object'));
  });
});

function withMockBrowserGlobals(overrides, fn) {
  const saved = {
    hasWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    window: globalThis.window,
    hasImage: Object.prototype.hasOwnProperty.call(globalThis, 'Image'),
    Image: globalThis.Image,
    hasFetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch'),
    fetch: globalThis.fetch,
    hasSetTimeout: Object.prototype.hasOwnProperty.call(globalThis, 'setTimeout'),
    setTimeout: globalThis.setTimeout
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete globalThis[k];
    } else {
      globalThis[k] = v;
    }
  }
  const restore = () => {
    for (const key of ['window', 'Image', 'fetch', 'setTimeout']) {
      const flag = 'has' + key.charAt(0).toUpperCase() + key.slice(1);
      if (saved[flag]) {
        globalThis[key] = saved[key];
      } else {
        delete globalThis[key];
      }
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

describe('Storage module unit tests (js/storage.js)', () => {
  it('handles string, empty/undefined, non-alphanumeric title, and sparse item contexts in deriveStoragePrefix', () => {
    assert.ifError(loadError);
    const strPrefix = storageModule.deriveStoragePrefix('  My Custom Slug  ');
    assert.match(strPrefix, /^cd_hunt_my_custom_slug_[0-9a-f]{8}$/);

    const emptyPrefix = storageModule.deriveStoragePrefix();
    const emptyObjPrefix = storageModule.deriveStoragePrefix({});
    assert.match(emptyPrefix, /^cd_hunt_catalog_[0-9a-f]{8}$/);
    assert.match(emptyObjPrefix, /^cd_hunt_catalog_[0-9a-f]{8}$/);
    assert.notEqual(emptyPrefix, emptyObjPrefix);
    assert.equal(emptyPrefix, storageModule.deriveStoragePrefix(null));

    const jpOnlyTitlePrefix = storageModule.deriveStoragePrefix({
      meta: { title: '日本語コレクション' },
      items: [null, { id: 'cd-01' }, {}]
    });
    assert.match(jpOnlyTitlePrefix, /^cd_hunt_catalog_[0-9a-f]{8}$/);
  });

  it('derives all expected localStorage key names via getStorageKeys', () => {
    const keys = storageModule.getStorageKeys({ fileName: 'tokyo.json', meta: { title: 'Tokyo Hunt' } });
    assert.match(keys.prefix, /^cd_hunt_tokyo_hunt_[0-9a-f]{8}$/);
    assert.equal(keys.checklistKey, keys.prefix + '_checklist_v2');
    assert.equal(keys.coverCacheKey, keys.prefix + '_cover_cache_v6');
    assert.equal(keys.viewModeKey, keys.prefix + '_view_mode_v1');
    assert.equal(keys.noteDismissedKey, keys.prefix + '_note_dismissed_v1');
  });

  it('supports working window.localStorage and active catalog URL helpers', () => {
    const store = new Map();
    const mockLocalStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    };

    withMockBrowserGlobals({ window: { localStorage: mockLocalStorage } }, () => {
      storageModule.safeSetItem('test_k', 'val_1');
      assert.equal(storageModule.safeGetItem('test_k'), 'val_1');
      storageModule.safeRemoveItem('test_k');
      assert.equal(storageModule.safeGetItem('test_k'), null);

      storageModule.setActiveCatalogUrl('   ');
      assert.equal(storageModule.getActiveCatalogUrl(), null);
      storageModule.setActiveCatalogUrl('  https://example.com/list.json  ');
      assert.equal(storageModule.getActiveCatalogUrl(), 'https://example.com/list.json');
      storageModule.clearActiveCatalogUrl();
      assert.equal(storageModule.getActiveCatalogUrl(), null);

      const ctx = { fileName: 'purge-test.json' };
      const prefix = storageModule.deriveStoragePrefix(ctx);
      ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'].forEach((v) => {
        store.set(prefix + '_cover_cache_' + v, '{}');
      });
      storageModule.purgeLegacyCoverCaches(ctx);
      ['v1', 'v2', 'v3', 'v4', 'v5'].forEach((v) => {
        assert.equal(store.has(prefix + '_cover_cache_' + v), false);
      });
      assert.equal(store.has(prefix + '_cover_cache_v6'), true);
    });
  });

  it('falls back to in-memory store when window.localStorage throws SecurityError', () => {
    const throwingStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      }
    };

    withMockBrowserGlobals({ window: { localStorage: throwingStorage } }, () => {
      assert.equal(storageModule.safeGetItem('never_set_key'), null);
      storageModule.safeSetItem('mem_only_key', 'fallback_val');
      assert.equal(storageModule.safeGetItem('mem_only_key'), 'fallback_val');
      storageModule.safeRemoveItem('mem_only_key');
      assert.equal(storageModule.safeGetItem('mem_only_key'), null);
    });
  });
});

describe('Cover resolver unit tests (js/cover-resolver.js)', () => {
  it('escapes HTML and attribute strings safely', () => {
    assert.ifError(loadError);
    assert.equal(coverResolverModule.escapeHTML('A & <"B">'), 'A &amp; &lt;&quot;B&quot;&gt;');
    assert.equal(coverResolverModule.escapeHTML(null), '');
    assert.equal(coverResolverModule.escapeAttr(`"a' & 'b"`), '&quot;a&#39; &amp; &#39;b&quot;');
    assert.equal(coverResolverModule.escapeAttr(undefined), '');
  });

  it('generates SVG jewel-case data URIs for physical, digital, and minimal fallback items', () => {
    const uri = coverResolverModule.buildJewelCaseDataURI({
      accent: '#3b82f6',
      regCatNo: 'SRCL-12539 (通常盤)',
      artistJa: 'VeryLongJapaneseArtistNameThatExceeds22Chars',
      titleJa: 'VeryLongJapaneseReleaseTitleExceeding24Chars',
      kana: 'ヤ / Y',
      price: '¥500–¥900',
      digitalOnly: false
    });
    assert.ok(uri.startsWith('data:image/svg+xml;charset=UTF-8,'));
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;charset=UTF-8,'.length));
    assert.ok(svg.includes('#3b82f6'));
    assert.ok(svg.includes('SRCL-12539'));
    assert.ok(svg.includes('通常盤'));
    assert.ok(svg.includes('VeryLongJapaneseArtist'));
    assert.equal(svg.includes('VeryLongJapaneseArtistName'), false);

    const digUri = coverResolverModule.buildJewelCaseDataURI({
      artist: 'Artist & <Co>',
      title: 'Digital Track',
      digitalOnly: true
    });
    const digSvg = decodeURIComponent(digUri.slice('data:image/svg+xml;charset=UTF-8,'.length));
    assert.ok(digSvg.includes('#e11d48'));
    assert.ok(digSvg.includes('>N<'));
    assert.ok(digSvg.includes('配信限定'));
    assert.ok(digSvg.includes('Artist &amp; &lt;Co&gt;'));

    const blankUri = coverResolverModule.buildJewelCaseDataURI({});
    assert.ok(blankUri.startsWith('data:image/svg+xml;charset=UTF-8,'));
  });

  it('classifies iTunes edition strings with Regular priority', () => {
    assert.deepEqual(coverResolverModule.classifyItunesEdition('Any Album', true), {
      label: '配信 Digital',
      isRegular: true,
      score: 100
    });
    assert.equal(coverResolverModule.classifyItunesEdition('Title (通常盤)', false).score, 120);
    assert.equal(coverResolverModule.classifyItunesEdition('Title - Regular Edition', false).score, 120);
    assert.equal(coverResolverModule.classifyItunesEdition('Title Standard', false).score, 120);
    assert.equal(coverResolverModule.classifyItunesEdition('Plain Album Title', false).score, 100);
    assert.deepEqual(coverResolverModule.classifyItunesEdition('Title (期間生産限定盤)', false), {
      label: 'アニメ盤 Anime',
      isRegular: false,
      score: 50
    });
    assert.equal(coverResolverModule.classifyItunesEdition('Title Anime Ver.', false).score, 50);
    assert.deepEqual(coverResolverModule.classifyItunesEdition('Title (初回生産限定盤 DVD付)', false), {
      label: '初回盤 Limited',
      isRegular: false,
      score: 40
    });
    assert.equal(coverResolverModule.classifyItunesEdition('Title Deluxe', false).score, 40);
    assert.equal(coverResolverModule.classifyItunesEdition("Collector's Edition", false).score, 80);
  });

  it('verifies image dimensions, errors, missing Image constructor, and timeouts in verifyImageLoad', async () => {
    const missing = await withMockBrowserGlobals({ Image: undefined }, () =>
      coverResolverModule.verifyImageLoad('https://example.com/a.jpg')
    );
    assert.equal(missing, false);

    class GoodImage {
      set src(_val) {
        this.naturalWidth = 500;
        this.naturalHeight = 500;
        if (this.onload) this.onload();
      }
    }
    const ok = await withMockBrowserGlobals({ Image: GoodImage }, () =>
      coverResolverModule.verifyImageLoad('https://example.com/good.jpg')
    );
    assert.equal(ok, true);

    class TinyImage {
      set src(_val) {
        this.naturalWidth = 40;
        this.naturalHeight = 500;
        if (this.onload) this.onload();
      }
    }
    const tooSmall = await withMockBrowserGlobals({ Image: TinyImage }, () =>
      coverResolverModule.verifyImageLoad('https://example.com/tiny.jpg')
    );
    assert.equal(tooSmall, false);

    class ErrorImage {
      set src(_val) {
        if (this.onerror) this.onerror();
      }
    }
    const errored = await withMockBrowserGlobals({ Image: ErrorImage }, () =>
      coverResolverModule.verifyImageLoad('https://example.com/err.jpg')
    );
    assert.equal(errored, false);

    class HangingImage {
      set src(_val) {}
    }
    const timedOut = await withMockBrowserGlobals(
      {
        Image: HangingImage,
        setTimeout: (cb) => {
          cb();
          return 1;
        }
      },
      () => coverResolverModule.verifyImageLoad('https://example.com/hang.jpg')
    );
    assert.equal(timedOut, false);
  });

  it('resolves and deduplicates MusicBrainz Cover Art Archive variants while tolerating errors', async () => {
    const noFetch = await withMockBrowserGlobals({ fetch: undefined }, () =>
      coverResolverModule.tryMusicBrainzCovers({ mbEditions: [{ catno: 'A-1', label: 'Reg' }] })
    );
    assert.deepEqual(noFetch, []);

    const requestedUrls = [];
    class SelectableImage {
      set src(url) {
        if (url.includes('rel-fail')) {
          this.naturalWidth = 0;
          this.naturalHeight = 0;
          if (this.onerror) this.onerror();
          return;
        }
        this.naturalWidth = 500;
        this.naturalHeight = 500;
        if (this.onload) this.onload();
      }
    }

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.includes('catno:THROW')) throw new Error('network error');
      if (url.includes('catno:HTTP500')) return { ok: false, status: 500 };
      if (url.includes('catno:SRCL-1')) {
        return {
          ok: true,
          async json() {
            return {
              releases: [null, { id: 'rel-fail' }, { id: 'rel-reg' }, { id: 'rel-extra' }]
            };
          }
        };
      }
      if (url.includes('catno:SRCL-REG')) {
        return {
          ok: true,
          async json() {
            return {
              releases: [{ id: 'rel-by-regcat', title: 'Reg' }]
            };
          }
        };
      }
      if (url.includes('catno:SRCL-2')) {
        return {
          ok: true,
          async json() {
            return {
              releases: [{ id: 'rel-reg' }, { id: 'rel-ltd' }]
            };
          }
        };
      }
      return { ok: true, async json() { return {}; } };
    };

    const variants = await withMockBrowserGlobals({ fetch: mockFetch, Image: SelectableImage }, () =>
      coverResolverModule.tryMusicBrainzCovers({
        regCatNo: 'SRCL-REG',
        mbEditions: [
          null,
          { catno: '' },
          { catno: 'THROW', label: 'Throw' },
          { catno: 'HTTP500', label: 'Fail' },
          { catno: 'SRCL-1' },
          { catno: 'SRCL-REG', label: 'Standard Disc' },
          { catno: 'SRCL-2', label: '通常盤 Regular' }
        ]
      })
    );

    assert.equal(requestedUrls.some((u) => u.includes('SRCL-1')), true);
    assert.deepEqual(variants, [
      {
        url: 'https://coverartarchive.org/release/rel-reg/front-500',
        label: '通常盤 Regular',
        catNo: 'SRCL-1',
        source: 'musicbrainz',
        isRegular: false
      },
      {
        url: 'https://coverartarchive.org/release/rel-by-regcat/front-500',
        label: 'Standard Disc',
        catNo: 'SRCL-REG',
        source: 'musicbrainz',
        isRegular: true
      },
      {
        url: 'https://coverartarchive.org/release/rel-ltd/front-500',
        label: '通常盤 Regular',
        catNo: 'SRCL-2',
        source: 'musicbrainz',
        isRegular: true
      }
    ]);
  });

  it('resolves, validates with requiredGroups, caps at 6, and sorts Apple iTunes covers', async () => {
    const emptyNoQuery = await withMockBrowserGlobals({ fetch: async () => ({}) }, () =>
      coverResolverModule.tryItunesCovers({ id: 'x' })
    );
    assert.deepEqual(emptyNoQuery, []);

    const emptyNoFetch = await withMockBrowserGlobals({ fetch: undefined }, () =>
      coverResolverModule.tryItunesCovers({ itunesQuery: 'test' })
    );
    assert.deepEqual(emptyNoFetch, []);

    class MockArtImage {
      set src(url) {
        if (url.includes('broken')) {
          if (this.onerror) this.onerror();
          return;
        }
        this.naturalWidth = 600;
        this.naturalHeight = 600;
        if (this.onload) this.onload();
      }
    }

    const queriedUrls = [];
    const mockFetch = async (url) => {
      queriedUrls.push(url);
      if (url.includes('country=jp') && url.includes('entity=album')) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                { trackName: 'Unrelated', collectionName: 'Other', artistName: 'Nobody', artworkUrl100: 'https://ex.com/0/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash (初回限定盤)', artistName: 'yama', artworkUrl100: 'https://ex.com/1/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash (通常盤)', artistName: 'yama', artworkUrl100: 'https://ex.com/2/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash (通常盤)', artistName: 'yama', artworkUrl100: 'https://ex.com/2/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash (Broken)', artistName: 'yama', artworkUrl100: 'https://ex.com/broken/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash (アニメ盤)', artistName: 'yama', artworkUrl100: 'https://ex.com/3/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash', artistName: 'yama', artworkUrl100: 'https://ex.com/4/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash Standard', artistName: 'yama', artworkUrl100: 'https://ex.com/5/100x100bb.jpg' }
              ]
            };
          }
        };
      }
      if (url.includes('country=us') && url.includes('entity=album')) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                { trackName: 'slash', collectionName: 'slash Regular', artistName: 'yama', artworkUrl100: 'https://ex.com/6/100x100bb.jpg' },
                { trackName: 'slash', collectionName: 'slash Extra', artistName: 'yama', artworkUrl100: 'https://ex.com/7/100x100bb.jpg' }
              ]
            };
          }
        };
      }
      return { ok: false, status: 500 };
    };

    const physicalResults = await withMockBrowserGlobals({ fetch: mockFetch, Image: MockArtImage }, () =>
      coverResolverModule.tryItunesCovers({
        regCatNo: 'SRCL-12539',
        itunesQuery: 'slash yama',
        requiredGroups: [['slash'], ['yama']]
      })
    );

    assert.equal(physicalResults.length, 6);
    assert.equal(physicalResults[0].url, 'https://ex.com/2/600x600bb.jpg');
    assert.equal(physicalResults[0].source, 'itunes-jp');
    assert.equal(physicalResults[0].catNo, 'SRCL-12539');
    assert.equal(physicalResults[0].isRegular, true);
    assert.equal(Object.prototype.hasOwnProperty.call(physicalResults[0], 'score'), false);
    assert.equal(physicalResults[physicalResults.length - 1].label, '初回盤 Limited');
    assert.equal(physicalResults[physicalResults.length - 1].catNo, '');

    const digitalFetch = async (url) => {
      if (url.includes('entity=song') && url.includes('country=jp')) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                { trackName: 'DigSong', collectionName: 'DigSingle', artistName: 'DigArtist', artworkUrl100: 'https://ex.com/dig/100x100bb.jpg' }
              ]
            };
          }
        };
      }
      throw new Error('skip');
    };
    const digitalResults = await withMockBrowserGlobals({ fetch: digitalFetch, Image: MockArtImage }, () =>
      coverResolverModule.tryItunesCovers({
        digitalOnly: true,
        itunesQuery: 'DigSong DigArtist',
        requiredGroups: [['digsong'], ['digartist']]
      })
    );

    assert.deepEqual(digitalResults, [
      {
        url: 'https://ex.com/dig/600x600bb.jpg',
        label: '配信 Digital',
        catNo: '',
        source: 'itunes-jp',
        isRegular: true
      }
    ]);
  });
});

const configModule = require('../js/config.js');
const syncModule = require('../js/sync.js');

function encodeTestJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.fakesig`;
}

describe('Cloud sync config and frontend sync module (js/config.js & js/sync.js)', () => {
  it('exposes the deployed Cloudflare Worker URL in js/config.js', () => {
    assert.equal(configModule.syncApiUrl, 'https://cd-hunt-sync.tndo.workers.dev');
  });

  it('resolves syncApiUrl safely with loopback-only dev overrides', () => {
    const store = new Map();
    const mockStorage = {
      safeGetItem: (k) => (store.has(k) ? store.get(k) : null),
      safeSetItem: (k, v) => store.set(k, String(v)),
      safeRemoveItem: (k) => store.delete(k)
    };

    assert.equal(
      syncModule.resolveSyncApiUrl({ search: '' }, mockStorage, { syncApiUrl: 'https://worker.example/' }),
      'https://worker.example'
    );
    assert.equal(
      syncModule.resolveSyncApiUrl({ search: '' }, mockStorage, { syncApiUrl: 'javascript:alert(1)' }),
      ''
    );

    // Rejects non-loopback ?syncApi= overrides to protect JWTs
    assert.equal(
      syncModule.resolveSyncApiUrl(
        { search: '?syncApi=https://evil.example' },
        mockStorage,
        { syncApiUrl: 'https://worker.example' }
      ),
      'https://worker.example'
    );
    assert.equal(store.has(syncModule.SYNC_API_OVERRIDE_KEY), false);

    // Allows loopback override and remembers it until reset
    assert.equal(
      syncModule.resolveSyncApiUrl(
        { search: '?syncApi=' + encodeURIComponent('http://127.0.0.1:8787/') },
        mockStorage,
        { syncApiUrl: 'https://worker.example' }
      ),
      'http://127.0.0.1:8787'
    );
    assert.equal(
      syncModule.resolveSyncApiUrl({ search: '' }, mockStorage, { syncApiUrl: 'https://worker.example' }),
      'http://127.0.0.1:8787'
    );
    assert.equal(
      syncModule.resolveSyncApiUrl({ search: '?syncApi=off' }, mockStorage, { syncApiUrl: 'https://worker.example' }),
      'https://worker.example'
    );
  });

  it('parses session JWT payloads, captures #auth_token from hash, and manages session lifecycle', () => {
    const nowMs = Date.UTC(2026, 10, 21, 12, 0, 0);
    const futureExp = Math.floor(nowMs / 1000) + 3600;
    const validJwt = encodeTestJwt({ purpose: 'session', sub: '123', login: 'alice', avatarUrl: 'https://a/1.png', exp: futureExp });
    const expiredJwt = encodeTestJwt({ purpose: 'session', sub: '123', login: 'alice', exp: Math.floor(nowMs / 1000) - 10 });
    const wrongPurposeJwt = encodeTestJwt({ purpose: 'oauth_state', sub: '123', login: 'alice', exp: futureExp });

    assert.deepEqual(syncModule.parseJwtPayload(validJwt, nowMs), {
      sub: '123',
      login: 'alice',
      avatarUrl: 'https://a/1.png',
      exp: futureExp
    });
    assert.equal(syncModule.parseJwtPayload(expiredJwt, nowMs), null);
    assert.equal(syncModule.parseJwtPayload(wrongPurposeJwt, nowMs), null);
    assert.equal(syncModule.parseJwtPayload('not.a.valid!base64', nowMs), null);
    assert.equal(syncModule.parseJwtPayload(null, nowMs), null);

    const store = new Map();
    const mockStorage = {
      safeGetItem: (k) => (store.has(k) ? store.get(k) : null),
      safeSetItem: (k, v) => store.set(k, String(v)),
      safeRemoveItem: (k) => store.delete(k)
    };
    const historyCalls = [];
    const loc = { hash: `#auth_token=${validJwt}`, pathname: '/disk-crate/', search: '?catalog=x', origin: 'https://dopingus-build.github.io' };
    const hist = {
      replaceState: (_s, _t, u) => historyCalls.push(u)
    };

    const captured = syncModule.captureAuthTokenFromHash(loc, hist, mockStorage, nowMs);
    assert.equal(captured.user.login, 'alice');
    assert.equal(historyCalls[0], '/disk-crate/?catalog=x');
    assert.equal(loc.hash, '');
    assert.equal(syncModule.getAuthSession(mockStorage, nowMs).token, validJwt);

    syncModule.clearAuthSession(mockStorage);
    assert.equal(syncModule.getAuthSession(mockStorage, nowMs), null);

    // Expired stored token auto-clears
    store.set(syncModule.SYNC_TOKEN_KEY, expiredJwt);
    assert.equal(syncModule.getAuthSession(mockStorage, nowMs), null);
    assert.equal(store.has(syncModule.SYNC_TOKEN_KEY), false);

    assert.equal(
      syncModule.buildLoginUrl('https://cd-hunt-sync.tndo.workers.dev/', loc),
      'https://cd-hunt-sync.tndo.workers.dev/auth/login?redirect=' + encodeURIComponent('https://dopingus-build.github.io/disk-crate/?catalog=x')
    );
    assert.equal(syncModule.buildLoginUrl('', loc), '');
  });

  it('extracts custom covers only, merges checklists/covers/viewMode, and builds/applies synced state', () => {
    const cache = {
      'cd-01': {
        selectedIndex: 1,
        variants: [
          { url: 'https://coverartarchive.org/release/r1/front-500', label: '通常盤', source: 'musicbrainz', isRegular: true },
          { url: 'https://custom.example/c1.jpg', label: 'Custom Regular', source: 'custom', isRegular: true }
        ]
      },
      'cd-02': {
        selectedIndex: 0,
        variants: [{ url: 'https://itunes.example/i1.jpg', label: '通常盤', source: 'itunes-jp', isRegular: true }]
      }
    };

    const extracted = syncModule.extractCustomCovers(cache);
    assert.deepEqual(extracted.customCovers, {
      'cd-01': {
        selectedIndex: 0,
        variants: [{ url: 'https://custom.example/c1.jpg', label: 'Custom Regular', catNo: '', source: 'custom', isRegular: true }]
      }
    });
    assert.equal(extracted.selectedVariants['cd-02'].url, 'https://itunes.example/i1.jpg');

    // Merge without local updatedAt baseline unions local & cloud checkmarks so pre-login checkmarks survive
    const mergedFirstSync = syncModule.mergeCatalogState(
      { updatedAt: 0, checklist: { 'cd-01': true }, customCovers: {}, viewMode: 'grid', noteDismissed: false },
      { updatedAt: 500, checklist: { 'cd-02': true }, customCovers: extracted.customCovers, viewMode: 'single', noteDismissed: true }
    );
    assert.deepEqual(mergedFirstSync.checklist, { 'cd-01': true, 'cd-02': true });
    assert.equal(mergedFirstSync.viewMode, 'single');
    assert.equal(mergedFirstSync.noteDismissed, true);

    // Newer local timestamp preserves explicit local uncheck
    const mergedNewerLocal = syncModule.mergeCatalogState(
      { updatedAt: 900, checklist: { 'cd-01': true }, customCovers: {}, viewMode: 'grid', noteDismissed: false },
      { updatedAt: 500, checklist: { 'cd-01': true, 'cd-02': true }, customCovers: {}, viewMode: 'single', noteDismissed: true }
    );
    assert.deepEqual(mergedNewerLocal.checklist, { 'cd-01': true });
    assert.equal(mergedNewerLocal.viewMode, 'grid');

    // Full buildLocalSyncPayload + mergeAndApplyCloudState round-trip
    const store = new Map();
    let activeCatalogUrl = null;
    const mockStorage = {
      safeGetItem: (k) => (store.has(k) ? store.get(k) : null),
      safeSetItem: (k, v) => store.set(k, String(v)),
      safeRemoveItem: (k) => store.delete(k),
      getActiveCatalogUrl: () => activeCatalogUrl,
      setActiveCatalogUrl: (u) => { activeCatalogUrl = u; }
    };

    const prefix = 'cd_hunt_sample_0123abcd';
    syncModule.markPrefixUpdated(mockStorage, prefix, 100);
    const localPayload = syncModule.buildLocalSyncPayload(
      mockStorage,
      null,
      prefix,
      { acquiredMap: { 'cd-01': true }, coverCache: cache, viewMode: 'grid' },
      200
    );
    assert.equal(localPayload.schemaVersion, 1);
    assert.deepEqual(localPayload.catalogs[prefix].checklist, { 'cd-01': true });
    assert.equal(localPayload.catalogs[prefix].customCovers['cd-02'], undefined);

    const cloudPayload = {
      schemaVersion: 1,
      updatedAt: 500,
      activeCatalogUrl: 'https://raw.githubusercontent.com/alice/cd-metadata/main/list.json',
      catalogs: {
        [prefix]: {
          updatedAt: 500,
          checklist: { 'cd-01': true, 'cd-02': true },
          customCovers: {},
          selectedVariants: {},
          viewMode: 'single',
          noteDismissed: true
        }
      }
    };
    const applied = syncModule.mergeAndApplyCloudState(mockStorage, localPayload, cloudPayload);
    assert.equal(activeCatalogUrl, 'https://raw.githubusercontent.com/alice/cd-metadata/main/list.json');
    assert.deepEqual(JSON.parse(store.get(prefix + '_checklist_v2')), { 'cd-01': true, 'cd-02': true });
    assert.equal(store.get(prefix + '_view_mode_v1'), 'single');
    assert.equal(store.get(prefix + '_note_dismissed_v1'), '1');
    assert.equal(applied.changedRemote, true);

    // Unbaselined device with no local edits reports updatedAt === 0 and triggers zero redundant startup backfill
    const freshStore = new Map();
    let freshActiveUrl = null;
    const freshStorage = {
      safeGetItem: (k) => (freshStore.has(k) ? freshStore.get(k) : null),
      safeSetItem: (k, v) => freshStore.set(k, String(v)),
      safeRemoveItem: (k) => freshStore.delete(k),
      getActiveCatalogUrl: () => freshActiveUrl,
      setActiveCatalogUrl: (u) => { freshActiveUrl = u; }
    };
    const freshLocal = syncModule.buildLocalSyncPayload(freshStorage, null, null, null, 999999);
    assert.equal(freshLocal.updatedAt, 0);
    const freshMerged = syncModule.mergeAndApplyCloudState(freshStorage, freshLocal, {
      schemaVersion: 1,
      updatedAt: 500,
      activeCatalogUrl: cloudPayload.activeCatalogUrl,
      catalogs: {}
    });
    assert.equal(freshMerged.changedRemote, false);
  });

  it('handles pullCloudState and pushCloudState responses across 200, 401, 413, 429, 503, and offline errors', async () => {
    const okPull = await syncModule.pullCloudState('https://sync.example', 'tok', async () => ({
      ok: true,
      status: 200,
      async json() { return { ok: true, user: { login: 'alice' }, state: { schemaVersion: 1, catalogs: {} }, updatedAt: 10 }; }
    }));
    assert.equal(okPull.ok, true);
    assert.equal(okPull.user.login, 'alice');

    assert.equal((await syncModule.pullCloudState('https://sync.example', 'tok', async () => ({ status: 401 }))).unauthorized, true);
    assert.equal(
      (
        await syncModule.pullCloudState('https://sync.example', 'tok', async () => ({
          ok: false,
          status: 503,
          async json() { return { paused: true, reason: 'daily_free_tier_limit_reached', resetsAt: '2026-11-22T00:00:00Z' }; }
        }))
      ).paused,
      true
    );
    assert.equal((await syncModule.pullCloudState('https://sync.example', 'tok', async () => { throw new Error('offline'); })).offline, true);

    assert.equal(
      (await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => ({ status: 200, ok: true, async json() { return { ok: true, updatedAt: 1 }; } }))).ok,
      true
    );
    assert.equal((await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => ({ status: 401 }))).unauthorized, true);
    assert.equal((await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => ({ status: 413 }))).payloadTooLarge, true);
    assert.equal(
      (
        await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => ({
          status: 429,
          ok: false,
          async json() { return { retryAfterSeconds: 42 }; }
        }))
      ).retryAfterSeconds,
      42
    );
    assert.equal(
      (
        await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => ({
          status: 503,
          ok: false,
          async json() { return { paused: true, resetsAt: '00:00 UTC' }; }
        }))
      ).paused,
      true
    );
    assert.equal((await syncModule.pushCloudState('https://sync.example', 'tok', {}, async () => { throw new Error('offline'); })).offline, true);
  });

  it('forwards keepalive option cleanly on pushCloudState and maintains Wrangler/config security hygiene', async () => {
    const capturedInits = [];
    const mockFetch = async (_url, init) => {
      capturedInits.push(init);
      return { status: 200, ok: true, async json() { return { ok: true, updatedAt: 10 }; } };
    };

    await syncModule.pushCloudState('https://sync.example', 'tok', { schemaVersion: 1 }, mockFetch);
    await syncModule.pushCloudState('https://sync.example', 'tok', { schemaVersion: 1 }, mockFetch, { keepalive: true });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      await syncModule.pushCloudState('https://sync.example', 'tok', { schemaVersion: 1 }, { keepalive: true });
      await syncModule.pushCloudState('https://sync.example', 'tok', { schemaVersion: 1 }, undefined, { keepalive: true });
    } finally {
      globalThis.fetch = prevFetch;
    }

    assert.equal(capturedInits[0].keepalive, undefined);
    assert.equal(capturedInits[1].keepalive, true);
    assert.equal(capturedInits[2].keepalive, true);
    assert.equal(capturedInits[3].keepalive, true);

    assert.ok(
      configModule.syncApiUrl === '' || configModule.syncApiUrl.startsWith('https://'),
      'config syncApiUrl must be empty or HTTPS'
    );

    const wranglerToml = fs.readFileSync(path.join(__dirname, '..', 'worker', 'wrangler.toml'), 'utf8');
    assert.equal(/GITHUB_CLIENT_SECRET|JWT_SECRET/.test(wranglerToml), false, 'Secrets must never live in wrangler.toml');
    assert.ok(wranglerToml.includes('ALLOWED_ORIGINS = "https://dopingus-build.github.io"'));
    assert.ok(wranglerToml.includes('PAUSE_SYNC = "false"'));
  });

  it('validates priority, recommendedShops, meta.googleSheetUrl, canonical Sheet template, and vendor-neutral agent skill/rules files', () => {
    const validate = getValidator();
    const validCatalog = makeValidCatalog({
      meta: {
        title: 'Sheet Linked Catalog',
        googleSheetUrl: 'https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/edit'
      },
      items: [
        makeValidItem({
          priority: 'High',
          recommendedShops: 'Mandarake Grandchaos, Suruga-ya'
        })
      ]
    });
    assert.deepEqual(validate(validCatalog), { valid: true, errors: [] });

    for (const field of ['priority', 'recommendedShops']) {
      const bad = makeValidCatalog({ items: [makeValidItem({ [field]: 42 })] });
      const res = validate(bad);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes(field)));
    }

    const expectedHeader =
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops';
    const csv = fs.readFileSync(path.join(__dirname, '..', 'docs', 'sample-catalog-sheet.csv'), 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    assert.ok(lines.includes(expectedHeader), 'sample-catalog-sheet.csv must include canonical 9-column header row');

    const skillMd = fs.readFileSync(path.join(__dirname, '..', '.agents', 'skills', 'disk-crate-catalog', 'SKILL.md'), 'utf8');
    assert.match(skillMd, /^---\r?\nname:\s*disk-crate-catalog\r?\ndescription:/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', '.agents', 'skills', 'cd-hunt-catalog')), false);
    assert.ok(skillMd.includes('AGENT_CATALOG_GUIDE.md'));

    assert.equal(fs.existsSync(path.join(__dirname, '..', 'GEMINI.md')), false, 'Vendor-specific GEMINI.md must be replaced by AGENTS.md');
    const agentsMd = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('docs/AGENT_CATALOG_GUIDE.md'));
    assert.ok(agentsMd.includes('docs/sample-catalog-sheet.csv'));
  });
});

describe('Google Sheet URL normalization & sheet-adapter CSV parsing/merging (js/validate.js & js/sheet-adapter.js)', () => {
  it('extracts Google Sheet ID + optional gid and normalizes Google Sheets URLs to CSV export', () => {
    const normalize = getNormalizer();
    assert.equal(typeof extractGoogleSheetId, 'function');

    assert.deepEqual(
      extractGoogleSheetId('https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/edit?usp=drivesdk'),
      { sheetId: '1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A', gid: null }
    );
    assert.deepEqual(
      extractGoogleSheetId('https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit#gid=42'),
      { sheetId: 'abc-123_XYZ', gid: '42' }
    );
    assert.deepEqual(
      extractGoogleSheetId('https://docs.google.com/spreadsheets/d/abc-123_XYZ/export?format=csv&gid=99'),
      { sheetId: 'abc-123_XYZ', gid: '99' }
    );
    assert.equal(extractGoogleSheetId('https://example.com/catalog.json'), null);
    assert.equal(extractGoogleSheetId(''), null);

    assert.equal(
      normalize('https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/edit?usp=drivesdk'),
      'https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/export?format=csv'
    );
    assert.equal(
      normalize('https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit#gid=42'),
      'https://docs.google.com/spreadsheets/d/abc-123_XYZ/export?format=csv&gid=42'
    );
  });

  it('parses RFC-4180 CSV with BOM, quoted commas/newlines, and escaped double quotes', () => {
    const rows = sheetAdapterModule.parseCsv(
      '\uFEFFA,B,C\r\nTRUE,"Quote ""here""","Line 1,\nLine 2"\r\n\r\nFALSE,Simple,Plain\n'
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], ['A', 'B', 'C']);
    assert.deepEqual(rows[1], ['TRUE', 'Quote "here"', 'Line 1,\nLine 2']);
    assert.deepEqual(rows[2], ['FALSE', 'Simple', 'Plain']);
    assert.deepEqual(sheetAdapterModule.parseCsv(''), []);
  });

  it('parses docs/sample-catalog-sheet.csv Dashboard Layout into a schema-valid catalog and checklists', () => {
    const validate = getValidator();
    const csvText = fs.readFileSync(path.join(__dirname, '..', 'docs', 'sample-catalog-sheet.csv'), 'utf8');
    const parsed = sheetAdapterModule.parseGoogleSheetCsv(csvText, {
      sourceUrl: 'https://docs.google.com/spreadsheets/d/template123/export?format=csv'
    });

    assert.deepEqual(validate(parsed.catalog), { valid: true, errors: [] });
    assert.equal(parsed.catalog.meta.title, 'Disk Crate Physical & Digital Release Checklist');
    assert.ok(parsed.catalog.meta.subtitle.includes('Canonical Google Sheet Template'));
    assert.equal(parsed.catalog.items.length, 4);

    const physical = parsed.catalog.items.filter((i) => !i.digitalOnly);
    const digital = parsed.catalog.items.filter((i) => !!i.digitalOnly);
    assert.equal(physical.length, 3);
    assert.equal(digital.length, 1);

    assert.equal(physical[0].regCatNo, 'CPCA-1004');
    assert.equal(physical[0].artist, 'Capcom');
    assert.equal(physical[0].artistJa, 'カプコン');
    assert.equal(physical[0].kana, 'ブ');
    assert.equal(physical[0].priority, 'High');
    assert.ok(physical[0].recommendedShops.includes('Mandarake'));

    // yama row prioritizes 通常盤 Regular (SRCL-12539) even with 3 editions listed
    assert.equal(physical[1].regCatNo, 'SRCL-12539');
    assert.equal(physical[1].mbEditions.length, 3);
    assert.equal(digital[0].id.startsWith('sheet-dig-'), true);
    assert.equal(digital[0].digitalOnly, true);
  });

  it('supports Flat Table Layout, explicit ID/Kana/iTunes columns, checked synonyms, and validation errors', () => {
    const validate = getValidator();
    const flatCsv = [
      'Got it?,Category,Artist,Title,Catalog Number,Filing Location,Target Used Price,Priority,Recommended Shops,ID,Kana,iTunes Query',
      'TRUE,J-Rock,bump of chicken,Jupiter,TFCC-86101 (通常盤),Look under バ (Ba),¥500,High,Book Off,bump-jupiter,バ,Jupiter BUMP OF CHICKEN',
      'YES,J-Rock,bump of chicken,Jupiter Reissue,TFCC-86102,Look under バ,¥500,Low,,bump-jupiter,,',
      '✓,Digital-Only,Digital Artist,Digital Song,N/A (Digital Only),Skip physical,,Medium,Mora,,,',
      ',EmptySkip,,,,,,,,,'
    ].join('\n');

    const parsed = sheetAdapterModule.parseGoogleSheetCsv(flatCsv);
    assert.deepEqual(validate(parsed.catalog), { valid: true, errors: [] });
    assert.equal(parsed.catalog.items.length, 3);
    assert.equal(parsed.catalog.items[0].id, 'bump-jupiter');
    assert.equal(parsed.catalog.items[1].id, 'bump-jupiter-2');
    assert.equal(parsed.catalog.items[2].digitalOnly, true);
    assert.deepEqual(parsed.duplicates, []);
    assert.deepEqual(parsed.sheetChecklist, {
      'bump-jupiter': true,
      'bump-jupiter-2': true,
      [parsed.catalog.items[2].id]: true
    });
    assert.equal(parsed.rowChecklistByCatNo['TFCC-86101'], true);
    assert.equal(parsed.rowChecklistByCatNo['TFCC-86102'], true);

    assert.throws(() => sheetAdapterModule.parseGoogleSheetCsv('foo,bar\n1,2'), /header row/i);
    assert.throws(() => sheetAdapterModule.parseGoogleSheetCsv('Got it?,Title,Catalog Number\n,,'), /no release rows/i);
  });

  it('merges Google Sheet updates and new rows onto base JSON catalog and builds catno checklist map', () => {
    const baseCatalog = makeValidCatalog({
      items: [
        makeValidItem({
          id: 'curated-akfg',
          category: 'Anime Themes & Chara',
          artist: 'Asian Kung-Fu Generation',
          title: 'Sol-fa',
          regCatNo: 'KSCL-737',
          catalog: 'KSCL-737 (通常盤)',
          mbEditions: [{ catno: 'KSCL-737', label: '通常盤 Regular' }]
        }),
        makeValidItem({
          id: 'curated-dig',
          digitalOnly: true,
          artist: 'Hanatan',
          title: 'gradation',
          regCatNo: '',
          catalog: 'Digital-Only',
          mbEditions: []
        })
      ]
    });

    const csvOverlay = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'TRUE,Anime Themes & Chara,Asian Kung-Fu Generation,Sol-fa,KSCL-737 (通常盤),Look under ア,¥600,High,"Book Off, Disk Union"',
      'FALSE,Game OST,Keiichi Okabe,NieR:Automata OST,SQEX-10589~91,Look under ナ,¥2500,High,Mandarake',
      'TRUE,Digital-Only,Hanatan,gradation,N/A (Digital Only),Digital only,,Low,iTunes JP'
    ].join('\n');

    const sheetParsed = sheetAdapterModule.parseGoogleSheetCsv(csvOverlay);
    const merged = sheetAdapterModule.mergeCatalogWithSheet(baseCatalog, sheetParsed);

    assert.equal(merged.matchedCount, 2);
    assert.equal(merged.addedCount, 1);
    assert.equal(merged.catalog.items.length, 3);
    assert.equal(merged.catalog.items[0].priority, 'High');
    assert.equal(merged.catalog.items[0].recommendedShops, 'Book Off, Disk Union');
    assert.equal(merged.catalog.items[2].regCatNo, 'SQEX-10589~91');
    assert.ok(merged.catalog.categories.some((c) => c.key === 'Game OST'));
    assert.deepEqual(merged.sheetChecklist, {
      'curated-akfg': true,
      'curated-dig': true
    });

    const byCatNo = sheetAdapterModule.buildChecklistByCatNo(merged.catalog.items, {
      'curated-akfg': true,
      'curated-dig': true
    });
    assert.deepEqual(byCatNo, {
      'KSCL-737': true,
      'SQEX-10589~91': false
    });
    assert.equal(sheetAdapterModule.isGoogleSheetCsvUrl('https://docs.google.com/spreadsheets/d/abc/edit'), true);
    assert.equal(sheetAdapterModule.isGoogleSheetCsvUrl('https://example.com/catalog.json'), false);

    // Browser global attachment check (DiskCrate namespace + legacy CDHunt shared alias)
    const sandbox = { DiskCrate: { extractGoogleSheetId } };
    sandbox.CDHunt = sandbox.DiskCrate;
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'sheet-adapter.js'), 'utf8'), sandbox);
    assert.equal(sandbox.window.DiskCrate, sandbox.window.CDHunt);
    assert.equal(typeof sandbox.window.DiskCrate.sheetAdapter.parseGoogleSheetCsv, 'function');
    assert.equal(typeof sandbox.window.CDHunt.sheetAdapter.parseGoogleSheetCsv, 'function');
  });

  it('cleanly strips surrounding quotes from parenthetical titles for itunesQuery and requiredGroups', () => {
    const csv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Anime,yama,"""slash"" (Gundam OP)",SRCL-12539 (通常盤),Look under ヤ,¥500,High,Book Off',
      'FALSE,Digital-Only,Rokudenashi,"""ホウキボシ"" (Houkiboshi)",N/A (Digital Only),Digital only,,Low,iTunes JP'
    ].join('\n');

    const parsed = sheetAdapterModule.parseGoogleSheetCsv(csv);
    const yama = parsed.catalog.items[0];
    const rokudenashi = parsed.catalog.items[1];
    assert.equal(yama.itunesQuery, 'yama slash');
    assert.deepEqual(yama.requiredGroups, [['slash'], ['yama']]);
    assert.equal(rokudenashi.itunesQuery, 'Rokudenashi ホウキボシ');
    assert.deepEqual(rokudenashi.requiredGroups, [['ホウキボシ', 'Houkiboshi'], ['Rokudenashi']]);
  });

  it('builds clean cover queries, requiredGroups, editions, and Jacket Search URLs across complex real Sheet rows', async () => {
    const complexCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Anime,(K)NoW_NAME,"""KNOCK on the CORE / Ash-like Snow"" (Fairy gone S1 OP & ED)",THCS-60240,Look under ノ,¥700,Medium,Suruga-ya',
      'FALSE,Anime,ChouCho (ちょうちょ),"""transient blue"" (Limited Acoustic Single — includes ""Authentic symphony (Acoustic ver.)"")",LZM-2118 (Venue/Web Ltd),Look under チ,¥900,High,Mandarake',
      'FALSE,Anime,EGOIST,"GREATEST HITS 2011-2017 ""ALTER EGO"" (Best Album)",VVCL-1155 (Reg) / VVCL-1151～2 (Ltd A BD),Look under エ,¥1200,Medium,Suruga-ya',
      'FALSE,Anime,SawanoHiroyuki[nZk]:LiSA (澤野弘之),"""narrative / NOISEofRAIN"" (Mobile Suit Gundam NT Theme)",VVCL-1362 (Reg CD) / VVCL-1360～1 (Ltd CD+DVD),Look under サ,¥800,Medium,Suruga-ya',
      'FALSE,Anime,Shiyui (シユイ),"""ホロウ"" (Hollow) (Demon Lord 2099 OP, CD+Blu-ray)",AICL-4670～4671,Look under シ,¥2400,Medium,Animate',
      'FALSE,Anime,Aooo,"""DAYS!"" (Grow Up Show ED + ""ユラリユレル"" cover, CD+Blu-ray)",SRCL-13763～4,Look under ア,¥1000,Low,Tower Records',
      'FALSE,Anime,Lapis Re:LiGHTs (ラピスリライツ),"""私たちのSTARTRAIL / プラネタリウム""",VICL-37548 (Reg) / VIZL-1779 (Ltd),Look under ラ,¥600,Medium,Suruga-ya',
      'FALSE,Anime,Mia REGINA,"""月海の揺り籠"" (Tsukiumi no Yurikago) (Aquatope ED1)",LACM-24156 (Anime CD Reg) / LACM-24155 (Artist CD+BD Ltd),Look under ミ,¥500,Medium,Suruga-ya',
      'FALSE,Seiyuu,Rico Sasaki (佐々木李子),スタート! (Start!) (Artist Editions ONLY for Track 4 "フレンドパスワード" — Skip AKCY-58073),AKCY-58075 (Artist CD+Photobook) / AKCY-58074/B (Artist CD+DVD),Look under サ,¥1200,High,Animate',
      'FALSE,Anime,Void_Chords feat. LIO,"""FLARE"" (Arifureta S1 OP)",LACM-14917,Look under ボ,¥500,Medium,Book Off',
      'FALSE,OST,SukaSuka OST,青い記憶 (Aoi Kioku) (Shuumatsu Nani Shitemasu ka? 2-CD Set),LACA-9522～9523,Look under ア,¥2000,High,Mandarake',
      'FALSE,Anime,Princession Orchestra,Character Single: Ripple (プリンセッション・オーケストラ キャラクターソング Ripple),KICM-3387～3388,Look under プ,¥600,Low,Animate'
    ].join('\n');

    const parsed = sheetAdapterModule.parseGoogleSheetCsv(complexCsv);
    const items = parsed.catalog.items;
    assert.equal(items.length, 12);

    const byId = new Map(items.map((x) => [x.id, x]));
    assert.equal(byId.get('sheet-thcs-60240').itunesQuery, '(K)NoW_NAME KNOCK on the CORE');
    assert.deepEqual(byId.get('sheet-thcs-60240').requiredGroups, [['KNOCK on the CORE', 'Ash-like Snow'], ['(K)NoW_NAME']]);

    assert.equal(byId.get('sheet-lzm-2118').itunesQuery, 'ChouCho transient blue');
    assert.deepEqual(byId.get('sheet-lzm-2118').requiredGroups, [['transient blue'], ['ChouCho', 'ちょうちょ']]);

    assert.equal(byId.get('sheet-vvcl-1155').itunesQuery, 'EGOIST GREATEST HITS 2011-2017 ALTER EGO');
    assert.equal(byId.get('sheet-vvcl-1155').mbEditions[1].catno, 'VVCL-1151~2');
    assert.equal(byId.get('sheet-vvcl-1155').mbEditions[1].label, 'Ltd A BD');

    assert.equal(byId.get('sheet-vvcl-1362').itunesQuery, 'SawanoHiroyuki[nZk] narrative');
    assert.ok(byId.get('sheet-vvcl-1362').requiredGroups[1].includes('LiSA'));
    assert.ok(byId.get('sheet-vvcl-1362').requiredGroups[1].includes('澤野弘之'));

    assert.equal(byId.get('sheet-aicl-4670-4671').regCatNo, 'AICL-4670~4671');
    assert.equal(byId.get('sheet-aicl-4670-4671').itunesQuery, 'Shiyui ホロウ');
    assert.deepEqual(byId.get('sheet-aicl-4670-4671').requiredGroups, [['ホロウ', 'Hollow'], ['Shiyui', 'シユイ']]);

    // English editorial notes mentioning a Japanese track must NOT become titleJa
    assert.equal(byId.get('sheet-srcl-13763-4').titleJa, undefined);
    assert.equal(byId.get('sheet-akcy-58075').titleJa, undefined);
    // "Skip AKCY-58073" in Title column must NOT leak into mbEditions
    assert.deepEqual(byId.get('sheet-akcy-58075').mbEditions.map((e) => e.catno), ['AKCY-58075', 'AKCY-58074']);
    assert.equal(byId.get('sheet-akcy-58075').itunesQuery, 'Rico Sasaki スタート!');

    // Lapis Re:LiGHTs is NOT chopped at colon, while embedded STARTRAIL & LiGHTs become matching tokens
    assert.equal(byId.get('sheet-vicl-37548').itunesQuery, 'Lapis Re:LiGHTs 私たちのSTARTRAIL');
    assert.ok(byId.get('sheet-vicl-37548').requiredGroups[0].includes('STARTRAIL'));
    assert.ok(byId.get('sheet-vicl-37548').requiredGroups[1].includes('LiGHTs'));

    // "(Anime CD Reg)" beats "(Artist CD+BD Ltd)" as regular edition
    assert.equal(byId.get('sheet-lacm-24156').regCatNo, 'LACM-24156');
    assert.equal(byId.get('sheet-lacm-24156').mbEditions[0].label, 'Anime CD Reg');

    // feat. stripped from artist query; OST artist alias omitted from requiredGroups; genuine titleJa preserved
    assert.equal(byId.get('sheet-lacm-14917').itunesQuery, 'Void_Chords FLARE');
    assert.equal(byId.get('sheet-laca-9522-9523').itunesQuery, '青い記憶');
    assert.deepEqual(byId.get('sheet-laca-9522-9523').requiredGroups, [['青い記憶', 'Aoi Kioku']]);
    assert.equal(byId.get('sheet-kicm-3387-3388').itunesQuery, 'Princession Orchestra Ripple');
    assert.equal(byId.get('sheet-kicm-3387-3388').titleJa, 'プリンセッション・オーケストラ キャラクターソング Ripple');

    // Jacket Google Search query builder (physical vs digitalOnly)
    assert.equal(
      coverResolverModule.buildJacketSearchQuery(byId.get('sheet-akcy-58075')),
      'AKCY-58075 Rico Sasaki スタート! 通常盤 CD'
    );
    assert.equal(
      coverResolverModule.buildJacketSearchQuery({
        digitalOnly: true,
        regCatNo: 'DIGITAL-ONLY',
        artist: 'Hanatan',
        title: '"gradation"'
      }),
      'Hanatan gradation ジャケット'
    );

    // coverResolver normalized matching + artistJa/song fallbacks + MusicBrainz range fallback
    class OkImg {
      set src(_) {
        this.naturalWidth = 600;
        this.naturalHeight = 600;
        if (this.onload) this.onload();
      }
    }

    const itunesFetched = [];
    const normFetch = async (url) => {
      itunesFetched.push(url);
      if (url.includes(encodeURIComponent('EGOIST GREATEST HITS 2011-2017 ALTER EGO')) && url.includes('country=jp')) {
        return {
          ok: true,
          async json() {
            return {
              results: [{ trackName: 'EGOIST', collectionName: 'GREATEST HITS 2011-2017 “ALTER EGO”', artistName: 'EGOIST', artworkUrl100: 'https://ex.com/alter/100x100bb.jpg' }]
            };
          }
        };
      }
      if (url.includes(encodeURIComponent('佐々木李子 スタート!'))) {
        return {
          ok: true,
          async json() {
            return {
              results: [{ trackName: 'スタート!', collectionName: 'スタート! - Single', artistName: '佐々木 李子', artworkUrl100: 'https://ex.com/rico/100x100bb.jpg' }]
            };
          }
        };
      }
      if (url.includes(encodeURIComponent('(K)NoW_NAME KNOCK on the CORE')) && url.includes('entity=song') && url.includes('country=jp')) {
        return {
          ok: true,
          async json() {
            return {
              results: [{ trackName: 'KNOCK on the CORE', collectionName: 'OP&ED「KNOCK on the CORE/Ash-like Snow」', artistName: '(K)NoW_NAME', artworkUrl100: 'https://ex.com/knock/100x100bb.jpg' }]
            };
          }
        };
      }
      return { ok: true, async json() { return { results: [] }; } };
    };

    await withMockBrowserGlobals({ fetch: normFetch, Image: OkImg }, async () => {
      const egoistCovers = await coverResolverModule.tryItunesCovers(byId.get('sheet-vvcl-1155'));
      assert.equal(egoistCovers[0].url, 'https://ex.com/alter/600x600bb.jpg');

      const ricoCovers = await coverResolverModule.tryItunesCovers(byId.get('sheet-akcy-58075'));
      assert.equal(ricoCovers[0].url, 'https://ex.com/rico/600x600bb.jpg');
      assert.ok(itunesFetched.some((u) => u.includes(encodeURIComponent('佐々木李子 スタート!'))));

      const knowCovers = await coverResolverModule.tryItunesCovers(byId.get('sheet-thcs-60240'));
      assert.equal(knowCovers[0].url, 'https://ex.com/knock/600x600bb.jpg');
      assert.ok(itunesFetched.some((u) => u.includes('entity=song') && u.includes(encodeURIComponent('(K)NoW_NAME KNOCK on the CORE'))));
    });

    const mbUrls = [];
    const mbFetch = async (url) => {
      mbUrls.push(url);
      if (url.includes('catno:AICL-4670~4671')) {
        return { ok: true, async json() { return { releases: [] }; } };
      }
      if (url.includes('catno:AICL-4670')) {
        return { ok: true, async json() { return { releases: [{ id: 'rel-hollow-1' }] }; } };
      }
      return { ok: true, async json() { return { releases: [] }; } };
    };
    const mbCovers = await withMockBrowserGlobals({ fetch: mbFetch, Image: OkImg }, () =>
      coverResolverModule.tryMusicBrainzCovers(byId.get('sheet-aicl-4670-4671'))
    );
    assert.equal(mbCovers.length, 1);
    assert.equal(mbCovers[0].catNo, 'AICL-4670~4671');
    assert.equal(mbUrls.length, 2);
  });

  it('auto-deduplicates within Google Sheets, detects duplicates without digital placeholder false positives, and deduplicates merged new rows', () => {
    const dupCsv = [
      'Got it?,Aisle / Category,Artist / Franchise,Title / Release Details,Catalog Number,Filing Location & Shelf Search Advice,Target Used Price,Priority,Recommended Shops',
      'FALSE,Game OST,Capcom (カプコン),Breath of Fire III OST,CPCA-1004,Look under ブ,"¥3,000–¥6,000",,,',
      'TRUE,Game OST,Capcom,Breath of Fire III Original Soundtrack,CPCA-1004 (通常盤) / CPCA-1004-ALT,Look under ブ,¥4000,High,"Mandarake Grandchaos"',
      'FALSE,Digital-Only,Hanatan,"""gradation""",N/A (Digital Only),Digital only,,,iTunes JP',
      'TRUE,Digital-Only,Hanatan (花たん),gradation (Digital Single),N/A (Digital Only),Digital only,,Low,Mora'
    ].join('\n');

    const parsed = sheetAdapterModule.parseGoogleSheetCsv(dupCsv);
    assert.equal(parsed.catalog.items.length, 2);
    assert.equal(parsed.duplicates.length, 2);
    assert.equal(parsed.duplicates[0].reason, 'catalogNumber');
    assert.equal(parsed.duplicates[0].key, 'CPCA-1004');
    assert.equal(parsed.duplicates[0].matchedId, 'sheet-cpca-1004');
    assert.equal(parsed.duplicates[1].reason, 'artistTitle');
    assert.equal(parsed.catalog.items[0].priority, 'High');
    assert.equal(parsed.catalog.items[0].recommendedShops, 'Mandarake Grandchaos');
    assert.equal(parsed.catalog.items[1].priority, 'Low');
    assert.equal(parsed.catalog.items[1].artistJa, '花たん');
    assert.deepEqual(parsed.sheetChecklist, {
      'sheet-cpca-1004': true,
      [parsed.catalog.items[1].id]: true
    });
    assert.equal(parsed.rowChecklistByCatNo['CPCA-1004'], true);

    // detectCatalogDuplicates: flags matching catalog codes or digital titles, ignores distinct codes & DIGITAL placeholders
    const sampleItems = [
      makeValidItem({ id: 'a1', regCatNo: 'ABCD-1001', catalog: 'ABCD-1001', title: 'Track One', mbEditions: [{ catno: 'ABCD-1001' }] }),
      makeValidItem({ id: 'a2', regCatNo: 'ABCD-1002', catalog: 'ABCD-1002', title: 'Track One', mbEditions: [{ catno: 'ABCD-1002' }] }), // Distinct pressing -> OK
      makeValidItem({ id: 'a3', regCatNo: 'ABCD-1001', catalog: 'ABCD-1001 (Ltd)', title: 'Different Title', mbEditions: [{ catno: 'ABCD-1001' }] }), // Code dup!
      makeValidItem({ id: 'd1', digitalOnly: true, regCatNo: 'DIGITAL', catalog: 'Digital Only', mbEditions: [], artist: 'Hanatan', title: 'gradation' }),
      makeValidItem({ id: 'd2', digitalOnly: true, regCatNo: 'DIGITAL-ONLY', catalog: 'Digital Only', mbEditions: [], artist: 'Rokudenashi', title: 'Houkiboshi' })
    ];
    const detected = sheetAdapterModule.detectCatalogDuplicates(sampleItems);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].itemId, 'a3');
    assert.equal(detected[0].duplicateOfId, 'a1');
    assert.equal(detected[0].reason, 'catalogNumber');

    // mergeCatalogWithSheet: deduplicates two new duplicate rows coming from a Sheet object
    const base = makeValidCatalog({
      items: [makeValidItem({ id: 'base-1', regCatNo: 'ZZZ-9999', catalog: 'ZZZ-9999', mbEditions: [{ catno: 'ZZZ-9999' }] })]
    });
    const unmergedSheetObj = {
      schemaVersion: 1,
      items: [
        makeValidItem({ id: 'new-1', regCatNo: 'NEW-1111', catalog: 'NEW-1111', mbEditions: [{ catno: 'NEW-1111' }] }),
        makeValidItem({ id: 'new-2', regCatNo: 'NEW-1111', catalog: 'NEW-1111', mbEditions: [{ catno: 'NEW-1111' }], priority: 'High' })
      ]
    };
    const mergedRes = sheetAdapterModule.mergeCatalogWithSheet(base, unmergedSheetObj);
    assert.equal(mergedRes.addedCount, 1);
    assert.equal(mergedRes.catalog.items.length, 2);
    assert.equal(mergedRes.catalog.items[1].priority, 'High');
    assert.equal(mergedRes.duplicates.length, 1);
    assert.equal(mergedRes.duplicates[0].key, 'NEW-1111');
  });
});
