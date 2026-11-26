/**
 * @fileoverview Frontend GitHub OAuth session handling, local-first state extraction/merge,
 * and Cloudflare Worker cloud sync helpers (window.DiskCrate.sync / legacy alias window.CDHunt.sync / CommonJS).
 */
(function (root) {
  'use strict';

  const SYNC_TOKEN_KEY = 'cd_hunt_sync_token_v1';
  const SYNC_API_OVERRIDE_KEY = 'cd_hunt_sync_api_url_v1';
  const SYNC_META_KEY = 'cd_hunt_sync_meta_v1';
  const STORAGE_PREFIX_REGEX = /^cd_hunt_[a-z0-9_]+_[0-9a-f]{8}$/;

  const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function decodeBase64UrlUtf8(input) {
    let b64 = String(input || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    while (b64.length % 4 !== 0) b64 += '=';

    const bytes = [];
    for (let i = 0; i < b64.length; i += 4) {
      const c1 = BASE64_CHARS.indexOf(b64[i]);
      const c2 = BASE64_CHARS.indexOf(b64[i + 1]);
      const p3 = b64[i + 2];
      const p4 = b64[i + 3];
      const c3 = p3 === '=' ? 0 : BASE64_CHARS.indexOf(p3);
      const c4 = p4 === '=' ? 0 : BASE64_CHARS.indexOf(p4);
      if (c1 < 0 || c2 < 0 || (p3 !== '=' && c3 < 0) || (p4 !== '=' && c4 < 0)) {
        throw new Error('Invalid base64url character');
      }
      const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
      bytes.push((n >> 16) & 0xff);
      if (p3 !== '=') bytes.push((n >> 8) & 0xff);
      if (p4 !== '=') bytes.push(n & 0xff);
    }

    if (typeof TextDecoder === 'function') {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    let percentEncoded = '';
    for (let i = 0; i < bytes.length; i++) {
      percentEncoded += '%' + bytes[i].toString(16).padStart(2, '0');
    }
    return decodeURIComponent(percentEncoded);
  }

  function cleanLoopbackUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (!/^(?:localhost|127\.0\.0\.1)$/i.test(parsed.hostname)) return '';
      return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch (e) {
      return '';
    }
  }

  function cleanConfigSyncUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol === 'https:') {
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
      }
      if (parsed.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1)$/i.test(parsed.hostname)) {
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Resolve the active Cloudflare Worker URL, allowing loopback overrides for local dev only.
   */
  function resolveSyncApiUrl(locationObj, storageApi, configObj) {
    if (locationObj && locationObj.search && typeof URLSearchParams === 'function') {
      const params = new URLSearchParams(locationObj.search);
      const paramVal = params.get('syncApi');
      if (paramVal !== null) {
        const trimmed = String(paramVal).trim();
        if (trimmed === '' || trimmed === 'off' || trimmed === 'reset') {
          if (storageApi && typeof storageApi.safeRemoveItem === 'function') {
            storageApi.safeRemoveItem(SYNC_API_OVERRIDE_KEY);
          }
        } else {
          const loopback = cleanLoopbackUrl(trimmed);
          if (loopback) {
            if (storageApi && typeof storageApi.safeSetItem === 'function') {
              storageApi.safeSetItem(SYNC_API_OVERRIDE_KEY, loopback);
            }
            return loopback;
          }
        }
      }
    }

    if (storageApi && typeof storageApi.safeGetItem === 'function') {
      const savedOverride = storageApi.safeGetItem(SYNC_API_OVERRIDE_KEY);
      const validLoopback = cleanLoopbackUrl(savedOverride);
      if (validLoopback) return validLoopback;
    }

    return cleanConfigSyncUrl(configObj && configObj.syncApiUrl);
  }

  /**
   * Decode and validate claims of a Disk Crate session JWT on the client (non-cryptographic UX check).
   */
  function parseJwtPayload(token, nowMs) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    try {
      const claims = JSON.parse(decodeBase64UrlUtf8(parts[1]));
      const nowSec = Math.floor((typeof nowMs === 'number' ? nowMs : Date.now()) / 1000);
      if (
        !claims ||
        claims.purpose !== 'session' ||
        !claims.sub ||
        !claims.login ||
        typeof claims.exp !== 'number' ||
        nowSec >= claims.exp
      ) {
        return null;
      }
      return {
        sub: String(claims.sub),
        login: String(claims.login),
        avatarUrl: String(claims.avatarUrl || ''),
        exp: claims.exp
      };
    } catch (e) {
      return null;
    }
  }

  function captureAuthTokenFromHash(locationObj, historyObj, storageApi, nowMs) {
    const hash = locationObj && locationObj.hash ? String(locationObj.hash) : '';
    if (!hash || hash.indexOf('auth_token=') === -1) return null;

    const rawHash = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    const params = typeof URLSearchParams === 'function' ? new URLSearchParams(rawHash) : null;
    const rawToken = params ? params.get('auth_token') : null;
    const user = rawToken ? parseJwtPayload(rawToken, nowMs) : null;

    try {
      if (historyObj && typeof historyObj.replaceState === 'function' && locationObj) {
        const cleanUrl = (locationObj.pathname || '') + (locationObj.search || '');
        historyObj.replaceState(null, '', cleanUrl || '/');
        locationObj.hash = '';
      }
    } catch (e) {
      // Ignore sandboxed history errors
    }

    if (!user) return null;
    if (storageApi && typeof storageApi.safeSetItem === 'function') {
      storageApi.safeSetItem(SYNC_TOKEN_KEY, rawToken);
    }
    return { token: rawToken, user: user };
  }

  function getAuthSession(storageApi, nowMs) {
    if (!storageApi || typeof storageApi.safeGetItem !== 'function') return null;
    const token = storageApi.safeGetItem(SYNC_TOKEN_KEY);
    if (!token) return null;
    const user = parseJwtPayload(token, nowMs);
    if (!user) {
      if (typeof storageApi.safeRemoveItem === 'function') {
        storageApi.safeRemoveItem(SYNC_TOKEN_KEY);
      }
      return null;
    }
    return { token: token, user: user };
  }

  function clearAuthSession(storageApi) {
    if (storageApi && typeof storageApi.safeRemoveItem === 'function') {
      storageApi.safeRemoveItem(SYNC_TOKEN_KEY);
    }
  }

  function buildLoginUrl(syncApiUrl, locationObj) {
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!base) return '';
    const loginUrl = new URL(base + '/auth/login');
    const origin = locationObj && locationObj.origin ? String(locationObj.origin) : '';
    if (/^https?:\/\//i.test(origin)) {
      const redirectTarget = origin + (locationObj.pathname || '/') + (locationObj.search || '');
      loginUrl.searchParams.set('redirect', redirectTarget);
    }
    return loginUrl.toString();
  }

  function normalizeChecklistMap(raw) {
    const map = {};
    if (Array.isArray(raw)) {
      raw.forEach(function (entry) {
        if (entry && entry.id && entry.checked) {
          map[String(entry.id)] = true;
        }
      });
      return map;
    }
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (id) {
        if (raw[id]) map[id] = true;
      });
    }
    return map;
  }

  function extractCustomCovers(coverCache) {
    const customCovers = {};
    const selectedVariants = {};
    if (!coverCache || typeof coverCache !== 'object') {
      return { customCovers: customCovers, selectedVariants: selectedVariants };
    }

    Object.keys(coverCache).forEach(function (itemId) {
      const entry = coverCache[itemId];
      if (!entry || !Array.isArray(entry.variants)) return;
      const customVariants = [];
      let customSel = 0;

      entry.variants.forEach(function (v, idx) {
        if (v && v.source === 'custom' && typeof v.url === 'string' && v.url.trim()) {
          if (idx === (entry.selectedIndex || 0)) {
            customSel = customVariants.length;
          }
          customVariants.push({
            url: v.url,
            label: v.label || 'Custom Jacket',
            catNo: v.catNo || '',
            source: 'custom',
            isRegular: !!v.isRegular
          });
        }
      });

      if (customVariants.length > 0) {
        customCovers[itemId] = { variants: customVariants, selectedIndex: customSel };
      }

      if (entry.variants.length > 0) {
        const activeIdx = Math.max(0, Math.min(entry.selectedIndex || 0, entry.variants.length - 1));
        const activeVar = entry.variants[activeIdx];
        if (activeVar && activeVar.url) {
          selectedVariants[itemId] = { url: activeVar.url, selectedIndex: activeIdx };
        }
      }
    });

    return { customCovers: customCovers, selectedVariants: selectedVariants };
  }

  function mergeCustomCovers(localCache, cloudCustomCovers, cloudSelectedVariants) {
    const merged = {};
    const localObj = localCache && typeof localCache === 'object' ? localCache : {};
    const cloudCustom = cloudCustomCovers && typeof cloudCustomCovers === 'object' ? cloudCustomCovers : {};
    const cloudSelected = cloudSelectedVariants && typeof cloudSelectedVariants === 'object' ? cloudSelectedVariants : {};

    Object.keys(localObj).forEach(function (itemId) {
      const entry = localObj[itemId];
      if (!entry || !Array.isArray(entry.variants)) return;
      merged[itemId] = {
        variants: entry.variants.map(function (v) { return Object.assign({}, v); }),
        selectedIndex: entry.selectedIndex || 0
      };
    });

    Object.keys(cloudCustom).forEach(function (itemId) {
      const cloudEntry = cloudCustom[itemId];
      if (!cloudEntry || !Array.isArray(cloudEntry.variants)) return;
      if (!merged[itemId]) {
        merged[itemId] = { variants: [], selectedIndex: cloudEntry.selectedIndex || 0 };
      }
      const seen = new Set(merged[itemId].variants.map(function (v) { return v && v.url; }));
      cloudEntry.variants.forEach(function (v) {
        if (v && v.url && !seen.has(v.url)) {
          seen.add(v.url);
          merged[itemId].variants.push({
            url: v.url,
            label: v.label || 'Custom Jacket',
            catNo: v.catNo || '',
            source: 'custom',
            isRegular: !!v.isRegular
          });
        }
      });
    });

    Object.keys(cloudSelected).forEach(function (itemId) {
      const sel = cloudSelected[itemId];
      if (!sel || !merged[itemId] || !Array.isArray(merged[itemId].variants)) return;
      const idx = merged[itemId].variants.findIndex(function (v) { return v && v.url === sel.url; });
      if (idx !== -1 && (!localObj[itemId] || !Array.isArray(localObj[itemId].variants) || localObj[itemId].variants.length === 0)) {
        merged[itemId].selectedIndex = idx;
      }
    });

    return merged;
  }

  function mergeCatalogState(localEntry, cloudEntry) {
    if (!cloudEntry) return localEntry;
    if (!localEntry) return cloudEntry;

    const localTs = Number(localEntry.updatedAt) || 0;
    const cloudTs = Number(cloudEntry.updatedAt) || 0;
    const hasLocalBaseline = localTs > 0;
    const localChecklist = normalizeChecklistMap(localEntry.checklist);
    const cloudChecklist = normalizeChecklistMap(cloudEntry.checklist);

    let mergedChecklist;
    if (!hasLocalBaseline) {
      mergedChecklist = Object.assign({}, cloudChecklist, localChecklist);
    } else if (cloudTs > localTs) {
      mergedChecklist = Object.assign({}, cloudChecklist);
    } else {
      mergedChecklist = Object.assign({}, localChecklist);
    }

    const newer = cloudTs > localTs ? cloudEntry : localEntry;
    const mergedSelectedVariants = Object.assign(
      {},
      cloudTs > localTs ? (localEntry.selectedVariants || {}) : (cloudEntry.selectedVariants || {}),
      cloudTs > localTs ? (cloudEntry.selectedVariants || {}) : (localEntry.selectedVariants || {})
    );

    const cloudCoversAsCache = {};
    const cloudCustom = cloudEntry.customCovers || {};
    Object.keys(cloudCustom).forEach(function (id) {
      cloudCoversAsCache[id] = cloudCustom[id];
    });
    const localCoversAsCache = {};
    const localCustom = localEntry.customCovers || {};
    Object.keys(localCustom).forEach(function (id) {
      localCoversAsCache[id] = localCustom[id];
    });
    const mergedCovers = mergeCustomCovers(localCoversAsCache, cloudCoversAsCache, mergedSelectedVariants);
    const extracted = extractCustomCovers(mergedCovers);

    return {
      updatedAt: Math.max(localTs, cloudTs),
      checklist: mergedChecklist,
      customCovers: extracted.customCovers,
      selectedVariants: Object.assign({}, mergedSelectedVariants, extracted.selectedVariants),
      viewMode: newer.viewMode === 'single' ? 'single' : 'grid',
      noteDismissed: !!newer.noteDismissed
    };
  }

  function readSyncMeta(storageApi) {
    const empty = { updatedAt: 0, activeCatalogUrl: null, catalogs: {} };
    if (!storageApi || typeof storageApi.safeGetItem !== 'function') return empty;
    const raw = storageApi.safeGetItem(SYNC_META_KEY);
    if (!raw) return empty;
    try {
      const parsed = JSON.parse(raw);
      return {
        updatedAt: Number(parsed && parsed.updatedAt) || 0,
        activeCatalogUrl: parsed && parsed.activeCatalogUrl ? String(parsed.activeCatalogUrl) : null,
        catalogs: parsed && parsed.catalogs && typeof parsed.catalogs === 'object' ? parsed.catalogs : {}
      };
    } catch (e) {
      return empty;
    }
  }

  function writeSyncMeta(storageApi, meta) {
    if (!storageApi || typeof storageApi.safeSetItem !== 'function') return;
    storageApi.safeSetItem(SYNC_META_KEY, JSON.stringify(meta));
  }

  function markPrefixUpdated(storageApi, prefix, nowMs) {
    if (!prefix || !STORAGE_PREFIX_REGEX.test(prefix)) return 0;
    const ts = typeof nowMs === 'number' ? nowMs : Date.now();
    const meta = readSyncMeta(storageApi);
    meta.updatedAt = ts;
    meta.catalogs[prefix] = ts;
    writeSyncMeta(storageApi, meta);
    return ts;
  }

  function discoverKnownPrefixes(storageApi, syncMeta, activePrefix) {
    const set = new Set();
    if (activePrefix && STORAGE_PREFIX_REGEX.test(activePrefix)) set.add(activePrefix);
    if (syncMeta && syncMeta.catalogs) {
      Object.keys(syncMeta.catalogs).forEach(function (p) {
        if (STORAGE_PREFIX_REGEX.test(p)) set.add(p);
      });
    }
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.length === 'number') {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          const m = k && k.match(/^(cd_hunt_[a-z0-9_]+_[0-9a-f]{8})_checklist_v2$/);
          if (m) set.add(m[1]);
        }
      }
    } catch (e) {
      // Ignore sandboxed storage enumeration
    }
    return Array.from(set);
  }

  function readCatalogEntryFromStorage(storageApi, prefix, updatedAt) {
    if (!storageApi || !STORAGE_PREFIX_REGEX.test(prefix)) return null;
    let checklist = {};
    const rawCheck = storageApi.safeGetItem(prefix + '_checklist_v2');
    if (rawCheck) {
      try {
        checklist = normalizeChecklistMap(JSON.parse(rawCheck));
      } catch (e) {}
    }

    let coverCache = {};
    const rawCache = storageApi.safeGetItem(prefix + '_cover_cache_v6');
    if (rawCache) {
      try {
        coverCache = JSON.parse(rawCache) || {};
      } catch (e) {}
    }

    const extracted = extractCustomCovers(coverCache);
    const viewMode = storageApi.safeGetItem(prefix + '_view_mode_v1') === 'single' ? 'single' : 'grid';
    const noteDismissed = storageApi.safeGetItem(prefix + '_note_dismissed_v1') === '1';

    return {
      updatedAt: Number(updatedAt) || 0,
      checklist: checklist,
      customCovers: extracted.customCovers,
      selectedVariants: extracted.selectedVariants,
      viewMode: viewMode,
      noteDismissed: noteDismissed
    };
  }

  function buildLocalSyncPayload(storageApi, activeCatalogUrl, activePrefix, activeState, nowMs) {
    const ts = typeof nowMs === 'number' ? nowMs : Date.now();
    const meta = readSyncMeta(storageApi);
    const prefixes = discoverKnownPrefixes(storageApi, meta, activePrefix);
    const catalogs = {};

    prefixes.forEach(function (prefix) {
      if (prefix === activePrefix && activeState) {
        const extracted = extractCustomCovers(activeState.coverCache);
        catalogs[prefix] = {
          updatedAt: Number(meta.catalogs[prefix]) || ts,
          checklist: normalizeChecklistMap(activeState.acquiredMap),
          customCovers: extracted.customCovers,
          selectedVariants: extracted.selectedVariants,
          viewMode: activeState.viewMode === 'single' ? 'single' : 'grid',
          noteDismissed: storageApi && storageApi.safeGetItem(prefix + '_note_dismissed_v1') === '1'
        };
      } else {
        const entry = readCatalogEntryFromStorage(storageApi, prefix, meta.catalogs[prefix] || 0);
        if (entry) catalogs[prefix] = entry;
      }
    });

    return {
      schemaVersion: 1,
      updatedAt: Number(meta.updatedAt) || (activePrefix && activeState ? ts : 0),
      activeCatalogUrl: activeCatalogUrl || (storageApi && typeof storageApi.getActiveCatalogUrl === 'function' ? storageApi.getActiveCatalogUrl() : null) || null,
      catalogs: catalogs
    };
  }

  function applySyncedStateToStorage(storageApi, mergedState) {
    if (!mergedState || typeof mergedState !== 'object') return;
    const mergedCatalogs = mergedState.catalogs && typeof mergedState.catalogs === 'object' ? mergedState.catalogs : {};
    const metaCatalogTimestamps = {};

    Object.keys(mergedCatalogs).forEach(function (prefix) {
      if (!STORAGE_PREFIX_REGEX.test(prefix)) return;
      const mergedEntry = mergedCatalogs[prefix];
      if (!mergedEntry || typeof mergedEntry !== 'object') return;
      metaCatalogTimestamps[prefix] = Number(mergedEntry.updatedAt) || 0;

      if (storageApi && typeof storageApi.safeSetItem === 'function') {
        storageApi.safeSetItem(prefix + '_checklist_v2', JSON.stringify(mergedEntry.checklist || {}));

        let existingCache = {};
        const rawLocalCache = storageApi.safeGetItem(prefix + '_cover_cache_v6');
        if (rawLocalCache) {
          try {
            existingCache = JSON.parse(rawLocalCache) || {};
          } catch (e) {}
        }
        const mergedCache = mergeCustomCovers(existingCache, mergedEntry.customCovers, mergedEntry.selectedVariants);
        if (Object.keys(mergedCache).length > 0) {
          storageApi.safeSetItem(prefix + '_cover_cache_v6', JSON.stringify(mergedCache));
        }

        storageApi.safeSetItem(prefix + '_view_mode_v1', mergedEntry.viewMode === 'single' ? 'single' : 'grid');
        if (mergedEntry.noteDismissed) {
          storageApi.safeSetItem(prefix + '_note_dismissed_v1', '1');
        } else if (typeof storageApi.safeRemoveItem === 'function') {
          storageApi.safeRemoveItem(prefix + '_note_dismissed_v1');
        }
      }
    });

    writeSyncMeta(storageApi, {
      updatedAt: Number(mergedState.updatedAt) || 0,
      activeCatalogUrl: mergedState.activeCatalogUrl || null,
      catalogs: metaCatalogTimestamps
    });

    if (
      storageApi &&
      typeof storageApi.getActiveCatalogUrl === 'function' &&
      !storageApi.getActiveCatalogUrl() &&
      mergedState.activeCatalogUrl &&
      typeof storageApi.setActiveCatalogUrl === 'function'
    ) {
      storageApi.setActiveCatalogUrl(mergedState.activeCatalogUrl);
    }
  }

  function mergeAndApplyCloudState(storageApi, localPayload, cloudPayload) {
    const cloud = cloudPayload && typeof cloudPayload === 'object' ? cloudPayload : null;
    if (!cloud) {
      return { merged: localPayload, changedRemote: false };
    }

    const localCatalogs = (localPayload && localPayload.catalogs) || {};
    const cloudCatalogs = (cloud && cloud.catalogs) || {};
    const allPrefixes = new Set(Object.keys(localCatalogs).concat(Object.keys(cloudCatalogs)));
    const mergedCatalogs = {};

    allPrefixes.forEach(function (prefix) {
      if (!STORAGE_PREFIX_REGEX.test(prefix)) return;
      const mergedEntry = mergeCatalogState(localCatalogs[prefix], cloudCatalogs[prefix]);
      if (mergedEntry) {
        mergedCatalogs[prefix] = mergedEntry;
      }
    });

    const localTs = Number(localPayload && localPayload.updatedAt) || 0;
    const cloudTs = Number(cloud && cloud.updatedAt) || 0;
    const mergedActiveUrl = (cloudTs >= localTs ? cloud.activeCatalogUrl : localPayload.activeCatalogUrl) ||
      localPayload.activeCatalogUrl ||
      cloud.activeCatalogUrl ||
      null;

    const merged = {
      schemaVersion: 1,
      updatedAt: Math.max(localTs, cloudTs),
      activeCatalogUrl: mergedActiveUrl,
      catalogs: mergedCatalogs
    };

    applySyncedStateToStorage(storageApi, merged);

    const changedRemote = JSON.stringify(merged) !== JSON.stringify(cloud);
    return { merged: merged, changedRemote: changedRemote };
  }

  async function pullCloudState(syncApiUrl, token, fetchFn) {
    const fn = fetchFn || (root && root.fetch) || (typeof fetch === 'function' ? fetch : null);
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!fn || !base || !token) return { ok: false, offline: true };

    try {
      const res = await fn(base + '/api/state', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token
        }
      });
      if (res.status === 401) return { ok: false, unauthorized: true };
      const body = await res.json().catch(function () { return {}; });
      if (res.status === 503 || (body && body.paused)) {
        return {
          ok: false,
          paused: true,
          reason: (body && body.reason) || 'daily_free_tier_limit_reached',
          resetsAt: (body && body.resetsAt) || null
        };
      }
      if (!res.ok) {
        return { ok: false, error: (body && body.error) || ('HTTP ' + res.status) };
      }
      return {
        ok: true,
        paused: false,
        user: body.user || null,
        state: body.state || null,
        updatedAt: body.updatedAt || null,
        resetsAt: body.resetsAt || null,
        shareToken: body.shareToken || null,
        shareUrl: body.shareUrl || null
      };
    } catch (err) {
      return { ok: false, offline: true, error: err && err.message ? err.message : String(err) };
    }
  }

  async function pushCloudState(syncApiUrl, token, payload, fetchFn, options) {
    const fn = typeof fetchFn === 'function'
      ? fetchFn
      : ((root && root.fetch) || (typeof fetch === 'function' ? fetch : null));
    const opts = options && typeof options === 'object'
      ? options
      : (typeof fetchFn !== 'function' && fetchFn && typeof fetchFn === 'object' ? fetchFn : {});
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!fn || !base || !token) return { ok: false, offline: true };

    try {
      const fetchInit = {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      };
      if (opts.keepalive) {
        fetchInit.keepalive = true;
      }
      const res = await fn(base + '/api/state', fetchInit);
      if (res.status === 401) return { ok: false, unauthorized: true };
      if (res.status === 413) return { ok: false, payloadTooLarge: true };
      const body = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        return {
          ok: false,
          rateLimited: true,
          retryAfterSeconds: (body && body.retryAfterSeconds) || 60
        };
      }
      if (res.status === 503 || (body && body.paused)) {
        return {
          ok: false,
          paused: true,
          reason: (body && body.reason) || 'daily_free_tier_limit_reached',
          resetsAt: (body && body.resetsAt) || null
        };
      }
      if (!res.ok) {
        return { ok: false, error: (body && body.error) || ('HTTP ' + res.status) };
      }
      return {
        ok: true,
        paused: false,
        updatedAt: body.updatedAt || null,
        resetsAt: body.resetsAt || null,
        shareToken: body.shareToken || null,
        shareUrl: body.shareUrl || null,
        sheetSync: body.sheetSync || null
      };
    } catch (err) {
      return { ok: false, offline: true, error: err && err.message ? err.message : String(err) };
    }
  }

  function sanitizeOutgoingCollectionItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.deletedAt !== undefined && item.deletedAt !== null) {
      return {
        id: String(item.id),
        clientUpdatedAt: Number(item.clientUpdatedAt) || Date.now(),
        deletedAt: Number(item.deletedAt)
      };
    }
    const copy = JSON.parse(JSON.stringify(item));
    delete copy.dirty;
    delete copy.syncSeq;
    return copy;
  }

  function chunkCollectionItems(items, maxItemsPerBatch, maxBytesPerBatch) {
    const limitItems = maxItemsPerBatch || 50;
    const limitBytes = maxBytesPerBatch || 98304;
    const chunks = [];
    let current = [];

    for (let i = 0; i < items.length; i++) {
      const clean = sanitizeOutgoingCollectionItem(items[i]);
      if (!clean) continue;
      const candidate = current.concat([clean]);
      const jsonStr = JSON.stringify({ items: candidate });
      const byteLen = typeof TextEncoder === 'function' ? new TextEncoder().encode(jsonStr).length : jsonStr.length * 2;
      if (current.length > 0 && (candidate.length > limitItems || byteLen > limitBytes)) {
        chunks.push(current);
        current = [clean];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async function pullCollectionPage(syncApiUrl, token, sinceSeq, limit, fetchFn) {
    const fn = fetchFn || (root && root.fetch) || (typeof fetch === 'function' ? fetch : null);
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!fn || !base || !token) return { ok: false, offline: true };

    const since = Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(200, limit) : 200;

    try {
      const url = base + '/api/collection?since=' + encodeURIComponent(String(since)) + '&limit=' + encodeURIComponent(String(lim));
      const res = await fn(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token
        }
      });
      if (res.status === 401) return { ok: false, unauthorized: true };
      const body = await res.json().catch(function () { return {}; });
      if (res.status === 503 || (body && body.paused)) {
        return {
          ok: false,
          paused: true,
          reason: (body && body.reason) || 'daily_free_tier_limit_reached',
          resetsAt: (body && body.resetsAt) || null
        };
      }
      if (!res.ok) {
        return { ok: false, error: (body && body.error) || ('HTTP ' + res.status) };
      }
      return {
        ok: true,
        paused: false,
        items: Array.isArray(body.items) ? body.items : [],
        nextCursor: Number(body.nextCursor) || since,
        hasMore: Boolean(body.hasMore),
        latestSeq: Number(body.latestSeq) || 0,
        resetsAt: body.resetsAt || null
      };
    } catch (err) {
      return { ok: false, offline: true, error: err && err.message ? err.message : String(err) };
    }
  }

  async function pullAllCollectionDeltas(syncApiUrl, token, startSeq, fetchFn) {
    let cursor = Number.isInteger(startSeq) && startSeq >= 0 ? startSeq : 0;
    let latestSeq = cursor;
    let resetsAt = null;
    const items = [];

    for (let pageIdx = 0; pageIdx < 200; pageIdx++) {
      const page = await pullCollectionPage(syncApiUrl, token, cursor, 200, fetchFn);
      if (!page.ok) {
        return Object.assign({}, page, { items: items, lastCursor: cursor });
      }
      if (page.items.length > 0) {
        for (let i = 0; i < page.items.length; i++) {
          items.push(page.items[i]);
        }
      }
      if (typeof page.nextCursor === 'number' && page.nextCursor > cursor) {
        cursor = page.nextCursor;
      }
      if (typeof page.latestSeq === 'number' && page.latestSeq > latestSeq) {
        latestSeq = page.latestSeq;
      }
      if (page.resetsAt) resetsAt = page.resetsAt;
      if (!page.hasMore || page.items.length === 0) break;
    }

    return {
      ok: true,
      paused: false,
      items: items,
      lastCursor: cursor,
      latestSeq: latestSeq,
      resetsAt: resetsAt
    };
  }

  async function pushCollectionBatch(syncApiUrl, token, items, fetchFn, options) {
    const fn = typeof fetchFn === 'function'
      ? fetchFn
      : ((root && root.fetch) || (typeof fetch === 'function' ? fetch : null));
    const opts = options && typeof options === 'object'
      ? options
      : (typeof fetchFn !== 'function' && fetchFn && typeof fetchFn === 'object' ? fetchFn : {});
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!fn || !base || !token) return { ok: false, offline: true };

    const outgoing = (Array.isArray(items) ? items : []).map(sanitizeOutgoingCollectionItem).filter(Boolean);
    try {
      const fetchInit = {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ items: outgoing })
      };
      if (opts.keepalive) {
        fetchInit.keepalive = true;
      }
      const res = await fn(base + '/api/collection/batch', fetchInit);
      if (res.status === 401) return { ok: false, unauthorized: true };
      if (res.status === 413) return { ok: false, payloadTooLarge: true };
      const body = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        return {
          ok: false,
          rateLimited: true,
          retryAfterSeconds: (body && body.retryAfterSeconds) || 60
        };
      }
      if (res.status === 503 || (body && body.paused)) {
        return {
          ok: false,
          paused: true,
          reason: (body && body.reason) || 'daily_free_tier_limit_reached',
          resetsAt: (body && body.resetsAt) || null
        };
      }
      if (!res.ok) {
        return { ok: false, error: (body && body.error) || ('HTTP ' + res.status) };
      }
      return {
        ok: true,
        paused: false,
        accepted: Array.isArray(body.accepted) ? body.accepted : [],
        conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
        latestSeq: Number(body.latestSeq) || 0,
        resetsAt: body.resetsAt || null
      };
    } catch (err) {
      return { ok: false, offline: true, error: err && err.message ? err.message : String(err) };
    }
  }

  async function applyPulledServerItems(dbClient, pulledItems) {
    if (!dbClient || !Array.isArray(pulledItems) || pulledItems.length === 0) return 0;
    const allExisting = await dbClient.getAllOwnedReleases({ includeDeleted: true });
    const existingById = new Map();
    allExisting.forEach(function (r) {
      if (r && r.id) existingById.set(r.id, r);
    });

    const toWrite = [];
    for (let i = 0; i < pulledItems.length; i++) {
      const srv = pulledItems[i];
      if (!srv || !srv.id) continue;
      const local = existingById.get(srv.id);
      if (!local || local.dirty !== 1 || Number(srv.clientUpdatedAt) > Number(local.clientUpdatedAt || 0)) {
        toWrite.push(Object.assign({}, srv, { dirty: 0 }));
      }
    }
    if (toWrite.length > 0) {
      await dbClient.putOwnedReleasesBatch(toWrite);
    }
    return toWrite.length;
  }

  async function syncOwnedCollection(dbClient, syncApiUrl, token, fetchFn, options) {
    if (!dbClient || !syncApiUrl || !token) return { ok: false, offline: true };
    const nowMs = Date.now();
    const existingMeta = (await dbClient.getSyncMeta('collectionSync')) || {};
    const startSeq = Number(existingMeta.lastSyncSeq) || 0;

    let currentSeq = startSeq;
    let totalPulled = 0;
    let totalPushed = 0;
    let totalConflicts = 0;
    let resetsAt = null;
    let hasConcurrentGap = false;

    const pullRes = await pullAllCollectionDeltas(syncApiUrl, token, startSeq, fetchFn);
    if (!pullRes.ok) {
      return pullRes;
    }
    totalPulled += await applyPulledServerItems(dbClient, pullRes.items);
    if (pullRes.latestSeq > currentSeq) currentSeq = pullRes.latestSeq;
    if (pullRes.lastCursor > currentSeq) currentSeq = pullRes.lastCursor;
    if (pullRes.resetsAt) resetsAt = pullRes.resetsAt;

    const dirtyList = (await dbClient.getDirtyOwnedReleases()).slice().sort(function (a, b) {
      return (Number(a.clientUpdatedAt) || 0) - (Number(b.clientUpdatedAt) || 0);
    });

    const dirtyById = new Map();
    dirtyList.forEach(function (d) {
      if (d && d.id) dirtyById.set(d.id, d);
    });

    if (dirtyList.length > 0) {
      const chunks = chunkCollectionItems(dirtyList, 50, 98304);
      for (let c = 0; c < chunks.length; c++) {
        const seqBeforePush = currentSeq;
        const pushRes = await pushCollectionBatch(syncApiUrl, token, chunks[c], fetchFn, options);
        if (!pushRes.ok) {
          await dbClient.putSyncMeta('collectionSync', {
            lastSyncSeq: currentSeq,
            lastPulledAt: nowMs,
            lastPushedAt: existingMeta.lastPushedAt || 0,
            lastOwnedSheetUrl: existingMeta.lastOwnedSheetUrl || ''
          });
          return Object.assign({}, pushRes, { pulledCount: totalPulled, pushedCount: totalPushed });
        }

        if (pushRes.resetsAt) resetsAt = pushRes.resetsAt;
        const toAck = [];
        let minAcceptedSeq = Infinity;
        let maxAcceptedSeq = 0;

        pushRes.accepted.forEach(function (acc) {
          if (!acc || !acc.id) return;
          totalPushed++;
          const accSeq = Number(acc.syncSeq) || 0;
          if (accSeq > 0) {
            if (accSeq < minAcceptedSeq) minAcceptedSeq = accSeq;
            if (accSeq > maxAcceptedSeq) maxAcceptedSeq = accSeq;
          }
          const orig = dirtyById.get(acc.id);
          if (orig && (Number(orig.clientUpdatedAt) || 0) <= (Number(acc.clientUpdatedAt) || 0)) {
            toAck.push(
              Object.assign({}, orig, {
                syncSeq: accSeq,
                deletedAt: acc.deletedAt === undefined ? orig.deletedAt : acc.deletedAt,
                dirty: 0
              })
            );
          }
        });

        pushRes.conflicts.forEach(function (conf) {
          if (!conf) return;
          totalConflicts++;
          if (conf.serverItem && conf.serverItem.id) {
            toAck.push(Object.assign({}, conf.serverItem, { dirty: 0 }));
          }
        });

        if (toAck.length > 0) {
          await dbClient.putOwnedReleasesBatch(toAck);
        }

        if (pushRes.accepted.length > 0) {
          if (minAcceptedSeq > seqBeforePush + 1 || maxAcceptedSeq < pushRes.latestSeq) {
            hasConcurrentGap = true;
          } else if (pushRes.latestSeq > currentSeq) {
            currentSeq = pushRes.latestSeq;
          }
        } else if (pushRes.latestSeq > currentSeq) {
          hasConcurrentGap = true;
        }
      }
    }

    if (hasConcurrentGap) {
      const followUp = await pullAllCollectionDeltas(syncApiUrl, token, currentSeq, fetchFn);
      if (followUp.ok) {
        totalPulled += await applyPulledServerItems(dbClient, followUp.items);
        if (followUp.latestSeq > currentSeq) currentSeq = followUp.latestSeq;
        if (followUp.lastCursor > currentSeq) currentSeq = followUp.lastCursor;
      }
    }

    const updatedMeta = {
      lastSyncSeq: currentSeq,
      lastPulledAt: nowMs,
      lastPushedAt: dirtyList.length > 0 ? nowMs : (existingMeta.lastPushedAt || 0),
      lastOwnedSheetUrl: existingMeta.lastOwnedSheetUrl || ''
    };
    await dbClient.putSyncMeta('collectionSync', updatedMeta);

    return {
      ok: true,
      paused: false,
      pulledCount: totalPulled,
      pushedCount: totalPushed,
      conflictCount: totalConflicts,
      latestSeq: currentSeq,
      resetsAt: resetsAt
    };
  }

  async function pushOwnedSheetSync(syncApiUrl, token, googleSheetUrl, fetchFn) {
    const fn = fetchFn || (root && root.fetch) || (typeof fetch === 'function' ? fetch : null);
    const base = cleanConfigSyncUrl(syncApiUrl);
    if (!fn || !base || !token) return { ok: false, offline: true };

    try {
      const res = await fn(base + '/api/collection/sheet-sync', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ googleSheetUrl: googleSheetUrl })
      });
      if (res.status === 401) return { ok: false, unauthorized: true };
      const body = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        return {
          ok: false,
          rateLimited: true,
          retryAfterSeconds: (body && body.retryAfterSeconds) || 60
        };
      }
      if (res.status === 503 || (body && body.paused)) {
        return {
          ok: false,
          paused: true,
          reason: (body && body.reason) || 'daily_free_tier_limit_reached',
          resetsAt: (body && body.resetsAt) || null
        };
      }
      if (body && body.skipped) {
        return { ok: false, skipped: true, reason: body.reason || 'skipped' };
      }
      if (!res.ok || !body.ok) {
        return { ok: false, error: (body && body.error) || ('HTTP ' + res.status) };
      }
      return {
        ok: true,
        writtenRows: Number(body.writtenRows) || 0,
        tabTitle: body.tabTitle || null,
        resetsAt: body.resetsAt || null
      };
    } catch (err) {
      return { ok: false, offline: true, error: err && err.message ? err.message : String(err) };
    }
  }

  const syncApi = {
    SYNC_TOKEN_KEY: SYNC_TOKEN_KEY,
    SYNC_API_OVERRIDE_KEY: SYNC_API_OVERRIDE_KEY,
    SYNC_META_KEY: SYNC_META_KEY,
    resolveSyncApiUrl: resolveSyncApiUrl,
    parseJwtPayload: parseJwtPayload,
    captureAuthTokenFromHash: captureAuthTokenFromHash,
    getAuthSession: getAuthSession,
    clearAuthSession: clearAuthSession,
    buildLoginUrl: buildLoginUrl,
    extractCustomCovers: extractCustomCovers,
    mergeCustomCovers: mergeCustomCovers,
    mergeCatalogState: mergeCatalogState,
    markPrefixUpdated: markPrefixUpdated,
    buildLocalSyncPayload: buildLocalSyncPayload,
    applySyncedStateToStorage: applySyncedStateToStorage,
    mergeAndApplyCloudState: mergeAndApplyCloudState,
    pullCloudState: pullCloudState,
    pushCloudState: pushCloudState,
    pullCollectionPage: pullCollectionPage,
    pullAllCollectionDeltas: pullAllCollectionDeltas,
    pushCollectionBatch: pushCollectionBatch,
    syncOwnedCollection: syncOwnedCollection,
    pushOwnedSheetSync: pushOwnedSheetSync
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.sync = syncApi;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = syncApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
