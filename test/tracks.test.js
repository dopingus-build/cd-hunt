'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { validateCatalog } = require('../js/validate.js');
const dbModule = require('../js/db.js');
const trackResolver = require('../js/track-resolver.js');

const ROOT_DIR = path.join(__dirname, '..');

function makeBaseCatalog(itemOverrides = {}) {
  return {
    schemaVersion: 1,
    meta: { title: 'Unit Test Catalog' },
    items: [
      Object.assign(
        {
          id: 'cd-01',
          category: 'Anime Themes & Chara',
          artist: 'yama',
          title: 'slash',
          catalog: 'SRCL-12539',
          regCatNo: 'SRCL-12539',
          kana: 'ヤ / Y',
          filing: 'Look under ヤ',
          price: '¥500'
        },
        itemOverrides
      )
    ]
  };
}

describe('Phase 1 Schema & Validator Extensions (barcode, mbid, trackSource, tracks[])', () => {
  it('accepts valid barcode, mbid, trackSource, and multi-disc tracks[]', () => {
    const validCatalog = makeBaseCatalog({
      barcode: '4547366611397',
      mbid: '11111111-1111-4111-8111-111111111111',
      trackSource: 'catalog',
      tracks: [
        { disc: 1, mediaType: 'CD', number: 1, title: 'slash', titleJa: 'slash', durationMs: 221000 },
        { disc: 1, mediaType: 'CD', number: 2, title: 'Bonus B-Side', artist: 'Guest Vocal', durationMs: 0, notes: 'Instrumental' },
        { disc: 2, mediaType: 'BD', number: 1, title: 'Non-Credit OP', notes: 'Bonus Blu-ray' }
      ]
    });

    assert.deepEqual(validateCatalog(validCatalog), { valid: true, errors: [] });

    // Formatted barcode with hyphens/spaces and empty optional fields also allowed
    const formatted = makeBaseCatalog({ barcode: '454-7366-611397', mbid: '', tracks: [] });
    assert.deepEqual(validateCatalog(formatted), { valid: true, errors: [] });
  });

  it('rejects malformed barcode, mbid, trackSource, tracks[] fields, and prohibited domains inside tracks', () => {
    const cases = [
      { field: 'barcode', obj: { barcode: 'ABC-123' }, substr: '.barcode' },
      { field: 'barcode-num', obj: { barcode: 12345678 }, substr: '.barcode must be a string' },
      { field: 'mbid', obj: { mbid: 'not-a-uuid' }, substr: '.mbid' },
      { field: 'trackSource', obj: { trackSource: 'discogs' }, substr: '.trackSource' },
      { field: 'tracks-array', obj: { tracks: 'nope' }, substr: '.tracks must be an array' },
      { field: 'track-obj', obj: { tracks: ['bad'] }, substr: '.tracks[0] must be an object' },
      { field: 'track-num', obj: { tracks: [{ number: 0, title: 'A' }] }, substr: '.number must be an integer >= 1' },
      { field: 'track-title', obj: { tracks: [{ number: 1, title: '  ' }] }, substr: '.title must be a non-empty string' },
      { field: 'track-disc', obj: { tracks: [{ disc: 0, number: 1, title: 'A' }] }, substr: '.disc must be an integer >= 1' },
      { field: 'track-media', obj: { tracks: [{ mediaType: 'VHS', number: 1, title: 'A' }] }, substr: '.mediaType must be one of' },
      { field: 'track-dur', obj: { tracks: [{ number: 1, title: 'A', durationMs: -5 }] }, substr: '.durationMs must be a non-negative integer' },
      { field: 'track-notes-type', obj: { tracks: [{ number: 1, title: 'A', notes: 42 }] }, substr: '.notes must be a string' },
      { field: 'track-domain', obj: { tracks: [{ number: 1, title: 'Track https://vgmdb.net/album/1' }] }, substr: 'prohibited hotlinked domain "vgmdb.net"' }
    ];

    for (const c of cases) {
      const res = validateCatalog(makeBaseCatalog(c.obj));
      assert.equal(res.valid, false, `Expected ${c.field} to fail`);
      assert.ok(res.errors.some((e) => e.includes(c.substr)), `Expected error matching "${c.substr}" for ${c.field}, got ${JSON.stringify(res.errors)}`);
    }
  });
});

