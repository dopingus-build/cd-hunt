'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.join(__dirname, '..');
const { validateCollection, validateOwnedRelease, normalizeCatNo } = require('../js/validate.js');
const dbMod = require('../js/db.js');
const trackResolver = require('../js/track-resolver.js');
const sheetAdapter = require('../js/sheet-adapter.js');
const collectionMod = require('../js/collection.js');
const syncMod = require('../js/sync.js');

function makeMockIdbFactoryV2(backing) {
  const state = backing || {
    version: 0,
    stores: new Map(),
    indexes: new Map()
  };

  function makeReq(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        if (req.onerror) req.onerror({ target: req });
      }
    });
    return req;
  }

  return {
    _state: state,
    open(_name, targetVersion) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, transaction: null };
      queueMicrotask(() => {
        const dbObj = {
          objectStoreNames: {
            contains: (s) => state.stores.has(s)
          },
          createObjectStore: (s, opts) => {
            if (!state.stores.has(s)) state.stores.set(s, { keyPath: opts.keyPath, rows: new Map() });
            if (!state.indexes.has(s)) state.indexes.set(s, new Set());
            const idxSet = state.indexes.get(s);
            return {
              indexNames: { contains: (idxName) => idxSet.has(idxName) },
              createIndex: (idxName) => { idxSet.add(idxName); }
            };
          },
          transaction: (storeName) => {
            const storeMeta = state.stores.get(storeName);
            const idxSet = state.indexes.get(storeName) || new Set();
            const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
            const storeApi = {
              indexNames: { contains: (idxName) => idxSet.has(idxName) },
              createIndex: (idxName) => { idxSet.add(idxName); },
              index: (idxName) => {
                if (!idxSet.has(idxName)) throw new Error('Missing index ' + idxName);
                const fieldMap = {
                  by_catNo: 'catNo',
                  by_barcode: 'barcode',
                  by_category: 'category',
                  by_dirty: 'dirty',
                  by_deletedAt: 'deletedAt'
                };
                const field = fieldMap[idxName];
                return {
                  getAll: (matchVal) =>
                    makeReq((r) => {
                      const all = Array.from(storeMeta.rows.values()).map((x) => JSON.parse(JSON.stringify(x)));
                      r.result = field ? all.filter((item) => item[field] === matchVal) : all;
                      if (r.onsuccess) r.onsuccess({ target: r });
                    })
                };
              },
              get: (k) =>
                makeReq((r) => {
                  r.result = storeMeta.rows.has(k) ? JSON.parse(JSON.stringify(storeMeta.rows.get(k))) : undefined;
                  if (r.onsuccess) r.onsuccess({ target: r });
                }),
              put: (val) =>
                makeReq((r) => {
                  storeMeta.rows.set(val[storeMeta.keyPath], JSON.parse(JSON.stringify(val)));
                  r.result = val[storeMeta.keyPath];
                  if (r.onsuccess) r.onsuccess({ target: r });
                }),
              delete: (k) =>
                makeReq((r) => {
                  storeMeta.rows.delete(k);
                  r.result = undefined;
                  if (r.onsuccess) r.onsuccess({ target: r });
                }),
              getAll: () =>
                makeReq((r) => {
                  r.result = Array.from(storeMeta.rows.values()).map((v) => JSON.parse(JSON.stringify(v)));
                  if (r.onsuccess) r.onsuccess({ target: r });
                }),
              clear: () =>
                makeReq((r) => {
                  storeMeta.rows.clear();
                  r.result = undefined;
                  if (r.onsuccess) r.onsuccess({ target: r });
                })
            };
            tx.objectStore = () => storeApi;
            setTimeout(() => {
              if (tx.oncomplete) tx.oncomplete({ target: tx });
            }, 0);
            return tx;
          },
          close: () => {}
        };
        req.result = dbObj;
        req.transaction = {
          objectStore: (s) => dbObj.transaction(s).objectStore(s)
        };
        if (state.version < targetVersion && req.onupgradeneeded) {
          req.onupgradeneeded({ target: { result: dbObj }, oldVersion: state.version, newVersion: targetVersion });
          state.version = targetVersion;
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    }
  };
}

