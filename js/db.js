/**
 * @fileoverview Zero-dependency IndexedDB persistence foundation (`disk_crate_db_v1`)
 * for cached and manual release tracklists with automatic in-memory fallback for
 * sandboxed iframes or restricted contexts (window.DiskCrate.db / CommonJS).
 */
(function (root) {
  'use strict';

  const DB_NAME = 'disk_crate_db_v1';
  const DB_VERSION = 1;
  const STORE_TRACK_CACHE = 'track_cache';
  const STORE_MANUAL_TRACKS = 'manual_tracks';

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
      [STORE_MANUAL_TRACKS]: new Map()
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

          const req = idbExecutor(store);
          if (req) {
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