describe('IndexedDB foundation & sandbox fallback (js/db.js)', () => {
  it('operates cleanly with in-memory fallback when indexedDB is unavailable or throws SecurityError', async () => {
    const clientNoIdb = dbModule.createDbClient({ indexedDBImpl: null });
    assert.equal(clientNoIdb.isUsingFallback(), true);
    assert.equal(await clientNoIdb.getTrackCache('catno:A-1'), null);

    await clientNoIdb.putTrackCache({ releaseKey: 'catno:A-1', trackSource: 'musicbrainz', tracks: [{ number: 1, title: 'Song 1' }] });
    await clientNoIdb.putManualTracks({ releaseKey: 'catno:A-1', trackSource: 'manual', tracks: [{ number: 1, title: 'Edited' }] });

    const cached = await clientNoIdb.getTrackCache('catno:A-1');
    const manual = await clientNoIdb.getManualTracks('catno:A-1');
    assert.equal(cached.tracks[0].title, 'Song 1');
    assert.equal(manual.tracks[0].title, 'Edited');

    // Deep-cloned reads isolate caller mutations
    cached.tracks[0].title = 'Mutated';
    assert.equal((await clientNoIdb.getTrackCache('catno:A-1')).tracks[0].title, 'Song 1');

    assert.equal((await clientNoIdb.getAllTrackCache()).length, 1);
    assert.equal((await clientNoIdb.getAllManualTracks()).length, 1);

    await clientNoIdb.deleteManualTracks('catno:A-1');
    assert.equal(await clientNoIdb.getManualTracks('catno:A-1'), null);
    await clientNoIdb.clearTrackStores();
    assert.deepEqual(await clientNoIdb.getAllTrackCache(), []);

    // Throwing SecurityError on indexedDB.open triggers fallback seamlessly
    const throwingClient = dbModule.createDbClient({
      indexedDBImpl: {
        open() {
          throw new Error('SecurityError: blocked');
        }
      }
    });
    await throwingClient.putTrackCache({ releaseKey: 'catno:B-2', tracks: [{ number: 1, title: 'Safe' }] });
    assert.equal(throwingClient.isUsingFallback(), true);
    assert.equal((await throwingClient.getTrackCache('catno:B-2')).tracks[0].title, 'Safe');
  });

  it('persists and reads track_cache and manual_tracks through IndexedDB API lifecycle', async () => {
    const backing = new Map();
    const makeReq = () => ({ result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null });
    let closeCount = 0;

    const fakeIdb = {
      open(name) {
        const req = makeReq();
        queueMicrotask(() => {
          if (!backing.has(name)) backing.set(name, new Map());
          const stores = backing.get(name);
          const dbObj = {
            objectStoreNames: { contains: (s) => stores.has(s) },
            createObjectStore: (s) => { if (!stores.has(s)) stores.set(s, new Map()); return {}; },
            close: () => { closeCount++; },
            transaction(storeName) {
              const map = stores.get(storeName);
              const tx = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore() {
                  return {
                    get(k) {
                      const r = makeReq();
                      queueMicrotask(() => { r.result = map.get(k); if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); });
                      return r;
                    },
                    put(v) {
                      const r = makeReq();
                      queueMicrotask(() => { map.set(v.releaseKey, v); r.result = v.releaseKey; if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); });
                      return r;
                    },
                    delete(k) {
                      const r = makeReq();
                      queueMicrotask(() => { map.delete(k); if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); });
                      return r;
                    },
                    getAll() {
                      const r = makeReq();
                      queueMicrotask(() => { r.result = Array.from(map.values()); if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); });
                      return r;
                    },
                    clear() {
                      const r = makeReq();
                      queueMicrotask(() => { map.clear(); if (r.onsuccess) r.onsuccess(); if (tx.oncomplete) tx.oncomplete(); });
                      return r;
                    }
                  };
                }
              };
              return tx;
            }
          };
          req.result = dbObj;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: dbObj } });
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      }
    };

    const clientA = dbModule.createDbClient({ indexedDBImpl: fakeIdb, dbName: 'test_idb_1' });
    await clientA.putTrackCache({ releaseKey: 'catno:X-1', trackSource: 'musicbrainz', tracks: [{ number: 1, title: 'IDB Song' }] });
    assert.equal(clientA.isUsingFallback(), false);
    clientA.close();
    assert.equal(closeCount, 1);

    const clientB = dbModule.createDbClient({ indexedDBImpl: fakeIdb, dbName: 'test_idb_1' });
    const restored = await clientB.getTrackCache('catno:X-1');
    assert.equal(restored.tracks[0].title, 'IDB Song');
  });
});

