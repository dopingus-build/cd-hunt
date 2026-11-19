'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let validateCatalog = null;
let normalizeCatalogUrl = null;
let loadError = null;

try {
  ({ validateCatalog, normalizeCatalogUrl } = require('../js/validate.js'));
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
      meta: {
        title: 'Test CD Cover Album',
        subtitle: 'Crate Browser (通常盤 Priority)',
        documentTitle: 'Test CD Cover Album & Checklist',
        storagePrefix: 'test_cd',
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

describe('Catalog validation module export', () => {
  it('exports validateCatalog and normalizeCatalogUrl from ../js/validate.js', () => {
    getValidator();
    getNormalizer();
  });
});

describe('Sample catalog (docs/sample-catalog.json)', () => {
  it('passes validation with zero errors', () => {
    const validate = getValidator();
    const samplePath = path.join(__dirname, '..', 'docs', 'sample-catalog.json');
    const data = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    assert.deepEqual(validate(data), { valid: true, errors: [] });
  });
});

describe('External metadata catalog (cd-metadata/2026-japan.json)', () => {
  it('passes validation with zero errors when sibling cd-metadata repo is present', () => {
    const validate = getValidator();
    const osakaPath = path.join(__dirname, '..', '..', 'cd-metadata', '2026-japan.json');
    if (!fs.existsSync(osakaPath)) return;
    const data = JSON.parse(fs.readFileSync(osakaPath, 'utf8'));
    assert.deepEqual(validate(data), { valid: true, errors: [] });
    assert.equal(data.items.filter((i) => !i.digitalOnly).length, 53);
    assert.equal(data.items.filter((i) => !!i.digitalOnly).length, 2);
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

  it('preserves already-raw and arbitrary JSON URLs', () => {
    const normalize = getNormalizer();
    const rawUrl = 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json';
    assert.equal(normalize(rawUrl), rawUrl);
    assert.equal(normalize('https://example.com/catalog.json'), 'https://example.com/catalog.json');
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

  it('accepts a valid catalog when optional meta and categories are omitted', () => {
    const validate = getValidator();
    const result = validate({ items: [makeValidItem()] });
    assert.deepEqual(result, { valid: true, errors: [] });
  });
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
    'storagePrefix',
    'searchPlaceholder',
    'digitalSectionTitle',
    'digitalSectionSubtitle'
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

  for (const badPrefix of ['', '   ']) {
    it(`rejects empty/whitespace-only meta.storagePrefix (${JSON.stringify(badPrefix)})`, () => {
      const validate = getValidator();
      const catalog = makeValidCatalog();
      catalog.meta.storagePrefix = badPrefix;
      const result = validate(catalog);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('storagePrefix')));
    });
  }
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
});
