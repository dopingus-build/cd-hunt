'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dbMod = require('../js/db.js');
const scannerManagerMod = require('../js/scanner-manager.js');
const scannerWorkerMod = require('../js/scanner-worker.js');

const MANAGER_PATH = path.join(__dirname, '..', 'js', 'scanner-manager.js');
const UI_PATH = path.join(__dirname, '..', 'js', 'scanner-ui.js');

function makeMockCacheStorage() {
  const buckets = new Map();
  return {
    async has(name) {
      return buckets.has(name);
    },
    async open(name) {
      if (!buckets.has(name)) {
        buckets.set(name, new Map());
      }
      const map = buckets.get(name);
      return {
        async put(key, response) {
          const urlKey = typeof key === 'string' ? key : key.url;
          const bytes = Buffer.from(await response.arrayBuffer());
          const headers = new Map();
          if (response.headers && typeof response.headers.forEach === 'function') {
            response.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
          }
          map.set(urlKey, { bytes, headers, status: response.status || 200 });
        },
        async match(key) {
          const urlKey = typeof key === 'string' ? key : key.url;
          const hit = map.get(urlKey);
          if (!hit) return undefined;
          return {
            ok: true,
            status: hit.status,
            headers: { get: (k) => hit.headers.get(String(k).toLowerCase()) || null },
            async arrayBuffer() {
              return hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength);
            },
            async json() {
              return JSON.parse(hit.bytes.toString('utf8'));
            }
          };
        },
        async delete(key) {
          const urlKey = typeof key === 'string' ? key : key.url;
          return map.delete(urlKey);
        }
      };
    },
    async delete(name) {
      return buckets.delete(name);
    },
    _buckets: buckets
  };
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map
  };
}