describe('Track key derivation, duration formatting, provenance precedence, & rate limiter (js/track-resolver.js)', () => {
  it('derives deterministic release keys in priority order (mbid > regCatNo/mbEditions > barcode > fallback)', () => {
    assert.equal(
      trackResolver.deriveTrackReleaseKey({
        id: 'x',
        mbid: '11111111-1111-4111-8111-111111111111',
        regCatNo: 'LACM-24156',
        barcode: '4540774241569'
      }),
      'mbid:11111111-1111-4111-8111-111111111111'
    );
    assert.equal(
      trackResolver.deriveTrackReleaseKey({ id: 'x', regCatNo: 'cpca-1043～4' }),
      'catno:CPCA-1043~4'
    );
    assert.equal(
      trackResolver.deriveTrackReleaseKey({ id: 'x', regCatNo: 'DIGITAL-ONLY', barcode: '4988001234567', digitalOnly: false }),
      'barcode:4988001234567'
    );
    assert.equal(
      trackResolver.deriveTrackReleaseKey({ id: 'dig-01', digitalOnly: true, regCatNo: 'DIGITAL-ONLY', artist: 'Hanatan (花たん)', titleJa: 'gradation' }),
      'item:hanatan 花たん|gradation'
    );
  });

  it('formats durations into m:ss and h:mm:ss cleanly', () => {
    assert.equal(trackResolver.formatDurationMs(252000), '4:12');
    assert.equal(trackResolver.formatDurationMs(3723000), '1:02:03');
    assert.equal(trackResolver.formatDurationMs(0), '');
    assert.equal(trackResolver.formatDurationMs(null), '');
  });

  it('enforces 3-layer precedence: manual override > catalog embedded > auto-fetched cache', () => {
    const itemWithTracks = makeBaseCatalog({
      tracks: [{ number: 1, title: 'Catalog Track' }]
    }).items[0];
    const manualRecord = { releaseKey: 'catno:SRCL-12539', trackSource: 'manual', tracks: [{ number: 1, title: 'Manual Track' }] };
    const cacheRecord = { releaseKey: 'catno:SRCL-12539', trackSource: 'musicbrainz', sourceDetail: 'SRCL-12539', tracks: [{ number: 1, title: 'MB Track' }] };

    const layer1 = trackResolver.resolveEffectiveTracks(itemWithTracks, { manualRecord, cacheRecord });
    assert.equal(layer1.trackSource, 'manual');
    assert.equal(layer1.isOverride, true);
    assert.equal(layer1.tracks[0].title, 'Manual Track');

    const layer2 = trackResolver.resolveEffectiveTracks(itemWithTracks, { manualRecord: null, cacheRecord });
    assert.equal(layer2.trackSource, 'catalog');
    assert.equal(layer2.isOverride, false);
    assert.equal(layer2.tracks[0].title, 'Catalog Track');

    const itemBare = makeBaseCatalog().items[0];
    const layer3 = trackResolver.resolveEffectiveTracks(itemBare, { manualRecord: null, cacheRecord });
    assert.equal(layer3.trackSource, 'musicbrainz');
    assert.equal(layer3.sourceDetail, 'SRCL-12539');
    assert.equal(layer3.tracks[0].title, 'MB Track');
  });

  it('enforces >= 1100ms polite spacing between consecutive MusicBrainz queue calls', async () => {
    let fakeNow = 10000;
    const sleeps = [];
    const callTimes = [];

    const queue = trackResolver.createRateLimitedQueue({
      minIntervalMs: 1100,
      nowFn: () => fakeNow,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      }
    });

    await Promise.all([
      queue.schedule(async () => { callTimes.push(fakeNow); fakeNow += 150; return 'a'; }),
      queue.schedule(async () => { callTimes.push(fakeNow); return 'b'; }),
      queue.schedule(async () => { throw new Error('transient'); }).catch(() => {}),
      queue.schedule(async () => { callTimes.push(fakeNow); return 'c'; })
    ]);

    assert.equal(callTimes.length, 3);
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1100));
    assert.ok(callTimes[1] - callTimes[0] >= 1100, `Expected >= 1100ms spacing, got ${callTimes[1] - callTimes[0]}`);
  });
});