describe('Phase 2 Collection Schema & Validator (collection.v1.schema.json + validate.js)', () => {
  it('ships valid collection.v1.schema.json and validates complete and empty Owned Collection snapshots', () => {
    const schemaPath = path.join(ROOT_DIR, 'schemas', 'collection.v1.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.properties.schemaVersion.const, 1);
    assert.equal(schema.$defs.OwnedRelease.required.includes('catNo'), true);

    assert.equal(normalizeCatNo(' lacm-24156～1 '), 'LACM-24156~1');

    const validEmpty = validateCollection({ schemaVersion: 1, items: [] });
    assert.equal(validEmpty.valid, true);

    const validFull = validateCollection({
      $schema: 'https://dopingus-build.github.io/disk-crate/schemas/collection.v1.schema.json',
      schemaVersion: 1,
      exportedAt: 1700000000000,
      meta: { title: 'My Shelf', ownedSheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit' },
      items: [
        {
          id: 'own-lacm-24156',
          artist: 'Example Artist',
          artistJa: 'サンプル',
          title: 'Moonlight Single',
          titleJa: 'ムーンライト',
          category: 'Anime OST',
          catNo: 'LACM-24156',
          editionLabel: '通常盤 Regular',
          barcode: '4540774241569',
          mbid: '11111111-1111-4111-8111-111111111111',
          trackSource: 'musicbrainz',
          tracks: [
            { disc: 1, mediaType: 'CD', number: 1, title: 'Moonlight', durationMs: 245000 },
            { disc: 2, mediaType: 'BD', number: 1, title: 'MV', notes: 'Blu-ray' }
          ],
          customCovers: {
            selectedIndex: 0,
            variants: [{ url: 'https://img.example/custom.jpg', label: 'Custom', catNo: 'LACM-24156', source: 'custom', isRegular: true }]
          },
          selectedVariant: { url: 'https://img.example/custom.jpg', selectedIndex: 0, label: 'Custom' },
          purchasePrice: '¥900',
          purchaseShop: 'Book Off',
          purchaseDate: '2026-11-20',
          notes: 'Mint with obi',
          createdAt: 1000,
          clientUpdatedAt: 2000,
          syncSeq: null,
          deletedAt: null
        }
      ]
    });
    assert.equal(validFull.valid, true, validFull.errors.join('; '));
  });

  it('rejects malformed Owned Collection snapshots, invalid fields, duplicates, and prohibited domains', () => {
    assert.equal(validateCollection(null).valid, false);
    const bad = validateCollection({
      schemaVersion: 2,
      exportedAt: -5,
      meta: 'wrong',
      items: [
        {
          id: 'bad id!',
          artist: '',
          title: 'Valid Title',
          category: 'Rock',
          catNo: '',
          barcode: '123',
          mbid: 'not-uuid',
          trackSource: 'discogs',
          tracks: [{ number: 0, title: '', mediaType: 'Vinyl' }],
          customCovers: { variants: [{ url: 'https://vgmdb.net/cover.jpg' }], selectedIndex: -1 },
          selectedVariant: { url: '' },
          clientUpdatedAt: -1
        },
        {
          id: 'dup-1',
          artist: 'A',
          title: 'B',
          category: 'C',
          catNo: 'CAT-1'
        },
        {
          id: 'dup-1',
          artist: 'A',
          title: 'B',
          category: 'C',
          catNo: 'CAT-2'
        }
      ]
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => e.includes('Unsupported schemaVersion')));
    assert.ok(bad.errors.some((e) => e.includes('barcode')));
    assert.ok(bad.errors.some((e) => e.includes('mbid')));
    assert.ok(bad.errors.some((e) => e.includes('trackSource')));
    assert.ok(bad.errors.some((e) => e.includes('vgmdb.net')));
    assert.ok(bad.errors.some((e) => e.includes('Duplicate item id')));

    const singleErrs = [];
    validateOwnedRelease(null, 0, new Set(), singleErrs);
    assert.ok(singleErrs.some((e) => e.includes('must be an object')));
  });
});

describe('IndexedDB v2 upgrade, owned_releases CRUD/indexes & sync_meta (js/db.js)', () => {
  it('upgrades existing v1 databases to v2 without losing track_cache and supports CRUD, indexes, tombstones, and sync_meta', async () => {
    const backing = {
      version: 1,
      stores: new Map([
        ['track_cache', { keyPath: 'releaseKey', rows: new Map([['catno:CPCA-1004', { releaseKey: 'catno:CPCA-1004', tracks: [{ number: 1, title: 'Preserved' }] }]]) }],
        ['manual_tracks', { keyPath: 'releaseKey', rows: new Map() }]
      ]),
      indexes: new Map()
    };

    const client = dbMod.createDbClient({ indexedDBImpl: makeMockIdbFactoryV2(backing) });
    assert.equal(client.isUsingFallback(), false);

    // Phase 1 track cache survives v1 -> v2 upgrade
    const cached = await client.getTrackCache('catno:CPCA-1004');
    assert.equal(cached.tracks[0].title, 'Preserved');

    const batchSaved = await client.putOwnedReleasesBatch([
      {
        id: 'own-1',
        artist: 'Artist A',
        title: 'Title A',
        category: 'OST',
        catNo: 'lacm-24156～1',
        barcode: '4540774-241569',
        clientUpdatedAt: 1000,
        dirty: 1
      },
      {
        id: 'own-2',
        artist: 'Artist B',
        title: 'Title B',
        category: 'OST',
        catNo: 'KSCL-737',
        deletedAt: 5000,
        clientUpdatedAt: 5000,
        dirty: 0
      }
    ]);
    assert.equal(batchSaved.length, 2);
    assert.equal(batchSaved[0].catNo, 'LACM-24156~1');
    assert.equal(batchSaved[0].barcode, '4540774241569');

    const active = await client.getAllOwnedReleases();
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'own-1');

    const withDeleted = await client.getAllOwnedReleases({ includeDeleted: true });
    assert.equal(withDeleted.length, 2);

    const dirty = await client.getDirtyOwnedReleases();
    assert.equal(dirty.length, 1);
    assert.equal(dirty[0].id, 'own-1');

    const byCat = await client.getOwnedReleasesByCatNo('LACM-24156〜1');
    assert.equal(byCat.length, 1);
    assert.equal(byCat[0].id, 'own-1');

    const byBc = await client.getOwnedReleasesByBarcode('4540774241569');
    assert.equal(byBc.length, 1);
    assert.equal(byBc[0].id, 'own-1');

    await client.putSyncMeta('collectionSync', { lastSyncSeq: 42, lastOwnedSheetUrl: 'https://docs.google.com/spreadsheets/d/s1/edit' });
    const meta = await client.getSyncMeta('collectionSync');
    assert.equal(meta.lastSyncSeq, 42);
    await client.deleteSyncMeta('collectionSync');
    assert.equal(await client.getSyncMeta('collectionSync'), null);

    await client.deleteOwnedReleaseHard('own-2');
    assert.equal((await client.getAllOwnedReleases({ includeDeleted: true })).length, 1);
    await client.clearOwnedReleases();
    assert.equal((await client.getAllOwnedReleases()).length, 0);
    client.close();
  });

  it('supports owned_releases & sync_meta seamlessly in in-memory fallback mode', async () => {
    const client = dbMod.createDbClient({
      indexedDBImpl: {
        open() {
          throw new Error('SecurityError');
        }
      }
    });
    await client.putOwnedRelease({
      id: 'mem-1',
      artist: 'Mem',
      title: 'Fallback',
      category: 'Rock',
      catNo: 'kicm-1234',
      barcode: '4988003000001',
      dirty: 1
    });
    assert.equal(client.isUsingFallback(), true);
    assert.equal((await client.getOwnedRelease('mem-1')).catNo, 'KICM-1234');
    assert.equal((await client.getDirtyOwnedReleases()).length, 1);
    assert.equal((await client.getOwnedReleasesByCatNo('KICM-1234')).length, 1);
    assert.equal((await client.getOwnedReleasesByBarcode('4988003000001')).length, 1);
    await client.putSyncMeta('collectionSync', { lastSyncSeq: 7 });
    assert.equal((await client.getSyncMeta('collectionSync')).lastSyncSeq, 7);
  });
});

describe('Collection Domain Logic, Graduation & Cross-Referencing (js/collection.js + track-resolver lookup)', () => {
  it('graduates Hunt items keeping only custom covers, normalizes catalog codes, and cross-references exact/other/track overlaps', () => {
    assert.equal(trackResolver.deriveTrackReleaseKey({ catNo: 'LACM-24156' }), 'catno:LACM-24156');

    const huntItem = {
      id: 'hunt-srcl-12539',
      category: 'Anime',
      artist: 'yama',
      title: 'slash',
      titleJa: 'スラッシュ',
      catalog: 'SRCL-12539 (通常盤 Regular)',
      regCatNo: 'SRCL-12539',
      mbEditions: [{ catno: 'SRCL-12539', label: '通常盤 Regular' }, { catno: 'SRCL-12540', label: '期間生産限定 Anime' }],
      kana: 'ヤ',
      filing: 'Shelf A',
      price: '¥1,200'
    };

    const graduated = collectionMod.graduateHuntItemToOwned(
      huntItem,
      {
        activeVariant: { url: 'https://img.example/custom.jpg', label: '通常盤 Regular', catNo: 'SRCL-12539', source: 'custom' },
        effectiveTracksInfo: {
          tracks: [
            { disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 210000 },
            { disc: 1, mediaType: 'CD', number: 2, title: 'slash (Instrumental)', durationMs: 210000 }
          ],
          trackSource: 'musicbrainz'
        },
        customCoverEntry: {
          selectedIndex: 1,
          variants: [
            { url: 'https://coverartarchive.org/pub.jpg', label: 'Public', source: 'musicbrainz' },
            { url: 'https://img.example/custom.jpg', label: '通常盤 Regular', catNo: 'SRCL-12539', source: 'custom', isRegular: true }
          ]
        },
        purchasePrice: '¥950',
        purchaseShop: 'Book Off',
        purchaseDate: '2026-11-25',
        notes: 'With obi',
        existingIds: [],
        nowMs: 123456
      }
    );

    assert.equal(graduated.catNo, 'SRCL-12539');
    assert.equal(graduated.customCovers.variants.length, 1);
    assert.equal(graduated.customCovers.variants[0].url, 'https://img.example/custom.jpg');
    assert.equal(graduated.tracks.length, 2);

    const ownedBestAlbum = collectionMod.createOwnedRelease({
      id: 'own-best',
      artist: 'yama',
      title: 'the meaning of life',
      category: 'J-Pop',
      catNo: 'SRCL-12999～1',
      barcode: '4547366000001',
      tracks: [
        { disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 210000 },
        { disc: 1, mediaType: 'CD', number: 2, title: 'Another Song (TV Size)', durationMs: 90000 }
      ],
      trackSource: 'manual'
    });

    const idx = collectionMod.buildOwnedIndex([graduated, ownedBestAlbum], trackResolver);
    // Exact edition match via SRCL-12539
    const xrefExact = collectionMod.crossReferenceHuntItem(huntItem, idx, graduated.tracks, trackResolver);
    assert.equal(xrefExact.status, 'exact');
    assert.equal(xrefExact.matchedReleases[0].id, graduated.id);

    // Other-edition match (owned Limited/Disc1 SRCL-12999~1, hunting different pressing SRCL-88888 with same title + barcode fallback)
    const huntOther = {
      id: 'hunt-other',
      category: 'J-Pop',
      artist: 'yama',
      title: 'the meaning of life (Limited Edition)',
      catalog: 'SRCL-88888',
      regCatNo: 'SRCL-88888',
      tracks: [
        { disc: 1, mediaType: 'CD', number: 1, title: 'slash', durationMs: 210000 },
        { disc: 1, mediaType: 'CD', number: 2, title: 'Another Song', durationMs: 230000 }
      ]
    };
    const xrefOther = collectionMod.crossReferenceHuntItem(huntOther, idx, huntOther.tracks, trackResolver);
    assert.equal(xrefOther.status, 'other_edition');
    assert.equal(xrefOther.trackOverlap.exactCount, 1); // full "slash" exact match
    assert.equal(xrefOther.trackOverlap.variantCount, 1); // "Another Song" vs "Another Song (TV Size)" -> variant match

    // Base catalog code matching across fullwidth tilde
    const huntBase = { id: 'hunt-base', category: 'J-Pop', artist: 'Someone Else', title: 'Other', regCatNo: 'SRCL-12999', catalog: 'SRCL-12999' };
    const xrefBase = collectionMod.crossReferenceHuntItem(huntBase, idx, [], trackResolver);
    assert.equal(xrefBase.status, 'exact');
  });

  it('plans JSON Merge & Replace imports and non-destructive 11-column Owned Sheet merges', () => {
    const existing = [
      collectionMod.createOwnedRelease({
        id: 'own-lacm-1',
        artist: 'Artist One',
        artistJa: 'アーティスト',
        title: 'First Album',
        category: 'OST',
        catNo: 'LACM-1001',
        editionLabel: '初回盤',
        barcode: '4540774000011',
        mbid: '22222222-2222-4222-8222-222222222222',
        trackSource: 'musicbrainz',
        tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: 'Preserved Local Track' }],
        customCovers: { variants: [{ url: 'https://img.example/keep.jpg', label: 'Keep', source: 'custom' }], selectedIndex: 0 }
      }, 1000),
      collectionMod.createOwnedRelease({
        id: 'own-to-remove',
        artist: 'Old Artist',
        title: 'Removed',
        category: 'OST',
        catNo: 'LACM-9999'
      }, 1000)
    ];

    const exported = collectionMod.exportCollectionJson(existing);
    assert.equal(validateCollection(exported).valid, true);
    assert.equal(exported.items.length, 2);

    // Replace import keeping only LACM-1001 (matched by catNo+editionLabel) and soft-deleting own-to-remove
    const replacePlan = collectionMod.planCollectionJsonImport(
      {
        schemaVersion: 1,
        items: [
          {
            id: 'external-id',
            artist: 'Artist One',
            title: 'First Album',
            category: 'OST',
            catNo: 'lacm-1001',
            editionLabel: '初回盤',
            notes: 'Updated note'
          }
        ]
      },
      existing,
      'replace',
      9000
    );
    assert.equal(replacePlan.ok, true);
    assert.equal(replacePlan.updatedCount, 1);
    assert.equal(replacePlan.deletedCount, 1);
    const updatedRec = replacePlan.toUpsert.find((r) => r.id === 'own-lacm-1');
    const deletedRec = replacePlan.toUpsert.find((r) => r.id === 'own-to-remove');
    assert.equal(updatedRec.notes, 'Updated note');
    assert.equal(deletedRec.deletedAt, 9000);

    // Owned 11-column Sheet CSV round-trip & non-destructive merge preserving tracks/mbid/customCovers
    const matrix = sheetAdapter.buildOwnedSheetRows([existing[0]]);
    assert.equal(matrix[0].length, 11);
    const csvText = matrix.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') +
      '\n"KICM-2002","通常盤 Regular","Game OST","Composer (コンポーザー)","Battle OST","4988003000022","¥1,500","Surugaya","2026-11-24","0","New sheet row"';
    const parsedSheet = sheetAdapter.parseOwnedSheetCsv(csvText);
    assert.equal(parsedSheet.items.length, 2);

    const sheetPlan = collectionMod.planOwnedSheetMerge(
      [
        Object.assign({}, parsedSheet.items[0], { purchasePrice: '¥800', purchaseShop: 'Mandarake', notes: 'Sheet price edit' }),
        parsedSheet.items[1]
      ],
      existing,
      12000
    );
    assert.equal(sheetPlan.updatedCount, 1);
    assert.equal(sheetPlan.addedCount, 1);
    const mergedExisting = sheetPlan.toUpsert.find((r) => r.id === 'own-lacm-1');
    assert.equal(mergedExisting.purchaseShop, 'Mandarake');
    assert.equal(mergedExisting.tracks[0].title, 'Preserved Local Track');
    assert.equal(mergedExisting.mbid, '22222222-2222-4222-8222-222222222222');
    assert.equal(mergedExisting.customCovers.variants[0].url, 'https://img.example/keep.jpg');
  });

  it('looks up candidate releases via MusicBrainz barcode/catno and iTunes fallback', async () => {
    const queue = trackResolver.createRateLimitedQueue({ minIntervalMs: 0 });
    const mockFetchMb = async (url) => {
      if (url.includes('barcode%3A4540774241569')) {
        return {
          ok: true,
          async json() {
            return {
              releases: [{ id: '33333333-3333-4333-8333-333333333333', title: 'Moonlight', barcode: '4540774241569' }]
            };
          }
        };
      }
      if (url.includes('/release/33333333-3333-4333-8333-333333333333')) {
        return {
          ok: true,
          async json() {
            return {
              id: '33333333-3333-4333-8333-333333333333',
              title: 'Moonlight',
              barcode: '4540774241569',
              'artist-credit': [{ name: 'ChouCho' }],
              'label-info': [{ 'catalog-number': 'LACM-24156' }],
              media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Moonlight Track', length: 220000 }] }]
            };
          }
        };
      }
      return { ok: true, async json() { return { releases: [] }; } };
    };

    const mbCandidates = await trackResolver.lookupReleaseCandidates('4540774241569', { fetchImpl: mockFetchMb, queue });
    assert.equal(mbCandidates.length, 1);
    assert.equal(mbCandidates[0].catNo, 'LACM-24156');
    assert.equal(mbCandidates[0].artist, 'ChouCho');
    assert.equal(mbCandidates[0].tracks.length, 1);

    // Fallback to iTunes when MusicBrainz returns nothing
    const mockFetchItunes = async (url) => {
      if (url.startsWith('https://musicbrainz.org')) {
        return { ok: true, async json() { return { releases: [] }; } };
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        return {
          ok: true,
          async json() {
            return { results: [{ collectionId: 901, artistName: 'Minami', collectionName: 'Crying for Rain', artworkUrl100: 'https://img.example/100x100bb.jpg' }] };
          }
        };
      }
      if (url.startsWith('https://itunes.apple.com/lookup')) {
        return {
          ok: true,
          async json() {
            return { results: [{ wrapperType: 'collection' }, { wrapperType: 'track', trackNumber: 1, trackName: 'Kawaki wo Ameku', trackTimeMillis: 251000 }] };
          }
        };
      }
      return { ok: false };
    };
    const itunesCandidates = await trackResolver.lookupReleaseCandidates('Minami Crying', { fetchImpl: mockFetchItunes, queue });
    assert.equal(itunesCandidates.length, 1);
    assert.equal(itunesCandidates[0].trackSource, 'itunes');
    assert.equal(itunesCandidates[0].coverUrl, 'https://img.example/600x600bb.jpg');
    assert.equal(itunesCandidates[0].tracks[0].title, 'Kawaki wo Ameku');
  });

  it('exposes window.DiskCrate.collection alongside strict window.CDHunt alias parity', () => {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    for (const file of ['validate.js', 'cover-resolver.js', 'track-resolver.js', 'collection.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(ROOT_DIR, 'js', file), 'utf8'), sandbox);
    }
    assert.ok(sandbox.DiskCrate.collection.crossReferenceHuntItem);
    assert.equal(sandbox.CDHunt, sandbox.DiskCrate);
  });
});

