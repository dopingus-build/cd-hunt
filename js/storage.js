/**
 * @fileoverview Sandbox-safe localStorage wrapper, active catalog URL persistence,
 * and deterministic per-catalog storage prefix derivation (window.DiskCrate.storage / legacy alias window.CDHunt.storage / CommonJS).
 */
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

  function fnv1aHex(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Deterministically derive a unique, readable localStorage prefix from catalog context.
   * @param {string | { sourceUrl?: string, fileName?: string, meta?: object, items?: Array }} [context]
   * @returns {string}
   */
  function deriveStoragePrefix(context) {
    let identity = 'default';
    let slugSource = 'catalog';

    if (typeof context === 'string' && context.trim().length > 0) {
      identity = context.trim();
      slugSource = identity;
    } else if (context && typeof context === 'object') {
      const sourceUrl = context.sourceUrl ? String(context.sourceUrl).trim() : '';
      const fileName = context.fileName ? String(context.fileName).trim() : '';
      const title = context.meta && context.meta.title ? String(context.meta.title).trim() : '';
      const itemIds = Array.isArray(context.items)
        ? context.items.map(function (i) { return (i && i.id) || ''; }).join(',')
        : '';

      if (sourceUrl) {
        identity = 'url:' + sourceUrl;
      } else if (fileName) {
        identity = 'file:' + fileName;
      } else {
        identity = 'inline:' + title + ':' + itemIds;
      }
      slugSource = title || fileName || sourceUrl || 'catalog';
    }

    const slug = slugSource
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'catalog';

    return 'cd_hunt_' + slug + '_' + fnv1aHex(identity);
  }

  /**
   * Derive namespaced localStorage keys for a catalog context.
   * @param {string | { sourceUrl?: string, fileName?: string, meta?: object, items?: Array }} [context]
   */
  function getStorageKeys(context) {
    const prefix = deriveStoragePrefix(context);
    return {
      prefix: prefix,
      checklistKey: prefix + '_checklist_v2',
      coverCacheKey: prefix + '_cover_cache_v6',
      viewModeKey: prefix + '_view_mode_v1',
      noteDismissedKey: prefix + '_note_dismissed_v1'
    };
  }

  /**
   * Remove legacy v1-v5 cover cache entries for the active storage context.
   * @param {string | { sourceUrl?: string, fileName?: string, meta?: object, items?: Array }} [context]
   */
  function purgeLegacyCoverCaches(context) {
    const prefix = deriveStoragePrefix(context);
    ['v1', 'v2', 'v3', 'v4', 'v5'].forEach(function (ver) {
      safeRemoveItem(prefix + '_cover_cache_' + ver);
    });
  }

  const CATALOG_URL_KEY = 'cd_hunt_catalog_url_v1';

  /**
   * Read the persisted custom/active catalog metadata URL.
   * @returns {string | null}
   */
  function getActiveCatalogUrl() {
    const val = safeGetItem(CATALOG_URL_KEY);
    return val && val.trim() ? val.trim() : null;
  }

  /**
   * Persist the active catalog metadata URL.
   * @param {string} url
   */
  function setActiveCatalogUrl(url) {
    const trimmed = String(url || '').trim();
    if (trimmed) {
      safeSetItem(CATALOG_URL_KEY, trimmed);
    }
  }

  /**
   * Clear the persisted catalog metadata URL.
   */
  function clearActiveCatalogUrl() {
    safeRemoveItem(CATALOG_URL_KEY);
  }

  const storageApi = {
    CATALOG_URL_KEY: CATALOG_URL_KEY,
    safeGetItem: safeGetItem,
    safeSetItem: safeSetItem,
    safeRemoveItem: safeRemoveItem,
    deriveStoragePrefix: deriveStoragePrefix,
    getStorageKeys: getStorageKeys,
    purgeLegacyCoverCaches: purgeLegacyCoverCaches,
    getActiveCatalogUrl: getActiveCatalogUrl,
    setActiveCatalogUrl: setActiveCatalogUrl,
    clearActiveCatalogUrl: clearActiveCatalogUrl
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.storage = storageApi;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = storageApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