describe('MusicBrainz & iTunes Track Fetching (js/track-resolver.js)', () => {
  it('resolves multi-disc MusicBrainz tracklists via fullwidth tilde + base-disc fallback and strips matching solo artist', async () => {
    const requestedUrls = [];
    const queue = trackResolver.createRateLimitedQueue({ minIntervalMs: 0 });

    const fetchImpl = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('query=catno%3ACPCA-1043~4')) {
        return { ok: true, status: 200, async json() { return { releases: [] }; } };
      }
      if (u.includes('query=catno%3ACPCA-1043')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              releases: [
                { id: '22222222-2222-4222-8222-222222222222', title: 'BOF IV OST', status: 'Official', 'label-info': [{ 'catalog-number': 'CPCA-1043~4' }] }
              ]
            };
          }
        };
      }
      if (u.includes('22222222-2222-4222-8222-222222222222')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'Breath of Fire IV OST',
              'label-info': [{ 'catalog-number': 'CPCA-1043~4' }],
              media: [
                {
                  position: 1,
                  format: 'CD',
                  tracks: [
                    { position: 1, title: 'The End and The Beginning', length: 185000, 'artist-credit': [{ name: 'カプコン' }] }
                  ]
                },
                {
                  position: 2,
                  format: 'Blu-ray Disc',
                  tracks: [
                    { position: 1, title: 'Ending Vocal', length: 240000, 'artist-credit': [{ name: 'Special Singer' }] }
                  ]
                }
              ]
            };
          }
        };
      }
      return { ok: true, status: 200, async json() { return { releases: [] }; } };
    };

    const item = {
      id: 'bof4',
      artist: 'Capcom (カプコン)',
      artistJa: 'カプコン',
      title: 'Breath of Fire IV OST',
      regCatNo: 'CPCA-1043～4',
      mbEditions: [{ catno: 'CPCA-1043～4', label: 'Regular' }]
    };

    const res = await trackResolver.fetchTracksForItem(item, { fetchImpl, queue });
    assert.equal(res.trackSource, 'musicbrainz');
    assert.equal(res.sourceDetail, 'CPCA-1043~4');
    assert.equal(res.mbid, '22222222-2222-4222-8222-222222222222');
    assert.equal(res.tracks.length, 2);
    assert.deepEqual(res.tracks[0], { disc: 1, mediaType: 'CD', number: 1, title: 'The End and The Beginning', durationMs: 185000 });
    assert.deepEqual(res.tracks[1], { disc: 2, mediaType: 'BD', number: 1, title: 'Ending Vocal', artist: 'Special Singer', durationMs: 240000 });
  });

  it('falls back to iTunes Search + Lookup for physical CDs without MB data and handles digitalOnly singles directly', async () => {
    const queue = trackResolver.createRateLimitedQueue({ minIntervalMs: 0 });
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('musicbrainz.org')) {
        return { ok: true, status: 200, async json() { return { releases: [] }; } };
      }
      if (u.includes('itunes.apple.com/search') && u.includes('entity=song') && u.includes('gradation')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [{ wrapperType: 'track', trackName: 'gradation', artistName: '花たん', collectionName: 'gradation - Single', trackTimeMillis: 210000 }]
            };
          }
        };
      }
      if (u.includes('itunes.apple.com/search') && u.includes('slash')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [
                { collectionId: 5001, collectionName: 'slash (Limited)', artistName: 'yama' },
                { collectionId: 5002, collectionName: 'slash - Single (通常盤 Regular)', artistName: 'yama' }
              ]
            };
          }
        };
      }
      if (u.includes('itunes.apple.com/lookup?id=5002')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [
                { wrapperType: 'collection', collectionId: 5002 },
                { wrapperType: 'track', discNumber: 1, trackNumber: 1, trackName: 'slash', artistName: 'yama', trackTimeMillis: 221000 },
                { wrapperType: 'track', discNumber: 1, trackNumber: 2, trackName: 'strokes', artistName: 'yama', trackTimeMillis: 198000 }
              ]
            };
          }
        };
      }
      return { ok: true, status: 200, async json() { return { results: [] }; } };
    };

    const physicalRes = await trackResolver.fetchTracksForItem({
      id: 'yama',
      artist: 'yama',
      title: 'slash',
      regCatNo: 'SRCL-12539',
      itunesQuery: 'slash yama',
      requiredGroups: [['slash'], ['yama']]
    }, { fetchImpl, queue });

    assert.equal(physicalRes.trackSource, 'itunes');
    assert.equal(physicalRes.tracks.length, 2);
    assert.equal(physicalRes.tracks[0].title, 'slash');
    assert.equal(physicalRes.tracks[1].durationMs, 198000);

    const digitalRes = await trackResolver.fetchTracksForItem({
      id: 'dig-01',
      digitalOnly: true,
      artist: 'Hanatan',
      artistJa: '花たん',
      title: 'gradation',
      itunesQuery: 'gradation 花たん',
      requiredGroups: [['gradation'], ['hanatan', '花たん']]
    }, { fetchImpl, queue });

    assert.equal(digitalRes.trackSource, 'itunes');
    assert.equal(digitalRes.tracks.length, 1);
    assert.equal(digitalRes.tracks[0].mediaType, 'Digital');
    assert.equal(digitalRes.tracks[0].title, 'gradation');
  });
});