describe('Frontend Collection Sync Client (js/sync.js)', () => {
  it('paginates GET /api/collection, chunks batches, reconciles LWW conflicts, and catches concurrent seq gaps', async () => {
    const client = dbMod.createDbClient({ indexedDBImpl: null });
    await client.putOwnedRelease({
      id: 'own-dirty-1',
      artist: 'A',
      title: 'Dirty Item',
      category: 'Rock',
      catNo: 'CAT-1',
      clientUpdatedAt: 2000,
      dirty: 1
    });
    await client.putOwnedRelease({
      id: 'own-conflict-stale',
      artist: 'B',
      title: 'Stale Local Edit',
      category: 'Rock',
      catNo: 'CAT-2',
      clientUpdatedAt: 1000,
      dirty: 1
    });

    let getCalls = 0;
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'GET' && u.includes('/api/collection?since=0')) {
        getCalls++;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              items: [{ id: 'own-srv-1', artist: 'S', title: 'Page 1', category: 'OST', catNo: 'SRV-1', clientUpdatedAt: 500, deletedAt: null, syncSeq: 1 }],
              nextCursor: 1,
              hasMore: true,
              latestSeq: 2
            };
          }
        };
      }
      if (method === 'GET' && u.includes('/api/collection?since=1')) {
        getCalls++;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              items: [{ id: 'own-srv-2', artist: 'S2', title: 'Page 2', category: 'OST', catNo: 'SRV-2', clientUpdatedAt: 600, deletedAt: null, syncSeq: 2 }],
              nextCursor: 2,
              hasMore: false,
              latestSeq: 2
            };
          }
        };
      }
      // Follow-up pull triggered when another device inserted sync_seq=3 concurrently before our push got sync_seq=4
      if (method === 'GET' && u.includes('/api/collection?since=2')) {
        getCalls++;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              items: [{ id: 'own-concurrent-3', artist: 'C', title: 'Concurrent', category: 'OST', catNo: 'CON-3', clientUpdatedAt: 1900, deletedAt: null, syncSeq: 3 }],
              nextCursor: 4,
              hasMore: false,
              latestSeq: 4
            };
          }
        };
      }
      if (method === 'POST' && u.endsWith('/api/collection/batch')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              accepted: [{ id: 'own-dirty-1', syncSeq: 4, clientUpdatedAt: 2000, deletedAt: null }],
              conflicts: [
                {
                  id: 'own-conflict-stale',
                  reason: 'stale_client_timestamp',
                  serverItem: { id: 'own-conflict-stale', artist: 'B', title: 'Server Newer Edit', category: 'Rock', catNo: 'CAT-2', clientUpdatedAt: 5000, deletedAt: null, syncSeq: 3 }
                }
              ],
              latestSeq: 4
            };
          }
        };
      }
      throw new Error('Unexpected fetch ' + method + ' ' + u);
    };

    const res = await syncMod.syncOwnedCollection(client, 'https://sync.example', 'tok', mockFetch);
    assert.equal(res.ok, true);
    assert.equal(getCalls, 3);
    assert.equal(res.latestSeq, 4);
    assert.equal(res.conflictCount, 1);

    const dirtyLeft = await client.getDirtyOwnedReleases();
    assert.equal(dirtyLeft.length, 0);
    assert.equal((await client.getOwnedRelease('own-conflict-stale')).title, 'Server Newer Edit');
    assert.equal((await client.getOwnedRelease('own-concurrent-3')).catNo, 'CON-3');
    assert.equal((await client.getSyncMeta('collectionSync')).lastSyncSeq, 4);

    // Verify 429, 503, and Sheet sync error paths cleanly
    const rateRes = await syncMod.pushCollectionBatch('https://sync.example', 'tok', [{ id: 'x', clientUpdatedAt: 1, deletedAt: 1 }], async () => ({
      ok: false,
      status: 429,
      async json() { return { retryAfterSeconds: 45 }; }
    }), { keepalive: true });
    assert.equal(rateRes.rateLimited, true);
    assert.equal(rateRes.retryAfterSeconds, 45);

    const sheetSkipped = await syncMod.pushOwnedSheetSync('https://sync.example', 'tok', 'https://docs.google.com/spreadsheets/d/abc/edit', async () => ({
      ok: true,
      status: 200,
      async json() { return { ok: false, skipped: true, reason: 'service_account_not_configured' }; }
    }));
    assert.equal(sheetSkipped.skipped, true);
  });
});
