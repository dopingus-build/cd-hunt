/**
 * @fileoverview Zero-dependency opt-in scanner asset manager (`window.DiskCrate.scannerManager`).
 * Handles manifest validation, explicit opt-in pack downloads, Web Crypto SHA-256 verification,
 * isolated Cache Storage persistence (`disk-crate-scanner-assets-v1`), capability detection,
 * and 1-click wipe without touching Hunt checklists or Owned Collection IndexedDB stores.
 */
(function (root) {
  'use strict';

  const CACHE_BUCKET_NAME = 'disk-crate-scanner-assets-v1';
  const SCANNER_STATE_KEY = 'disk_crate_scanner_meta_v1';
  const DEFAULT_BASE_URL = './scanner-assets/v1/';
  const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
  const PACK_ID_REGEX = /^[a-z0-9-]+$/;

  function normalizeBaseUrlString(rawUrl) {
    const clean = String(rawUrl || '').trim();
    if (!clean) return DEFAULT_BASE_URL;
    return clean.replace(/\/+$/, '') + '/';
  }

  /**
   * Validate `?scannerAssets=` or config override base URL against safe protocols/paths.
   * Allows relative `./` or `/` paths and `http:`/`https:` URLs; rejects `javascript:`, `data:`, etc.
   * @param {string} [locationSearch]
   * @param {{ scannerAssetsBaseUrl?: string }} [config]
   * @returns {string}
   */
  function resolveScannerAssetsBaseUrl(locationSearch, config) {
    const searchStr =
      locationSearch !== undefined && locationSearch !== null
        ? String(locationSearch)
        : (root && root.location && root.location.search) || '';

    if (searchStr) {
      try {
        const params = new URLSearchParams(searchStr);
        const paramVal = String(params.get('scannerAssets') || '').trim();
        if (paramVal) {
          if (paramVal.startsWith('./') || (paramVal.startsWith('/') && !paramVal.startsWith('//'))) {
            if (!paramVal.includes('..')) {
              return normalizeBaseUrlString(paramVal);
            }
          } else {
            const parsed = new URL(paramVal);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              return normalizeBaseUrlString(parsed.href);
            }
          }
        }
      } catch (e) {
        // Ignore invalid override and fall back safely
      }
    }

    if (config && typeof config.scannerAssetsBaseUrl === 'string' && config.scannerAssetsBaseUrl.trim()) {
      return normalizeBaseUrlString(config.scannerAssetsBaseUrl);
    }
    return DEFAULT_BASE_URL;
  }

  function isSafeRelativeFilePath(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) return false;
    const p = relPath.trim();
    if (p.startsWith('/') || p.startsWith('\\') || /^[a-z]+:/i.test(p)) return false;
    if (p.split(/[\\/]/).some(function (seg) { return seg === '..' || seg === '.'; })) return false;
    return true;
  }

  /**
   * Validate a `schemaVersion: 1` scanner asset manifest.
   * @param {any} manifest
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validateManifest(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { valid: false, errors: ['Manifest must be a JSON object'] };
    }
    if (manifest.schemaVersion !== 1) {
      errors.push('manifest.schemaVersion must equal 1');
    }
    if (!Array.isArray(manifest.packs)) {
      errors.push('manifest.packs must be an array');
      return { valid: false, errors: errors };
    }

    const seenIds = new Set();
    manifest.packs.forEach(function (pack, pIdx) {
      const prefix = 'packs[' + pIdx + ']';
      if (!pack || typeof pack !== 'object') {
        errors.push(prefix + ' must be an object');
        return;
      }
      if (typeof pack.id !== 'string' || !PACK_ID_REGEX.test(pack.id)) {
        errors.push(prefix + '.id must match /^[a-z0-9-]+$/');
      } else if (seenIds.has(pack.id)) {
        errors.push(prefix + '.id duplicate "' + pack.id + '"');
      } else {
        seenIds.add(pack.id);
      }

      if (!Number.isInteger(pack.totalBytes) || pack.totalBytes < 0) {
        errors.push(prefix + '.totalBytes must be a non-negative integer');
      }
      if (!Array.isArray(pack.files)) {
        errors.push(prefix + '.files must be an array');
        return;
      }

      pack.files.forEach(function (file, fIdx) {
        const fp = prefix + '.files[' + fIdx + ']';
        if (!file || typeof file !== 'object') {
          errors.push(fp + ' must be an object');
          return;
        }
        if (!isSafeRelativeFilePath(file.path)) {
          errors.push(fp + '.path must be a safe relative path');
        }
        if (!Number.isInteger(file.bytes) || file.bytes < 0) {
          errors.push(fp + '.bytes must be a non-negative integer');
        }
        if (typeof file.sha256 !== 'string' || !SHA256_HEX_REGEX.test(file.sha256)) {
          errors.push(fp + '.sha256 must be a 64-character lowercase hex digest');
        }
      });
    });

    return { valid: errors.length === 0, errors: errors };
  }

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input && typeof input.byteLength === 'number') {
      try {
        return new Uint8Array(input);
      } catch (e) {}
    }
    return new Uint8Array(0);
  }

  /**
   * Compute lowercase hex SHA-256 digest of binary bytes using Web Crypto.
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {Crypto} [cryptoImpl]
   * @returns {Promise<string>}
   */
  async function sha256Hex(buffer, cryptoImpl) {
    const bytes = toUint8Array(buffer);
    const c = cryptoImpl || (root && root.crypto) || (typeof crypto !== 'undefined' ? crypto : null);
    if (!c || !c.subtle || typeof c.subtle.digest !== 'function') {
      throw new Error('Web Crypto subtle.digest is unavailable');
    }
    const digest = await c.subtle.digest('SHA-256', bytes);
    const out = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < out.length; i++) {
      hex += out[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  /**
   * Format byte counts cleanly for opt-in download prompts.
   * @param {number} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /**
   * Feature-detect camera, Worker, WebAssembly, Cache Storage, and native EAN-13 BarcodeDetector.
   * @param {any} [globalObj]
   */
  async function detectCapabilities(globalObj) {
    const g = globalObj || root || (typeof globalThis !== 'undefined' ? globalThis : {});
    const nav = g.navigator || {};
    const hasGetUserMedia = !!(
      nav.mediaDevices &&
      typeof nav.mediaDevices.getUserMedia === 'function'
    );
    const hasWorker = typeof g.Worker === 'function';
    const hasWebAssembly = typeof g.WebAssembly === 'object' && g.WebAssembly !== null;
    const hasCaches = !!(g.caches && typeof g.caches.open === 'function');
    let nativeEan13 = false;

    if (
      (typeof g.BarcodeDetector === 'function' || (typeof g.BarcodeDetector === 'object' && g.BarcodeDetector !== null)) &&
      typeof g.BarcodeDetector.getSupportedFormats === 'function'
    ) {
      try {
        const formats = await g.BarcodeDetector.getSupportedFormats();
        nativeEan13 = Array.isArray(formats) && formats.indexOf('ean_13') !== -1;
      } catch (e) {
        nativeEan13 = false;
      }
    }

    return {
      getUserMedia: hasGetUserMedia,
      Worker: hasWorker,
      WebAssembly: hasWebAssembly,
      caches: hasCaches,
      nativeEan13: nativeEan13
    };
  }

  function makeSafeStorage(storageImpl) {
    if (storageImpl && typeof storageImpl.getItem === 'function') {
      return storageImpl;
    }
    if (root && typeof root.localStorage !== 'undefined') {
      return {
        getItem: function (k) {
          try { return root.localStorage.getItem(k); } catch (e) { return null; }
        },
        setItem: function (k, v) {
          try { root.localStorage.setItem(k, v); } catch (e) {}
        },
        removeItem: function (k) {
          try { root.localStorage.removeItem(k); } catch (e) {}
        }
      };
    }
    const mem = Object.create(null);
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  }

  /**
   * Create an opt-in scanner asset manager bound to isolated Cache Storage & metadata state.
   * @param {Object} [options]
   */
  function createScannerManager(options) {
    const opts = options || {};
    const baseUrl = opts.baseUrl
      ? normalizeBaseUrlString(opts.baseUrl)
      : resolveScannerAssetsBaseUrl(opts.locationSearch, opts.config);
    const locationHref =
      opts.locationHref !== undefined
        ? opts.locationHref
        : (root && root.location && root.location.href) || '';
    const fetchFn =
      typeof opts.fetchImpl === 'function'
        ? opts.fetchImpl
        : (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : (typeof fetch === 'function' ? fetch : null));
    const cachesImpl =
      opts.cachesImpl !== undefined
        ? opts.cachesImpl
        : (root && root.caches) || (typeof caches !== 'undefined' ? caches : null);
    const cryptoImpl = opts.cryptoImpl || (root && root.crypto) || (typeof crypto !== 'undefined' ? crypto : null);
    const storage = makeSafeStorage(opts.storage);

    let lastManifest = null;

    function resolveAssetUrl(relPath) {
      const cleanRel = String(relPath || '').replace(/^\/+/, '');
      if (/^https?:\/\//i.test(baseUrl)) {
        return baseUrl + cleanRel;
      }
      if (locationHref) {
        try {
          const absBase = new URL(baseUrl, locationHref).href;
          return new URL(cleanRel, absBase).href;
        } catch (e) {
          // Fall back cleanly
        }
      }
      return baseUrl + cleanRel;
    }

    function readMetaState() {
      try {
        const raw = storage.getItem(SCANNER_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (e) {
        return null;
      }
    }

    function writeMetaState(nextMeta) {
      try {
        storage.setItem(SCANNER_STATE_KEY, JSON.stringify(nextMeta));
      } catch (e) {}
    }

    async function hasBucket() {
      if (!cachesImpl) return false;
      if (typeof cachesImpl.has === 'function') {
        return cachesImpl.has(CACHE_BUCKET_NAME);
      }
      const meta = readMetaState();
      return !!(meta && meta.packs && Object.keys(meta.packs).length > 0);
    }

    async function openBucketIfPresent() {
      if (!cachesImpl || typeof cachesImpl.open !== 'function') return null;
      const exists = await hasBucket();
      if (!exists) return null;
      return cachesImpl.open(CACHE_BUCKET_NAME);
    }

    async function fetchManifest() {
      const manifestUrl = resolveAssetUrl('manifest.json');
      let fetchError = null;

      if (fetchFn) {
        try {
          const res = await fetchFn(manifestUrl, { cache: 'no-store' });
          if (res && res.ok) {
            const parsed = await res.json();
            const val = validateManifest(parsed);
            if (!val.valid) {
              throw new Error('Invalid scanner manifest: ' + val.errors.join('; '));
            }
            lastManifest = parsed;
            return parsed;
          }
          fetchError = new Error('Manifest HTTP ' + (res ? res.status : 'error'));
        } catch (err) {
          fetchError = err;
        }
      }

      // Offline fallback: read previously verified cached manifest.json if bucket exists
      const bucket = await openBucketIfPresent();
      if (bucket && typeof bucket.match === 'function') {
        const cached = await bucket.match(manifestUrl);
        if (cached && cached.ok) {
          const parsed = await cached.json();
          const val = validateManifest(parsed);
          if (val.valid) {
            lastManifest = parsed;
            return parsed;
          }
        }
      }

      throw fetchError || new Error('Scanner manifest unavailable offline');
    }

    async function getPackStatus(manifest) {
      const mf = manifest || lastManifest;
      if (!mf || !Array.isArray(mf.packs)) {
        return {
          ready: false,
          installedBytes: 0,
          totalAvailableBytes: 0,
          requiredBytes: 0,
          missingRequiredPacks: [],
          packs: [],
          meta: readMetaState()
        };
      }

      const bucket = await openBucketIfPresent();
      const packsStatus = [];
      let installedBytes = 0;
      let totalAvailableBytes = 0;
      let requiredBytes = 0;
      const missingRequiredPacks = [];

      for (let i = 0; i < mf.packs.length; i++) {
        const pack = mf.packs[i];
        const available = pack.available !== false;
        const files = Array.isArray(pack.files) ? pack.files : [];
        if (available) totalAvailableBytes += pack.totalBytes || 0;
        if (available && pack.required) requiredBytes += pack.totalBytes || 0;

        let installed = available && files.length > 0;
        let cachedBytes = 0;

        if (!bucket || !available || files.length === 0) {
          installed = false;
        } else {
          for (let j = 0; j < files.length; j++) {
            const f = files[j];
            const matchRes = await bucket.match(resolveAssetUrl(f.path));
            if (!matchRes) {
              installed = false;
              break;
            }
            cachedBytes += f.bytes || 0;
          }
        }

        if (installed) {
          installedBytes += cachedBytes || pack.totalBytes || 0;
        } else if (available && pack.required) {
          missingRequiredPacks.push(pack.id);
        }

        packsStatus.push({
          id: pack.id,
          title: pack.title || pack.id,
          description: pack.description || '',
          stage: pack.stage || '3a',
          required: !!pack.required,
          available: available,
          version: pack.version || '1.0.0',
          totalBytes: pack.totalBytes || 0,
          files: files,
          installed: installed,
          cachedBytes: installed ? (cachedBytes || pack.totalBytes || 0) : 0
        });
      }

      return {
        ready: missingRequiredPacks.length === 0 && packsStatus.some(function (p) { return p.required && p.installed; }),
        installedBytes: installedBytes,
        totalAvailableBytes: totalAvailableBytes,
        requiredBytes: requiredBytes,
        missingRequiredPacks: missingRequiredPacks,
        packs: packsStatus,
        meta: readMetaState()
      };
    }

    function resolvePackObj(packOrId, manifestArg) {
      if (packOrId && typeof packOrId === 'object' && Array.isArray(packOrId.files)) {
        return packOrId;
      }
      const id = String(packOrId || '');
      const mf = manifestArg || lastManifest;
      if (mf && Array.isArray(mf.packs)) {
        return mf.packs.find(function (p) { return p && p.id === id; }) || null;
      }
      return null;
    }

    async function downloadPack(packOrId, manifestOrProgress, maybeProgress) {
      let manifestArg = manifestOrProgress;
      let onProgress = maybeProgress;
      if (typeof manifestOrProgress === 'function') {
        onProgress = manifestOrProgress;
        manifestArg = null;
      }
      const mf = manifestArg || lastManifest;
      const pack = resolvePackObj(packOrId, mf);
      if (!pack) {
        return { ok: false, error: 'Unknown scanner pack: ' + String(packOrId) };
      }
      if (pack.available === false) {
        return { ok: false, error: 'Pack "' + pack.id + '" is planned for a future stage and not yet published' };
      }
      if (!fetchFn) {
        return { ok: false, error: 'Network fetch is unavailable' };
      }
      if (!cachesImpl || typeof cachesImpl.open !== 'function') {
        return { ok: false, error: 'Cache Storage is unavailable in this browser context' };
      }

      const files = Array.isArray(pack.files) ? pack.files : [];
      const verifiedBuffers = [];
      let totalDownloaded = 0;

      // Integrity gate: download & SHA-256 verify ALL files before writing anything to Cache Storage
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const fileUrl = resolveAssetUrl(f.path);
        let res;
        try {
          res = await fetchFn(fileUrl, { cache: 'no-store' });
        } catch (err) {
          return { ok: false, error: 'Failed to download ' + f.path + ': ' + (err && err.message ? err.message : String(err)) };
        }
        if (!res || !res.ok) {
          return { ok: false, error: 'HTTP ' + (res ? res.status : 'error') + ' downloading ' + f.path };
        }
        const buf = await res.arrayBuffer();
        if (Number.isInteger(f.bytes) && buf.byteLength !== f.bytes) {
          return {
            ok: false,
            error: 'Size mismatch for ' + f.path + ': expected ' + f.bytes + ' bytes, got ' + buf.byteLength
          };
        }
        const actualSha = await sha256Hex(buf, cryptoImpl);
        if (actualSha !== f.sha256) {
          return {
            ok: false,
            error: 'SHA-256 verification failed for ' + f.path
          };
        }

        verifiedBuffers.push({
          file: f,
          url: fileUrl,
          buffer: buf,
          sha256: actualSha
        });
        totalDownloaded += buf.byteLength;
        if (typeof onProgress === 'function') {
          onProgress({ packId: pack.id, completedFiles: i + 1, totalFiles: files.length, bytes: totalDownloaded });
        }
      }

      const ResponseCtor =
        opts.ResponseCtor ||
        (root && typeof root.Response === 'function' ? root.Response : typeof Response === 'function' ? Response : null);
      if (!ResponseCtor) {
        return { ok: false, error: 'Response constructor is unavailable' };
      }

      const bucket = await cachesImpl.open(CACHE_BUCKET_NAME);
      for (let k = 0; k < verifiedBuffers.length; k++) {
        const item = verifiedBuffers[k];
        const headers = {
          'Content-Type': item.file.contentType || 'application/octet-stream',
          'X-Disk-Crate-SHA256': item.sha256
        };
        await bucket.put(item.url, new ResponseCtor(item.buffer, { status: 200, headers: headers }));
      }

      // Cache manifest.json alongside verified packs so offline reopening works without network
      if (mf) {
        await bucket.put(
          resolveAssetUrl('manifest.json'),
          new ResponseCtor(JSON.stringify(mf), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }

      const prevMeta = readMetaState() || { schemaVersion: 1, packs: {} };
      const packsMeta = Object.assign({}, prevMeta.packs || {});
      packsMeta[pack.id] = {
        version: pack.version || '1.0.0',
        bytes: totalDownloaded,
        installedAt: Date.now(),
        sha256Verified: true
      };
      writeMetaState({
        schemaVersion: 1,
        baseUrl: baseUrl,
        updatedAt: Date.now(),
        packs: packsMeta
      });

      return {
        ok: true,
        packId: pack.id,
        bytesDownloaded: totalDownloaded,
        sha256Verified: true
      };
    }

    async function downloadAllAvailablePacks(manifestArg, onProgress) {
      let mf = manifestArg;
      let cb = onProgress;
      if (typeof manifestArg === 'function') {
        cb = manifestArg;
        mf = null;
      }
      const targetMf = mf || lastManifest || (await fetchManifest());
      const available = targetMf.packs.filter(function (p) { return p && p.available !== false; });
      const results = [];
      for (let i = 0; i < available.length; i++) {
        const res = await downloadPack(available[i], targetMf, cb);
        if (!res.ok) return res;
        results.push(res);
      }
      return { ok: true, results: results };
    }

    async function deletePack(packId, manifestArg) {
      const mf = manifestArg || lastManifest;
      const pack = resolvePackObj(packId, mf);
      const bucket = await openBucketIfPresent();
      if (bucket && pack && Array.isArray(pack.files) && typeof bucket.delete === 'function') {
        for (let i = 0; i < pack.files.length; i++) {
          await bucket.delete(resolveAssetUrl(pack.files[i].path));
        }
      }
      const prevMeta = readMetaState();
      if (prevMeta && prevMeta.packs && Object.prototype.hasOwnProperty.call(prevMeta.packs, packId)) {
        const nextPacks = Object.assign({}, prevMeta.packs);
        delete nextPacks[packId];
        writeMetaState(Object.assign({}, prevMeta, { packs: nextPacks, updatedAt: Date.now() }));
      }
      return { ok: true, packId: packId };
    }

    async function readCachedFileBytes(filePath, expectedSha256) {
      const bucket = await openBucketIfPresent();
      if (!bucket || typeof bucket.match !== 'function') return null;
      const res = await bucket.match(resolveAssetUrl(filePath));
      if (!res) return null;
      const buf = await res.arrayBuffer();
      if (expectedSha256) {
        const actualSha = await sha256Hex(buf, cryptoImpl);
        if (actualSha !== expectedSha256) {
          throw new Error('Cached scanner asset corrupted (SHA-256 mismatch) for ' + filePath);
        }
      }
      return buf;
    }

    async function wipeAll(wipeOpts) {
      const wOpts = wipeOpts || {};
      if (typeof wOpts.onBeforeWipe === 'function') {
        await wOpts.onBeforeWipe();
      }
      let cacheDeleted = false;
      if (cachesImpl && typeof cachesImpl.delete === 'function') {
        cacheDeleted = await cachesImpl.delete(CACHE_BUCKET_NAME);
      }
      if (opts.db && typeof opts.db.clearScannerCoverIndex === 'function') {
        await opts.db.clearScannerCoverIndex();
      }
      storage.removeItem(SCANNER_STATE_KEY);
      return {
        ok: true,
        cacheDeleted: !!cacheDeleted
      };
    }

    return {
      CACHE_BUCKET_NAME: CACHE_BUCKET_NAME,
      SCANNER_STATE_KEY: SCANNER_STATE_KEY,
      baseUrl: baseUrl,
      resolveAssetUrl: resolveAssetUrl,
      fetchManifest: fetchManifest,
      getPackStatus: getPackStatus,
      downloadPack: downloadPack,
      downloadAllAvailablePacks: downloadAllAvailablePacks,
      deletePack: deletePack,
      readCachedFileBytes: readCachedFileBytes,
      wipeAll: wipeAll
    };
  }

  const exported = {
    CACHE_BUCKET_NAME: CACHE_BUCKET_NAME,
    SCANNER_STATE_KEY: SCANNER_STATE_KEY,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    resolveScannerAssetsBaseUrl: resolveScannerAssetsBaseUrl,
    validateManifest: validateManifest,
    sha256Hex: sha256Hex,
    formatBytes: formatBytes,
    detectCapabilities: detectCapabilities,
    createScannerManager: createScannerManager
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.scannerManager = exported;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