describe('Phase 3a Scanner Manifest, Manager, Integrity Verification & Wipe', () => {
  it('validates manifest schema, safe relative paths, hex digests, base URL overrides, and byte formatting', async () => {
    const { buildEngineShellWasmBytes, buildScannerManifest } = await import('../scripts/build-scanner-assets.mjs');
    const wasmBytes = buildEngineShellWasmBytes();
    const manifest = buildScannerManifest(wasmBytes);

    assert.deepEqual(scannerManagerMod.validateManifest(manifest), { valid: true, errors: [] });

    // Reject path traversal, bad sha256, duplicate pack ids, and wrong schemaVersion
    const badSchema = scannerManagerMod.validateManifest(Object.assign({}, manifest, { schemaVersion: 2 }));
    assert.equal(badSchema.valid, false);

    const dupIds = scannerManagerMod.validateManifest({
      schemaVersion: 1,
      packs: [manifest.packs[0], manifest.packs[0]]
    });
    assert.equal(dupIds.valid, false);
    assert.ok(dupIds.errors.some((e) => e.includes('duplicate')));

    const traversal = scannerManagerMod.validateManifest({
      schemaVersion: 1,
      packs: [
        {
          id: 'bad-pack',
          totalBytes: 10,
          files: [{ path: '../evil.wasm', bytes: 10, sha256: 'a'.repeat(64) }]
        }
      ]
    });
    assert.equal(traversal.valid, false);

    const badSha = scannerManagerMod.validateManifest({
      schemaVersion: 1,
      packs: [
        {
          id: 'bad-sha',
          totalBytes: 10,
          files: [{ path: 'ok.wasm', bytes: 10, sha256: 'not-hex' }]
        }
      ]
    });
    assert.equal(badSha.valid, false);

    // Base URL resolution: allow relative ./ & https://, reject javascript:/data:
    assert.equal(scannerManagerMod.resolveScannerAssetsBaseUrl('', {}), './scanner-assets/v1/');
    assert.equal(scannerManagerMod.resolveScannerAssetsBaseUrl('?scannerAssets=./custom/assets', {}), './custom/assets/');
    assert.equal(
      scannerManagerMod.resolveScannerAssetsBaseUrl('?scannerAssets=https://example.test/scanner', {}),
      'https://example.test/scanner/'
    );
    assert.equal(scannerManagerMod.resolveScannerAssetsBaseUrl('?scannerAssets=javascript:alert(1)', {}), './scanner-assets/v1/');
    assert.equal(scannerManagerMod.resolveScannerAssetsBaseUrl('?scannerAssets=../escape', {}), './scanner-assets/v1/');

    assert.equal(scannerManagerMod.formatBytes(0), '0 B');
    assert.equal(scannerManagerMod.formatBytes(54), '54 B');
    assert.equal(scannerManagerMod.formatBytes(2048), '2.0 KB');
    assert.equal(scannerManagerMod.formatBytes(5 * 1024 * 1024), '5.00 MB');
  });

  it('detects camera, Worker, WebAssembly, Cache Storage, and native EAN-13 capabilities safely', async () => {
    const fullCaps = await scannerManagerMod.detectCapabilities({
      navigator: { mediaDevices: { getUserMedia() {} } },
      Worker: function () {},
      WebAssembly: {},
      caches: { open() {} },
      BarcodeDetector: {
        async getSupportedFormats() { return ['qr_code', 'ean_13']; }
      }
    });
    assert.deepEqual(fullCaps, {
      getUserMedia: true,
      Worker: true,
      WebAssembly: true,
      caches: true,
      nativeEan13: true
    });

    const missingCaps = await scannerManagerMod.detectCapabilities({
      BarcodeDetector: {
        async getSupportedFormats() { throw new Error('unsupported'); }
      }
    });
    assert.deepEqual(missingCaps, {
      getUserMedia: false,
      Worker: false,
      WebAssembly: false,
      caches: false,
      nativeEan13: false
    });
  });

  it('verifies SHA-256 on pack downloads, rejects tampered bytes with 0 cache writes, works offline, and wipes without touching Hunt/Owned DB', async () => {
    const { buildEngineShellWasmBytes, buildScannerManifest } = await import('../scripts/build-scanner-assets.mjs');
    const validWasm = buildEngineShellWasmBytes();
    const validManifest = buildScannerManifest(validWasm);

    const storage = makeMemoryStorage();
    const cachesImpl = makeMockCacheStorage();
    const dbClient = dbMod.createDbClient({ indexedDBImpl: null });

    // Seed Hunt tracks & Owned release in IndexedDB/fallback to assert Wipe leaves them 100% untouched
    await dbClient.putTrackCache({
      releaseKey: 'catno:cpca-1004',
      catNo: 'CPCA-1004',
      trackSource: 'musicbrainz',
      tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: "Ryu's Theme" }]
    });
    await dbClient.putManualTracks({
      releaseKey: 'catno:cpca-1004',
      trackSource: 'manual',
      tracks: [{ disc: 1, mediaType: 'CD', number: 1, title: 'Custom Track' }]
    });
    await dbClient.putOwnedRelease({
      id: 'own-cpca-1004',
      artist: 'Capcom',
      title: 'Breath of Fire III OST',
      category: 'Game',
      catNo: 'CPCA-1004',
      createdAt: 1000,
      clientUpdatedAt: 1000,
      dirty: 1
    });

    // 1) Tampered bytes -> rejected with ZERO Cache Storage bucket creation
    let serveTampered = true;
    let offline = false;
    const manager = scannerManagerMod.createScannerManager({
      baseUrl: 'https://dopingus-build.github.io/disk-crate/scanner-assets/v1/',
      cachesImpl,
      storage,
      db: dbClient,
      ResponseCtor: Response,
      fetchImpl: async (url) => {
        if (offline) throw new Error('Offline simulated');
        if (String(url).endsWith('manifest.json')) {
          return new Response(JSON.stringify(validManifest), { status: 200 });
        }
        if (String(url).endsWith('engine-shell.wasm')) {
          const payload = serveTampered ? Uint8Array.from(validWasm, (b, idx) => (idx === validWasm.length - 1 ? b ^ 0xff : b)) : validWasm;
          return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
        }
        return new Response('Not found', { status: 404 });
      }
    });

    const mf = await manager.fetchManifest();
    const preStatus = await manager.getPackStatus(mf);
    assert.equal(preStatus.ready, false);
    assert.equal(await cachesImpl.has(scannerManagerMod.CACHE_BUCKET_NAME), false);

    const badDl = await manager.downloadPack('engine-shell', mf);
    assert.equal(badDl.ok, false);
    assert.ok(badDl.error.includes('SHA-256 verification failed'));
    assert.equal(await cachesImpl.has(scannerManagerMod.CACHE_BUCKET_NAME), false);
    assert.equal(storage.getItem(scannerManagerMod.SCANNER_STATE_KEY), null);

    // 2) Valid download -> verified & cached, readable 100% offline
    serveTampered = false;
    const progressEvents = [];
    const goodDl = await manager.downloadAllAvailablePacks(mf, (ev) => progressEvents.push(ev));
    assert.equal(goodDl.ok, true);
    assert.equal(progressEvents.length, 1);
    assert.equal(await cachesImpl.has(scannerManagerMod.CACHE_BUCKET_NAME), true);

    offline = true;
    const offlineMf = await manager.fetchManifest();
    assert.equal(offlineMf.schemaVersion, 1);
    const readyStatus = await manager.getPackStatus(offlineMf);
    assert.equal(readyStatus.ready, true);
    assert.equal(readyStatus.installedBytes, validWasm.length);

    const cachedBytes = await manager.readCachedFileBytes('engine-shell.wasm', mf.packs[0].files[0].sha256);
    assert.equal(Buffer.from(cachedBytes).equals(Buffer.from(validWasm)), true);

    // 3) Per-pack delete & full Wipe with onBeforeWipe hook
    await manager.deletePack('engine-shell', offlineMf);
    assert.equal((await manager.getPackStatus(offlineMf)).ready, false);

    offline = false;
    await manager.downloadPack('engine-shell', mf);
    assert.equal((await manager.getPackStatus(mf)).ready, true);

    let beforeWipeCalled = false;
    const wipeRes = await manager.wipeAll({
      onBeforeWipe: async () => { beforeWipeCalled = true; }
    });
    assert.equal(beforeWipeCalled, true);
    assert.equal(wipeRes.ok, true);
    assert.equal(wipeRes.cacheDeleted, true);
    assert.equal(await cachesImpl.has(scannerManagerMod.CACHE_BUCKET_NAME), false);
    assert.equal(storage.getItem(scannerManagerMod.SCANNER_STATE_KEY), null);

    // Guarantee ZERO damage to Hunt track_cache, manual_tracks, and Owned Collection
    assert.ok(await dbClient.getTrackCache('catno:cpca-1004'));
    assert.ok(await dbClient.getManualTracks('catno:cpca-1004'));
    assert.equal((await dbClient.getAllOwnedReleases()).length, 1);
    assert.equal((await dbClient.getOwnedRelease('own-cpca-1004')).catNo, 'CPCA-1004');
  });

  it('instantiates single-threaded engine-shell.wasm in scanner-worker.js, processes luma telemetry, and shuts down cleanly', async () => {
    const { buildEngineShellWasmBytes } = await import('../scripts/build-scanner-assets.mjs');
    const wasmBytes = buildEngineShellWasmBytes();

    const worker = scannerWorkerMod.createScannerWorkerCore();
    const uninitFrame = await worker.handleMessage({ type: 'frame', sampleLuma: 100 });
    assert.equal(uninitFrame.type, 'error');

    const readyReply = await worker.handleMessage({ type: 'init', wasmBytes, nativeEan13: true });
    assert.deepEqual(readyReply, {
      type: 'ready',
      stage: '3a',
      engineVersion: 1,
      ping: 301,
      nativeEan13: true,
      memoryMode: 'single-threaded-wasm'
    });
    assert.equal(worker.isReady(), true);

    const darkFrame = await worker.handleMessage({ type: 'frame', width: 640, height: 480, sampleLuma: 20 });
    assert.equal(darkFrame.hint, 'low-light');
    assert.equal(darkFrame.framesProcessed, 1);

    const glareFrame = await worker.handleMessage({ type: 'frame', width: 640, height: 480, sampleLuma: 248 });
    assert.equal(glareFrame.hint, 'glare');
    assert.equal(glareFrame.framesProcessed, 2);

    const normalPixels = new Uint8ClampedArray([120, 120, 120, 255, 130, 130, 130, 255]);
    const normalFrame = await worker.handleMessage({ type: 'frame', pixels: normalPixels });
    assert.equal(normalFrame.hint, 'ready');
    assert.equal(normalFrame.luma, 125);
    assert.equal(normalFrame.framesProcessed, 3);

    const stopReply = await worker.handleMessage({ type: 'shutdown' });
    assert.deepEqual(stopReply, { type: 'stopped' });
    assert.equal(worker.isReady(), false);
  });

  it('builds, SHA-256 verifies, and extracts release assets in fetch-scanner-assets.mjs while rejecting tampered tarballs', async () => {
    const { buildEngineShellWasmBytes, buildScannerManifest, sha256HexSync } = await import('../scripts/build-scanner-assets.mjs');
    const { fetchAndVerifyScannerAssets, verifyManifestFilesOnDisk } = await import('../scripts/fetch-scanner-assets.mjs');
    const { execFileSync } = require('node:child_process');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-crate-scanner-test-'));
    try {
      const stageDir = path.join(tmpRoot, 'stage');
      const extractDir = path.join(tmpRoot, 'out');
      const tarPath = path.join(tmpRoot, 'scanner-assets-v1.tar.gz');
      fs.mkdirSync(stageDir, { recursive: true });

      const wasmBytes = buildEngineShellWasmBytes();
      const manifest = buildScannerManifest(wasmBytes);
      fs.writeFileSync(path.join(stageDir, 'engine-shell.wasm'), wasmBytes);
      fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      execFileSync(
        'tar',
        ['-czf', tarPath, '-C', stageDir, 'manifest.json', 'engine-shell.wasm'],
        { env: Object.assign({}, process.env, { COPYFILE_DISABLE: '1' }) }
      );
      const expectedSha = sha256HexSync(fs.readFileSync(tarPath));

      const okRes = await fetchAndVerifyScannerAssets({
        localFile: tarPath,
        outDir: extractDir,
        expectedSha256: expectedSha
      });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.verifiedFiles, 1);
      assert.equal(verifyManifestFilesOnDisk(extractDir).verifiedFiles, 1);

      const badExtractDir = path.join(tmpRoot, 'bad-out');
      await assert.rejects(
        () => fetchAndVerifyScannerAssets({ localFile: tarPath, outDir: badExtractDir, expectedSha256: '0'.repeat(64) }),
        /SHA-256 mismatch/
      );
      assert.equal(fs.existsSync(badExtractDir), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('attaches scannerManager and scannerUI to window.DiskCrate with strict window.CDHunt alias parity', () => {
    const context = { console, URL, URLSearchParams, TextDecoder, TextEncoder };
    context.window = context;
    context.self = context;
    context.globalThis = context;
    vm.createContext(context);

    vm.runInContext(fs.readFileSync(MANAGER_PATH, 'utf8'), context, { filename: MANAGER_PATH });
    vm.runInContext(fs.readFileSync(UI_PATH, 'utf8'), context, { filename: UI_PATH });

    assert.equal(context.DiskCrate, context.CDHunt);
    assert.ok(context.DiskCrate.scannerManager);
    assert.ok(context.DiskCrate.scannerUI);
    assert.equal(context.DiskCrate.scannerManager, context.CDHunt.scannerManager);
    assert.equal(context.DiskCrate.scannerUI, context.CDHunt.scannerUI);
  });
});