describe('Smart Paste Parser & Variant-Aware Track Matcher (js/track-resolver.js)', () => {
  it('parses multi-disc, numbered, tabbed, and duration text and round-trips through formatTracklistForEdit', () => {
    const pasted = [
      'Disc 1 (CD)',
      '1. Opening Theme (4:12)',
      '02 - Coupling Track [3:58]',
      '03\tEnding Suite\tGuest Vocal\t1:02:03',
      '',
      'Disc 2 (Blu-ray)',
      'Live Digest 15:30'
    ].join('\n');

    const parsed = trackResolver.parseTracklistText(pasted);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0], { disc: 1, mediaType: 'CD', number: 1, title: 'Opening Theme', durationMs: 252000 });
    assert.deepEqual(parsed[1], { disc: 1, mediaType: 'CD', number: 2, title: 'Coupling Track', durationMs: 238000 });
    assert.deepEqual(parsed[2], { disc: 1, mediaType: 'CD', number: 3, title: 'Ending Suite', artist: 'Guest Vocal', durationMs: 3723000 });
    assert.deepEqual(parsed[3], { disc: 2, mediaType: 'BD', number: 1, title: 'Live Digest', durationMs: 930000 });

    const serialized = trackResolver.formatTracklistForEdit(parsed);
    const reparsed = trackResolver.parseTracklistText(serialized);
    assert.deepEqual(reparsed, parsed);
  });

  it('classifies track variants accurately and separates vocal vs instrumental/short/alternate overlap', () => {
    assert.equal(trackResolver.classifyTrackVariant('ホウキボシ'), 'vocal');
    assert.equal(trackResolver.classifyTrackVariant('ホウキボシ (Instrumental)'), 'instrumental');
    assert.equal(trackResolver.classifyTrackVariant('slash -Off Vocal Ver.-'), 'instrumental');
    assert.equal(trackResolver.classifyTrackVariant('青い記憶 (TV Size)'), 'short');
    assert.equal(trackResolver.classifyTrackVariant('スタート! (Acoustic Ver.)'), 'alternate');
    assert.equal(trackResolver.classifyTrackVariant('Bonus Song', 'Off Vocal'), 'instrumental');

    const targetTracks = [
      { number: 1, title: 'Houkiboshi', titleJa: 'ホウキボシ' },
      { number: 2, title: 'Houkiboshi (Instrumental)', titleJa: 'ホウキボシ (Instrumental)' },
      { number: 3, title: 'Aoi Kioku (TV Size)' },
      { number: 4, title: 'Brand New Coupling' }
    ];
    const ownedTracks = [
      { number: 1, title: 'ホウキボシ' },
      { number: 2, title: 'Aoi Kioku' },
      { number: 3, title: 'Unrelated Song' }
    ];

    const cmp = trackResolver.compareTrackLists(targetTracks, ownedTracks);
    assert.equal(cmp.total, 4);
    assert.equal(cmp.exactCount, 1);   // Full vocal Houkiboshi <-> ホウキボシ
    assert.equal(cmp.variantCount, 2); // Instrumental Houkiboshi vs full vocal, TV Size Aoi Kioku vs full vocal
    assert.equal(cmp.matches[0].matchType, 'exact');
    assert.equal(cmp.matches[1].matchType, 'variant');
    assert.equal(cmp.matches[2].matchType, 'variant');
    assert.equal(cmp.matches[3].matchType, 'none');
  });

  it('exposes DiskCrate.db and DiskCrate.trackResolver alongside legacy CDHunt alias in browser context', () => {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    for (const file of ['js/storage.js', 'js/db.js', 'js/cover-resolver.js', 'js/track-resolver.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(ROOT_DIR, file), 'utf8'), sandbox);
    }
    assert.equal(sandbox.window.DiskCrate, sandbox.window.CDHunt);
    assert.equal(typeof sandbox.window.DiskCrate.db.getTrackCache, 'function');
    assert.equal(typeof sandbox.window.DiskCrate.trackResolver.compareTrackLists, 'function');
    assert.equal(sandbox.window.CDHunt.db, sandbox.window.DiskCrate.db);
    assert.equal(sandbox.window.CDHunt.trackResolver, sandbox.window.DiskCrate.trackResolver);
  });

  it('covers lookupReleaseCandidates barcode, catno, text search, iTunes fallback, and parser edge cases', async () => {
    const queue = { schedule(fn) { return fn(); } };

    // Barcode lookup on MusicBrainz
    const barcodeCands = await trackResolver.lookupReleaseCandidates('4547366611397', {
      queue,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('query=barcode%3A4547366611397')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                releases: [
                  { id: '11111111-1111-4111-8111-111111111111', title: 'slash', barcode: '4547366611397', 'artist-credit': [{ name: 'yama' }], 'label-info': [{ 'catalog-number': 'SRCL-12539' }] }
                ]
              };
            }
          };
        }
        if (u.includes('11111111-1111-4111-8111-111111111111')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: '11111111-1111-4111-8111-111111111111',
                title: 'slash',
                'artist-credit': [{ name: 'yama' }],
                'label-info': [{ 'catalog-number': 'SRCL-12539' }],
                media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'slash', length: 210000 }] }]
              };
            }
          };
        }
        return { ok: true, status: 200, async json() { return { results: [] }; } };
      }
    });
    assert.equal(barcodeCands.length, 1);
    assert.equal(barcodeCands[0].catNo, 'SRCL-12539');
    assert.equal(barcodeCands[0].tracks.length, 1);

    // Text lookup -> empty MB -> iTunes album + track fallback
    const itunesCands = await trackResolver.lookupReleaseCandidates('Sol-fa AKFG', {
      queue,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('musicbrainz.org')) {
          return { ok: true, status: 200, async json() { return { releases: [] }; } };
        }
        if (u.includes('itunes.apple.com/search')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { results: [{ collectionId: 999, artistName: 'ASIAN KUNG-FU GENERATION', collectionName: 'Sol-fa', trackCount: 12 }] };
            }
          };
        }
        if (u.includes('itunes.apple.com/lookup?id=999')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                results: [
                  { wrapperType: 'collection', artistName: 'ASIAN KUNG-FU GENERATION', collectionName: 'Sol-fa' },
                  { wrapperType: 'track', discNumber: 1, trackNumber: 1, trackName: 'Rewrite', trackTimeMillis: 225000 }
                ]
              };
            }
          };
        }
        return { ok: false, status: 404 };
      }
    });
    assert.equal(itunesCands.length, 1);
    assert.equal(itunesCands[0].trackSource, 'itunes');
    assert.equal(itunesCands[0].tracks[0].title, 'Rewrite');

    assert.deepEqual(await trackResolver.lookupReleaseCandidates('   '), []);
    assert.deepEqual(trackResolver.parseTracklistText(''), []);
    assert.deepEqual(trackResolver.normalizeTracksList('bad'), []);

    // Catalog number with tilde ('~') fallback query on MusicBrainz -> iTunes empty fallback
    const seenQueries = [];
    const tildeEmpty = await trackResolver.lookupReleaseCandidates('SRCL-12539~40', {
      queue,
      fetchImpl: async (url) => {
        seenQueries.push(String(url));
        return { ok: true, status: 200, async json() { return { releases: [], results: [] }; } };
      }
    });
    assert.deepEqual(tildeEmpty, []);
    assert.ok(seenQueries.some((u) => u.includes('catno%3ASRCL-12539~40')));
    assert.ok(seenQueries.some((u) => u.includes('catno%3ASRCL-12539&')));

    // tryMusicBrainzTracks direct MBID lookup path
    const directRes = await trackResolver.tryMusicBrainzTracks(
      { artist: 'yama', title: 'slash', regCatNo: 'SRCL-12539', barcode: '4547366611397', mbid: '11111111-1111-4111-8111-111111111111' },
      {
        queue,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'slash',
              'artist-credit': [{ name: 'yama' }],
              'label-info': [{ 'catalog-number': 'SRCL-12539' }],
              media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Direct MBID Track', length: 180000 }] }]
            };
          }
        })
      }
    );
    assert.equal(directRes.trackSource, 'musicbrainz');
    assert.equal(directRes.sourceDetail, 'SRCL-12539');

    // tryMusicBrainzTracks multi-candidate scoring + non-matching label fallback path
    const searchSortRes = await trackResolver.tryMusicBrainzTracks(
      { artist: 'yama', title: 'slash', regCatNo: 'SRCL-12539' },
      {
        queue,
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.includes('query=catno%3ASRCL-12539')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  releases: [
                    { id: '22222222-2222-4222-8222-222222222222', status: 'Bootleg', 'label-info': [{ 'catalog-number': 'ALT-999' }] },
                    { id: '33333333-3333-4333-8333-333333333333', status: 'Official', country: 'JP', media: [{}], 'label-info': [{ 'catalog-number': 'SRCL-12539' }] }
                  ]
                };
              }
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: '33333333-3333-4333-8333-333333333333',
                title: 'slash',
                'label-info': [{ 'catalog-number': 'ALT-JP-01' }],
                media: [{ position: 1, format: 'CD', tracks: [{ position: 1, title: 'Sorted Candidate Track', length: 200000 }] }]
              };
            }
          };
        }
      }
    );
    assert.equal(searchSortRes.trackSource, 'musicbrainz');
    assert.equal(searchSortRes.sourceDetail, 'ALT-JP-01');
  });
});
