(function (root) {
  'use strict';

  const memoryStore = {};

  /**
   * Read a value from localStorage with an in-memory fallback for sandboxed contexts.
   * @param {string} key
   * @returns {string | null}
   */
  function safeGetItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
    }
  }

  /**
   * Write a value to localStorage with an in-memory fallback for sandboxed contexts.
   * @param {string} key
   * @param {string} val
   */
  function safeSetItem(key, val) {
    memoryStore[key] = val;
    try {
      window.localStorage.setItem(key, val);
    } catch (e) {
      // Ignore sandboxed storage restrictions
    }
  }

  /**
   * Remove a key from localStorage and the in-memory fallback store.
   * @param {string} key
   */
  function safeRemoveItem(key) {
    delete memoryStore[key];
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      // Ignore
    }
  }

  /**
   * Derive namespaced localStorage keys for a catalog prefix.
   * @param {string} [storagePrefix]
   */
  function getStorageKeys(storagePrefix) {
    const prefix = String(storagePrefix || 'osaka_cd').replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      prefix: prefix,
      checklistKey: prefix + '_checklist_v2',
      coverCacheKey: prefix + '_cover_cache_v6',
      viewModeKey: prefix + '_view_mode_v1',
      noteDismissedKey: prefix + '_note_dismissed_v1'
    };
  }

  /**
   * Remove legacy v1-v5 cover cache entries for the active storage prefix.
   * @param {string} [storagePrefix]
   */
  function purgeLegacyCoverCaches(storagePrefix) {
    const prefix = String(storagePrefix || 'osaka_cd').replace(/[^a-zA-Z0-9_-]/g, '_');
    ['v1', 'v2', 'v3', 'v4', 'v5'].forEach(function (ver) {
      safeRemoveItem(prefix + '_cover_cache_' + ver);
    });
  }

  const storageApi = {
    safeGetItem: safeGetItem,
    safeSetItem: safeSetItem,
    safeRemoveItem: safeRemoveItem,
    getStorageKeys: getStorageKeys,
    purgeLegacyCoverCaches: purgeLegacyCoverCaches
  };

  if (root) {
    root.CDHunt = root.CDHunt || {};
    root.CDHunt.storage = storageApi;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = storageApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
