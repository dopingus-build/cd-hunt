/**
 * @fileoverview Zero-dependency IndexedDB persistence foundation (`disk_crate_db_v1`)
 * for cached and manual release tracklists with automatic in-memory fallback for
 * sandboxed iframes or restricted contexts (window.DiskCrate.db / CommonJS).
 */
(function (root) {
  'use strict';

  const DB_NAME = 'disk_crate_db_v1';
  const DB_VERSION = 2;
  const STORE_TRACK_CACHE = 'track_cache';
  const STORE_MANUAL_TRACKS = 'manual_tracks';
  const STORE_OWNED_RELEASES = 'owned_releases';
  const STORE_SYNC_META = 'sync_meta';

  function normalizeCatNo(raw) {
    return String(raw || '').trim().replace(/[～〜]/g, '~').toUpperCase();
  }

  function normalizeBarcode(raw) {
    return String(raw || '').replace(/[\s-]+/g, '').trim();
  }

  function normalizeOwnedRecord(record) {
    const clean = cloneRecord(record);
    clean.id = String(clean.id).trim();
    if (clean.catNo !== undefined) {
      clean.catNo = normalizeCatNo(clean.catNo);
    }
    if (clean.barcode !== undefined) {
      clean.barcode = normalizeBarcode(clean.barcode);
    }
    clean.dirty = clean.dirty ? 1 : 0;
    if (clean.deletedAt === undefined) {
      clean.deletedAt = null;
    }
    return clean;
  }

  function ensureStoreIndex(store, indexName, keyPath) {
    if (!store || typeof store.createIndex !== 'function') return;
    const exists =
      store.indexNames &&
      typeof store.indexNames.contains === 'function' &&
      store.indexNames.contains(indexName);
    if (!exists) {
      store.createIndex(indexName, keyPath, { unique: false });
    }
  }

  function cloneRecord(value) {
    if (value === undefined || value === null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return value;
    }
  }

  /**
   * Create an IndexedDB persistence client with transparent in-memory fallback.
   * @param {{ indexedDBImpl?: IDBFactory | null, dbName?: string }} [options]
   */
  function createDbClient(options) {
    const opts = options || {};
    const dbName = opts.dbName || DB_NAME;
    const hasExplicitIdb = Object.prototype.hasOwnProperty.call(opts, 'indexedDBImpl');
    const idbFactory = hasExplicitIdb
      ? opts.indexedDBImpl
      : (root && root.indexedDB) || (typeof indexedDB !== 'undefined' ? indexedDB : null);

    const memoryStores = {
      [STORE_TRACK_CACHE]: new Map(),
      [STORE_MANUAL_TRACKS]: new Map(),
      [STORE_OWNED_RELEASES]: new Map(),
      [STORE_SYNC_META]: new Map()
    };

    let usingFallback = !idbFactory || typeof idbFactory.open !== 'function';
    let dbPromise = null;
    let dbInstance = null;

    function getFallbackStore(storeName) {
      if (!memoryStores[storeName]) {
        memoryStores[storeName] = new Map();
      }
      return memoryStores[storeName];
    }

    function openDb() {
      if (usingFallback) return Promise.resolve(null);
      if (dbInstance) return Promise.resolve(dbInstance);
      if (dbPromise) return dbPromise;

      dbPromise = new Promise(function (resolve) {
        let req;
        try {
          req = idbFactory.open(dbName, DB_VERSION);
        } catch (err) {
          usingFallback = true;
          dbPromise = null;
          resolve(null);
          return;
        }

        if (!req) {
          usingFallback = true;
          dbPromise = null;
          resolve(null);
          return;
        }

        req.onupgradeneeded = function (event) {
          const db = (event && event.target && event.target.result) || req.result;
          if (!db) return;
          if (!db.objectStoreNames.contains(STORE_TRACK_CACHE)) {
            db.createObjectStore(STORE_TRACK_CACHE, { keyPath: 'releaseKey' });
          }
          if (!db.objectStoreNames.contains(STORE_MANUAL_TRACKS)) {
            db.createObjectStore(STORE_MANUAL_TRACKS, { keyPath: 'releaseKey' });
          }
          let ownedStore = null;
          if (!db.objectStoreNames.contains(STORE_OWNED_RELEASES)) {
            ownedStore = db.createObjectStore(STORE_OWNED_RELEASES, { keyPath: 'id' });
          } else if (req.transaction && typeof req.transaction.objectStore === 'function') {
            ownedStore = req.transaction.objectStore(STORE_OWNED_RELEASES);
          }
          if (ownedStore) {
            ensureStoreIndex(ownedStore, 'by_catNo', 'catNo');
            ensureStoreIndex(ownedStore, 'by_barcode', 'barcode');
            ensureStoreIndex(ownedStore, 'by_category', 'category');
            ensureStoreIndex(ownedStore, 'by_dirty', 'dirty');
            ensureStoreIndex(ownedStore, 'by_deletedAt', 'deletedAt');
          }
          if (!db.objectStoreNames.contains(STORE_SYNC_META)) {
            db.createObjectStore(STORE_SYNC_META, { keyPath: 'key' });
          }
        };

        req.onsuccess = function () {
          dbInstance = req.result;
          if (dbInstance && typeof dbInstance.onclose !== 'undefined') {
            dbInstance.onclose = function () {
              dbInstance = null;
              dbPromise = null;
            };
          }
          resolve(dbInstance);
        };

        req.onerror = function () {
          usingFallback = true;
          dbInstance = null;
          dbPromise = null;
          resolve(null);
        };
      });

      return dbPromise;
    }

    async function withStore(storeName, mode, idbExecutor, fallbackExecutor) {
      const db = await openDb();
      if (!db) {
        return fallbackExecutor(getFallbackStore(storeName));
      }

      try {
        return await new Promise(function (resolve, reject) {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          let resultVal;

          const req = idbExecutor(store, function (val) { resultVal = val; });
          if (req && !Array.isArray(req)) {
            req.onsuccess = function () {
              resultVal = req.result;
            };
            req.onerror = function () {
              reject(req.error || new Error('IndexedDB request failed'));
            };
          }

          tx.oncomplete = function () {
            resolve(resultVal);
          };
          tx.onerror = function () {
            reject(tx.error || new Error('IndexedDB transaction failed'));
          };
          tx.onabort = function () {
            reject(tx.error || new Error('IndexedDB transaction aborted'));
          };
        });
      } catch (err) {
        usingFallback = true;
        dbInstance = null;
        dbPromise = null;
        return fallbackExecutor(getFallbackStore(storeName));
      }
    }

    function getRecord(storeName, releaseKey) {
      const key = String(releaseKey || '').trim();
      if (!key) return Promise.resolve(null);
      return withStore(
        storeName,
        'readonly',
        function (store) { return store.get(key); },
        function (map) { return map.has(key) ? cloneRecord(map.get(key)) : null; }
      ).then(function (val) {
        return val === undefined ? null : val;
      });
    }

    function putRecord(storeName, record) {
      if (!record || !record.releaseKey) {
        return Promise.resolve(null);
      }
      const clean = cloneRecord(record);
      return withStore(
        storeName,
        'readwrite',
        function (store) { return store.put(clean); },
        function (map) {
          map.set(clean.releaseKey, clean);
          return clean.releaseKey;
        }
      ).then(function () {
        return clean;
      });
    }

    function deleteRecord(storeName, releaseKey) {
      const key = String(releaseKey || '').trim();
      if (!key) return Promise.resolve(false);
      return withStore(
        storeName,
        'readwrite',
        function (store) { return store.delete(key); },
        function (map) { return map.delete(key); }
      ).then(function () {
        return true;
      });
    }

    function getAllRecords(storeName) {
      return withStore(
        storeName,
        'readonly',
        function (store) {
          if (typeof store.getAll === 'function') {
            return store.getAll();
          }
          return null;
        },
        function (map) {
          return Array.from(map.values()).map(cloneRecord);
        }
      ).then(function (res) {
        return Array.isArray(res) ? res : [];
      });
    }

    function queryOwnedByIndexOrScan(indexName, keyValue) {
      return withStore(
        STORE_OWNED_RELEASES,
        'readonly',
        function (store) {
          if (typeof store.index === 'function') {
            try {
              const idx = store.index(indexName);
              if (idx && typeof idx.getAll === 'function') {
                return idx.getAll(keyValue);
              }
            } catch (err) {}
          }
          if (typeof store.getAll === 'function') {
            return store.getAll();
          }
          return null;
        },
        function (map) {
          return Array.from(map.values()).map(cloneRecord);
        }
      ).then(function (res) {
        return Array.isArray(res) ? res : [];
      });
    }

    function getOwnedRelease(id) {
      const key = String(id || '').trim();
      if (!key) return Promise.resolve(null);
      return withStore(
        STORE_OWNED_RELEASES,
        'readonly',
        function (store) { return store.get(key); },
        function (map) { return map.has(key) ? cloneRecord(map.get(key)) : null; }
      ).then(function (val) {
        return val === undefined ? null : val;
      });
    }

    function putOwnedRelease(record) {
      if (!record || !record.id) {
        return Promise.resolve(null);
      }
      const clean = normalizeOwnedRecord(record);
      return withStore(
        STORE_OWNED_RELEASES,
        'readwrite',
        function (store) { return store.put(clean); },
        function (map) {
          map.set(clean.id, clean);
          return clean.id;
        }
      ).then(function () {
        return clean;
      });
    }

    function putOwnedReleasesBatch(records) {
      const list = Array.isArray(records) ? records.filter(function (r) { return r && r.id; }) : [];
      if (list.length === 0) return Promise.resolve([]);
      const cleaned = list.map(normalizeOwnedRecord);
      return withStore(
        STORE_OWNED_RELEASES,
        'readwrite',
        function (store, setResult) {
          for (let i = 0; i < cleaned.length; i++) {
            store.put(cleaned[i]);
          }
          setResult(cleaned);
          return null;
        },
        function (map) {
          for (let i = 0; i < cleaned.length; i++) {
            map.set(cleaned[i].id, cleaned[i]);
          }
          return cleaned;
        }
      ).then(function () {
        return cleaned;
      });
    }

    function deleteOwnedReleaseHard(id) {
      const key = String(id || '').trim();
      if (!key) return Promise.resolve(false);
      return withStore(
        STORE_OWNED_RELEASES,
        'readwrite',
        function (store) { return store.delete(key); },
        function (map) { return map.delete(key); }
      ).then(function () {
        return true;
      });
    }

    function getAllOwnedReleases(opts) {
      const includeDeleted = !!(opts && opts.includeDeleted);
      return getAllRecords(STORE_OWNED_RELEASES).then(function (all) {
        if (includeDeleted) return all;
        return all.filter(function (r) {
          return r && (r.deletedAt === null || r.deletedAt === undefined);
        });
      });
    }

    function getDirtyOwnedReleases() {
      return queryOwnedByIndexOrScan('by_dirty', 1).then(function (rows) {
        return rows.filter(function (r) { return r && r.dirty === 1; });
      });
    }

    function getOwnedReleasesByCatNo(catNo) {
      const norm = normalizeCatNo(catNo);
      if (!norm) return Promise.resolve([]);
      return queryOwnedByIndexOrScan('by_catNo', norm).then(function (rows) {
        return rows.filter(function (r) {
          return r && (r.deletedAt === null || r.deletedAt === undefined) && normalizeCatNo(r.catNo) === norm;
        });
      });
    }

    function getOwnedReleasesByBarcode(barcode) {
      const norm = normalizeBarcode(barcode);
      if (!norm) return Promise.resolve([]);
      return queryOwnedByIndexOrScan('by_barcode', norm).then(function (rows) {
        return rows.filter(function (r) {
          return r && (r.deletedAt === null || r.deletedAt === undefined) && normalizeBarcode(r.barcode) === norm;
        });
      });
    }

    function clearOwnedReleases() {
      return withStore(
        STORE_OWNED_RELEASES,
        'readwrite',
        function (store) { return store.clear(); },
        function (map) { map.clear(); }
      );
    }

    function getSyncMeta(key) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return Promise.resolve(null);
      return withStore(
        STORE_SYNC_META,
        'readonly',
        function (store) { return store.get(cleanKey); },
        function (map) { return map.has(cleanKey) ? cloneRecord(map.get(cleanKey)) : null; }
      ).then(function (row) {
        return row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : null;
      });
    }

    function putSyncMeta(key, value) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return Promise.resolve(null);
      const entry = { key: cleanKey, value: cloneRecord(value) };
      return withStore(
        STORE_SYNC_META,
        'readwrite',
        function (store) { return store.put(entry); },
        function (map) {
          map.set(cleanKey, entry);
          return cleanKey;
        }
      ).then(function () {
        return cloneRecord(value);
      });
    }

    function deleteSyncMeta(key) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return Promise.resolve(false);
      return withStore(
        STORE_SYNC_META,
        'readwrite',
        function (store) { return store.delete(cleanKey); },
        function (map) { return map.delete(cleanKey); }
      ).then(function () {
        return true;
      });
    }

    async function clearTrackStores() {
      await withStore(
        STORE_TRACK_CACHE,
        'readwrite',
        function (store) { return store.clear(); },
        function (map) { map.clear(); }
      );
      await withStore(
        STORE_MANUAL_TRACKS,
        'readwrite',
        function (store) { return store.clear(); },
        function (map) { map.clear(); }
      );
    }

    function close() {
      if (dbInstance && typeof dbInstance.close === 'function') {
        try {
          dbInstance.close();
        } catch (e) {}
      }
      dbInstance = null;
      dbPromise = null;
    }

    return {
      isUsingFallback: function () { return usingFallback; },
      getTrackCache: function (releaseKey) { return getRecord(STORE_TRACK_CACHE, releaseKey); },
      putTrackCache: function (record) { return putRecord(STORE_TRACK_CACHE, record); },
      deleteTrackCache: function (releaseKey) { return deleteRecord(STORE_TRACK_CACHE, releaseKey); },
      getAllTrackCache: function () { return getAllRecords(STORE_TRACK_CACHE); },
      getManualTracks: function (releaseKey) { return getRecord(STORE_MANUAL_TRACKS, releaseKey); },
      putManualTracks: function (record) { return putRecord(STORE_MANUAL_TRACKS, record); },
      deleteManualTracks: function (releaseKey) { return deleteRecord(STORE_MANUAL_TRACKS, releaseKey); },
      getAllManualTracks: function () { return getAllRecords(STORE_MANUAL_TRACKS); },
      clearTrackStores: clearTrackStores,
      getOwnedRelease: getOwnedRelease,
      putOwnedRelease: putOwnedRelease,
      putOwnedReleasesBatch: putOwnedReleasesBatch,
      deleteOwnedReleaseHard: deleteOwnedReleaseHard,
      getAllOwnedReleases: getAllOwnedReleases,
      getDirtyOwnedReleases: getDirtyOwnedReleases,
      getOwnedReleasesByCatNo: getOwnedReleasesByCatNo,
      getOwnedReleasesByBarcode: getOwnedReleasesByBarcode,
      clearOwnedReleases: clearOwnedReleases,
      getSyncMeta: getSyncMeta,
      putSyncMeta: putSyncMeta,
      deleteSyncMeta: deleteSyncMeta,
      close: close
    };
  }

  const defaultClient = createDbClient();
  const dbApi = Object.assign(
    {
      DB_NAME: DB_NAME,
      DB_VERSION: DB_VERSION,
      STORE_TRACK_CACHE: STORE_TRACK_CACHE,
      STORE_MANUAL_TRACKS: STORE_MANUAL_TRACKS,
      STORE_OWNED_RELEASES: STORE_OWNED_RELEASES,
      STORE_SYNC_META: STORE_SYNC_META,
      createDbClient: createDbClient
    },
    defaultClient
  );

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.db = dbApi;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = dbApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
