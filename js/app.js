/**
 * @fileoverview Main Disk Crate application controller: catalog/repository loading,
 * filtering, state persistence, lazy cover queueing, modals, and Crate Flip lightbox.
 */
(function () {
  'use strict';

  const DiskCrate = window.DiskCrate || window.CDHunt || {};
  const storage = DiskCrate.storage;
  const coverResolver = DiskCrate.coverResolver;
  const db = DiskCrate.db || null;
  const trackResolver = DiskCrate.trackResolver || null;
  const sync = DiskCrate.sync || null;
  const sheetAdapter = DiskCrate.sheetAdapter || null;
  const collectionMod = DiskCrate.collection || null;
  const validateCatalog = window.validateCatalog || DiskCrate.validateCatalog;
  const normalizeCatalogUrl = window.normalizeCatalogUrl || DiskCrate.normalizeCatalogUrl || function (u) {
    return String(u || '').trim();
  };

  if (!storage || !coverResolver) {
    throw new Error('Required DiskCrate modules (storage, coverResolver) are not loaded.');
  }

  const METADATA_RAW_BASE_URL = 'https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/';
  const METADATA_INDEX_URL = METADATA_RAW_BASE_URL + 'index.json';

  const safeGetItem = storage.safeGetItem;
  const safeSetItem = storage.safeSetItem;
  const safeRemoveItem = storage.safeRemoveItem;

  const escapeHTML = coverResolver.escapeHTML;
  const escapeAttr = coverResolver.escapeAttr;
  const buildJewelCaseDataURI = coverResolver.buildJewelCaseDataURI;
  const tryMusicBrainzCovers = coverResolver.tryMusicBrainzCovers;
  const tryItunesCovers = coverResolver.tryItunesCovers;

  let CHECKLIST_KEY = 'cd_hunt_default_checklist_v2';
  let COVER_CACHE_KEY = 'cd_hunt_default_cover_cache_v6';
  let VIEW_MODE_KEY = 'cd_hunt_default_view_mode_v1';
  let NOTE_DISMISSED_KEY = 'cd_hunt_default_note_dismissed_v1';

  let ALBUMS = [];
  let CATEGORIES = [];
  let CATALOG_META = {};
  let ACTIVE_STORAGE_CONTEXT = {};
  let activeStoragePrefix = null;
  let hasLoadedCatalog = false;
  let activeCatalogUrl = null;
  let activeCatalogLabel = null;
  let presetsPromise = null;
  let presetsLoaded = false;
  let activeMetadataBaseUrl = METADATA_RAW_BASE_URL;
  let customRepoLoaded = false;
  let syncApiUrl = '';
  let syncSession = null;
  let syncShareUrl = null;
  let syncPausedUntil = null;
  let syncPushTimer = null;
  let suppressSyncPush = false;
  let sheetSyncBotEmail = null;
  let sheetSyncStatusChecked = false;
  let trackCacheByKey = {};
  let manualTracksByKey = {};
  const trackFetchInFlight = new Set();
  const trackFetchAttempted = new Set();
  let activeTrackItemId = null;
  let tracksExpanded = false;
  let trackEditorOpen = false;
  let trackMatchesByAlbumId = {};

  let appMode = 'hunt';
  let ownedReleases = [];
  let ownedAllReleases = [];
  let ownedDisplayItems = [];
  let ownedIndex = collectionMod ? collectionMod.buildOwnedIndex([], trackResolver) : null;
  let collectionCategory = 'All';
  let collectionQuickFilter = 'all';
  let collectionCoverCache = {};
  let ownedSheetUrl = '';
  let collectionSyncTimer = null;
  let collectionSyncInFlight = false;
  let collectionSyncPendingRerun = false;

  function getCategoryColor(catKey, index) {
    const palette = ['#f59e0b', '#f43f5e', '#10b981', '#38bdf8', '#a855f7', '#22d3ee'];
    const s = String(catKey || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash + (index || 0)) % palette.length];
  }

  function deriveCategories(items) {
    const cats = [{ key: 'All', label: 'All Releases', dot: '#a1a1aa' }];
    const seen = new Set(['All']);
    let idx = 0;
    items.forEach(function (item) {
      if (item && item.category && !seen.has(item.category)) {
        seen.add(item.category);
        cats.push({
          key: item.category,
          label: item.category,
          dot: item.accent || getCategoryColor(item.category, idx)
        });
        idx++;
      }
    });
    return cats;
  }

  function isCollectionMode() {
    return appMode === 'collection';
  }

  function getActiveItems() {
    return isCollectionMode() ? ownedDisplayItems : ALBUMS;
  }

  function getActiveCoverCache() {
    return isCollectionMode() ? collectionCoverCache : state.coverCache;
  }

  function findActiveItemById(id) {
    return getActiveItems().find(function (a) { return a && a.id === id; }) || null;
  }

  function findOwnedById(id) {
    return ownedReleases.find(function (r) { return r && r.id === id; }) || null;
  }

  function syncModeQueryParam(mode) {
    try {
      if (window.history && typeof window.history.replaceState === 'function' && window.location) {
        const params = new URLSearchParams(window.location.search || '');
        if (mode === 'collection') {
          params.set('mode', 'collection');
        } else {
          params.delete('mode');
        }
        const basePath = window.location.pathname || '';
        const queryStr = params.toString();
        window.history.replaceState(null, '', queryStr ? basePath + '?' + queryStr : basePath);
      }
    } catch (e) {}
  }

  function rebuildOwnedStateAndCovers() {
    ownedDisplayItems = collectionMod
      ? ownedReleases.map(function (r) { return collectionMod.ownedToDisplayItem(r); }).filter(Boolean)
      : [];
    const indexInput = ownedReleases.map(function (r) {
      if (!r || !collectionMod) return r;
      const disp = collectionMod.ownedToDisplayItem(r);
      const eff = disp ? getEffectiveTracksInfo(disp) : null;
      if (eff && Array.isArray(eff.tracks) && eff.tracks.length > 0 && (eff.isOverride || !Array.isArray(r.tracks) || r.tracks.length === 0)) {
        return Object.assign({}, r, { tracks: eff.tracks, trackSource: eff.trackSource || r.trackSource });
      }
      return r;
    });
    ownedIndex = collectionMod ? collectionMod.buildOwnedIndex(indexInput, trackResolver) : null;

    const nextCovers = {};
    ownedReleases.forEach(function (owned) {
      const existingMem = collectionCoverCache[owned.id];
      const existingAuto = existingMem && Array.isArray(existingMem.variants)
        ? existingMem.variants.filter(function (v) { return v && v.source !== 'custom'; })
        : [];
      const customVars = owned.customCovers && Array.isArray(owned.customCovers.variants)
        ? owned.customCovers.variants.map(function (v) {
            return {
              url: v.url,
              label: v.label || 'Custom Jacket',
              catNo: v.catNo || '',
              source: 'custom',
              isRegular: !!v.isRegular
            };
          })
        : [];
      const combined = customVars.concat(existingAuto);
      if (combined.length > 0) {
        let selIdx = 0;
        if (owned.selectedVariant && owned.selectedVariant.url) {
          const hit = combined.findIndex(function (v) { return v.url === owned.selectedVariant.url; });
          if (hit !== -1) selIdx = hit;
        } else if (owned.customCovers && typeof owned.customCovers.selectedIndex === 'number') {
          selIdx = Math.max(0, Math.min(owned.customCovers.selectedIndex, combined.length - 1));
        }
        nextCovers[owned.id] = { variants: combined, selectedIndex: selIdx };
      }
    });
    collectionCoverCache = nextCovers;
  }

  function applyCatalogData(catalog, sourceContext) {
    const data = catalog && typeof catalog === 'object' ? catalog : {};
    CATALOG_META = data.meta && typeof data.meta === 'object' ? data.meta : {};
    ALBUMS = Array.isArray(data.items) ? data.items : [];
    CATEGORIES = Array.isArray(data.categories) && data.categories.length > 0
      ? data.categories
      : deriveCategories(ALBUMS);

    ACTIVE_STORAGE_CONTEXT = {
      sourceUrl: sourceContext && sourceContext.sourceUrl ? sourceContext.sourceUrl : '',
      fileName: sourceContext && sourceContext.fileName ? sourceContext.fileName : '',
      meta: CATALOG_META,
      items: ALBUMS
    };

    const keys = storage.getStorageKeys(ACTIVE_STORAGE_CONTEXT);
    activeStoragePrefix = keys.prefix;
    CHECKLIST_KEY = keys.checklistKey;
    COVER_CACHE_KEY = keys.coverCacheKey;
    VIEW_MODE_KEY = keys.viewModeKey;
    NOTE_DISMISSED_KEY = keys.noteDismissedKey;

    if (CATALOG_META.documentTitle) document.title = CATALOG_META.documentTitle;
    if (CATALOG_META.title) document.getElementById('brandTitle').textContent = CATALOG_META.title;
    if (CATALOG_META.subtitle) document.getElementById('brandSub').textContent = CATALOG_META.subtitle;
    if (CATALOG_META.searchPlaceholder) {
      document.getElementById('searchInput').setAttribute('placeholder', CATALOG_META.searchPlaceholder);
    }
    if (CATALOG_META.digitalSectionTitle) {
      document.getElementById('digitalSectionTitle').textContent = CATALOG_META.digitalSectionTitle;
    }
    if (CATALOG_META.digitalSectionSubtitle) {
      document.getElementById('digitalSectionSub').textContent = CATALOG_META.digitalSectionSubtitle;
    }

    const digitalItems = ALBUMS.filter(function (a) { return !!a.digitalOnly; });
    const noteBanner = document.getElementById('digitalNoteBanner');
    const compactBar = document.getElementById('compactCountBar');
    if (digitalItems.length === 0) {
      noteBanner.classList.add('hidden');
      compactBar.classList.add('hidden');
    } else {
      noteBanner.classList.remove('hidden');
      compactBar.classList.add('hidden');
      document.getElementById('digitalNoteTag').textContent = 'DIGITAL-ONLY (' + digitalItems.length + ')';
      const namesHTML = digitalItems.map(function (d) {
        const shortTitle = String(d.title || '').split('(')[0].trim();
        return '<strong>' + escapeHTML(d.artist) + ' — ' + escapeHTML(shortTitle) + '</strong>';
      }).join(' &amp; ');
      document.getElementById('digitalNoteText').innerHTML = namesHTML + ' have no physical CDs (see section below).';
    }
  }

  function showErrorBanner(msg) {
    const banner = document.getElementById('errorBanner');
    if (!banner) return;
    banner.style.display = 'block';
    banner.textContent = msg;
  }

  function clearErrorBanner() {
    const banner = document.getElementById('errorBanner');
    if (!banner) return;
    banner.style.display = 'none';
    banner.textContent = '';
  }

  function renderCatalogPresets(catalogs, baseUrl) {
    const listEl = document.getElementById('catalogPresetsList');
    if (!listEl) return;
    const resolvedBase = baseUrl || activeMetadataBaseUrl || METADATA_RAW_BASE_URL;

    if (!Array.isArray(catalogs) || catalogs.length === 0) {
      listEl.innerHTML = '<span class="preset-sub">No presets found in index.json — paste a URL or load a local JSON file.</span>';
      return;
    }

    listEl.innerHTML = catalogs.map(function (entry) {
      const presetUrl = entry.url
        ? normalizeCatalogUrl(entry.url)
        : resolvedBase + String(entry.file || '').replace(/^\/+/, '');
      const title = entry.title || entry.id || entry.file || 'Catalog';
      const subtitle = entry.subtitle || presetUrl;
      return (
        '<button type="button" class="btn preset-btn" data-action="load-preset" data-preset-url="' + escapeAttr(presetUrl) + '" data-preset-id="' + escapeAttr(entry.id || '') + '">' +
          '<span>' + escapeHTML(title) + '</span>' +
          '<span class="preset-sub">' + escapeHTML(subtitle) + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function loadCatalogPresets() {
    if (presetsLoaded || customRepoLoaded) return Promise.resolve();
    if (presetsPromise) return presetsPromise;

    const listEl = document.getElementById('catalogPresetsList');
    if (listEl && !listEl.innerHTML) {
      listEl.innerHTML = '<span class="preset-sub">Loading presets from cd-metadata...</span>';
    }

    presetsPromise = (async function () {
      try {
        const res = await fetch(METADATA_INDEX_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const indexData = await res.json();
        if (customRepoLoaded) return;
        const list = indexData && Array.isArray(indexData.catalogs) ? indexData.catalogs : [];
        presetsLoaded = true;
        renderCatalogPresets(list, activeMetadataBaseUrl);
      } catch (err) {
        if (!customRepoLoaded && listEl) {
          listEl.innerHTML = '<span class="preset-sub">Presets unavailable offline — paste a URL or load a local JSON file.</span>';
        }
      } finally {
        presetsPromise = null;
      }
    })();

    return presetsPromise;
  }

  function renderSheetSyncBotBanner() {
    const banner = document.getElementById('sheetSyncBotBanner');
    const textEl = document.getElementById('sheetSyncBotText');
    if (!banner || !textEl) return;
    if (sheetSyncBotEmail) {
      textEl.textContent = 'Two-way Google Sheet sync: share your Sheet as Editor with ' + sheetSyncBotEmail;
      banner.classList.remove('hidden');
    } else {
      textEl.textContent = '';
      banner.classList.add('hidden');
    }
  }

  async function loadSheetSyncBotInfo() {
    if (!syncApiUrl || sheetSyncStatusChecked) return;
    sheetSyncStatusChecked = true;
    try {
      const res = await fetch(syncApiUrl.replace(/\/+$/, '') + '/api/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.sheetSync && data.sheetSync.configured && data.sheetSync.serviceAccountEmail) {
        sheetSyncBotEmail = String(data.sheetSync.serviceAccountEmail);
        renderSheetSyncBotBanner();
      }
    } catch (err) {
      // Ignore offline / mock failures silently
    }
  }

  function showCatalogLoader(visible) {
    const loader = document.getElementById('catalogLoaderScreen');
    if (!loader) return;

    const noteBanner = document.getElementById('digitalNoteBanner');
    const compactBar = document.getElementById('compactCountBar');
    const gridEl = document.getElementById('albumGrid');
    const digSection = document.getElementById('digitalOnlySection');
    const emptyBox = document.getElementById('emptyState');
    const closeBtn = document.getElementById('closeCatalogLoaderBtn');
    const shareBtn = document.getElementById('copyShareLinkBtn');
    const urlInput = document.getElementById('catalogUrlInput');
    const infoEl = document.getElementById('activeCatalogInfo');

    if (visible && !isCollectionMode()) {
      loader.classList.remove('hidden');
      if (noteBanner) noteBanner.classList.add('hidden');
      if (compactBar) compactBar.classList.add('hidden');
      if (gridEl) gridEl.classList.add('hidden');
      if (digSection) digSection.classList.add('hidden');
      if (emptyBox) emptyBox.classList.add('hidden');
      if (closeBtn) closeBtn.classList.toggle('hidden', !hasLoadedCatalog);
      if (shareBtn) shareBtn.classList.toggle('hidden', !activeCatalogUrl);
      if (urlInput) {
        urlInput.value = activeCatalogUrl || '';
      }
      if (infoEl) {
        if (activeCatalogLabel) {
          infoEl.classList.remove('hidden');
          infoEl.textContent = activeCatalogLabel;
        } else {
          infoEl.classList.add('hidden');
          infoEl.textContent = '';
        }
      }
      renderSheetSyncBotBanner();
      loadSheetSyncBotInfo();
      loadCatalogPresets();
    } else {
      loader.classList.add('hidden');
      if (isCollectionMode()) {
        if (noteBanner) noteBanner.classList.add('hidden');
        if (compactBar) compactBar.classList.add('hidden');
        if (digSection) digSection.classList.add('hidden');
        return;
      }
      const hasDigital = ALBUMS.some(function (a) { return !!a.digitalOnly; });
      if (!hasDigital) {
        if (noteBanner) noteBanner.classList.add('hidden');
        if (compactBar) compactBar.classList.add('hidden');
      } else if (safeGetItem(NOTE_DISMISSED_KEY) === '1') {
        if (noteBanner) noteBanner.classList.add('hidden');
        if (compactBar) compactBar.classList.remove('hidden');
      } else {
        if (noteBanner) noteBanner.classList.remove('hidden');
        if (compactBar) compactBar.classList.add('hidden');
      }
    }
  }

  function applyHeaderTextForMode() {
    const brandTitleEl = document.getElementById('brandTitle');
    const brandSubEl = document.getElementById('brandSub');
    const searchEl = document.getElementById('searchInput');
    if (isCollectionMode()) {
      document.title = 'Disk Crate — Owned Collection';
      if (brandTitleEl) brandTitleEl.textContent = 'Disk Crate · Collection';
      if (brandSubEl) brandSubEl.textContent = 'Owned Releases Database (IndexedDB + Incremental Sync)';
      if (searchEl) searchEl.setAttribute('placeholder', 'Search owned releases, track titles, cat #, barcode, or notes...');
    } else {
      document.title = CATALOG_META.documentTitle || 'Disk Crate — Cover Album & Checklist';
      if (brandTitleEl) brandTitleEl.textContent = CATALOG_META.title || 'Disk Crate';
      if (brandSubEl) brandSubEl.textContent = CATALOG_META.subtitle || 'Cover Album & Crate Checklist (通常盤 Priority)';
      if (searchEl) {
        searchEl.setAttribute(
          'placeholder',
          CATALOG_META.searchPlaceholder || 'Search English, Romaji, 日本語, track title, anime/game, or catalog #...'
        );
      }
    }
  }

  function countGraduatableHuntItems() {
    if (!collectionMod || !hasLoadedCatalog) return 0;
    let count = 0;
    ALBUMS.forEach(function (item) {
      if (!item || item.digitalOnly || !state.acquiredMap[item.id]) return;
      const xref = ownedIndex
        ? collectionMod.crossReferenceHuntItem(item, ownedIndex, null, trackResolver)
        : { status: 'none' };
      if (xref.status !== 'exact') count++;
    });
    return count;
  }

  function updateBatchGraduateButton() {
    const btn = document.getElementById('batchGraduateBtn');
    if (!btn) return;
    const count = isCollectionMode() ? 0 : countGraduatableHuntItems();
    btn.classList.toggle('hidden', count === 0);
    if (count > 0) {
      btn.textContent = 'Move Found to Collection (' + count + ')';
    }
  }

  function updateModeUI() {
    const col = isCollectionMode();
    const huntTab = document.getElementById('modeHuntBtn');
    const colTab = document.getElementById('modeCollectionBtn');
    if (huntTab) {
      huntTab.classList.toggle('active', !col);
      huntTab.setAttribute('aria-selected', !col ? 'true' : 'false');
    }
    if (colTab) {
      colTab.classList.toggle('active', col);
      colTab.setAttribute('aria-selected', col ? 'true' : 'false');
    }

    ['huntingOnlyBtn', 'refreshAllBtn', 'backupBtn', 'openCatalogLoaderBtn'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', col);
    });
    ['addReleaseBtn', 'collectionBackupBtn', 'collectionQuickFilters'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !col);
    });

    const viewLabel = document.getElementById('viewModeLabel');
    if (viewLabel) {
      viewLabel.textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
    }

    updateBatchGraduateButton();
    applyHeaderTextForMode();
  }

  function setAppMode(nextMode, opts) {
    const normalized = nextMode === 'collection' ? 'collection' : 'hunt';
    const options = opts || {};
    appMode = normalized;
    pendingQueue.length = 0;
    queuedIds.clear();
    activeTrackItemId = null;
    tracksExpanded = false;
    trackEditorOpen = false;
    state.lightboxIndex = 0;

    const modal = document.getElementById('lightboxModal');
    if (modal) modal.classList.remove('open');

    if (!options.skipQuerySync) {
      syncModeQueryParam(appMode);
    }

    updateModeUI();
    if (isCollectionMode()) {
      showCatalogLoader(false);
      renderCategoryPills();
      renderAll();
    } else if (!hasLoadedCatalog) {
      showCatalogLoader(true);
    } else {
      showCatalogLoader(false);
      renderCategoryPills();
      renderAll();
    }
  }

  function resetAppStateForCatalog() {
    state.search = '';
    state.category = 'All';
    state.huntingOnly = false;
    state.viewMode = 'grid';
    state.acquiredMap = {};
    state.coverCache = {};
    state.lightboxIndex = 0;
    pendingQueue.length = 0;
    queuedIds.clear();
    inFlightIds.clear();
    activeTrackItemId = null;
    tracksExpanded = false;
    trackEditorOpen = false;
    trackMatchesByAlbumId = {};

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.classList.remove('visible');
    const huntBtn = document.getElementById('huntingOnlyBtn');
    if (huntBtn) huntBtn.classList.remove('btn-active-filter');
  }

  function syncQueryParamUrl(catalogUrl) {
    try {
      if (window.history && typeof window.history.replaceState === 'function' && window.location) {
        const params = new URLSearchParams(window.location.search || '');
        if (catalogUrl) {
          params.set('catalog', catalogUrl);
        } else {
          params.delete('catalog');
        }
        const basePath = window.location.pathname || '';
        const queryStr = params.toString();
        window.history.replaceState(null, '', queryStr ? basePath + '?' + queryStr : basePath);
      }
    } catch (e) {
      // Ignore sandboxed history errors
    }
  }

  function buildShareUrl(catalogUrl) {
    const origin = window.location && window.location.origin && window.location.origin !== 'null'
      ? window.location.origin
      : '';
    const pathname = (window.location && window.location.pathname) || '';
    return origin + pathname + '?catalog=' + encodeURIComponent(catalogUrl);
  }

  function applyValidatedCatalog(catalog, options) {
    const opts = options || {};
    if (typeof validateCatalog === 'function') {
      const validation = validateCatalog(catalog);
      if (!validation.valid) {
        throw new Error('Catalog validation failed: ' + validation.errors.join('; '));
      }
    }

    clearErrorBanner();

    if (opts.sourceUrl) {
      activeCatalogUrl = opts.sourceUrl;
      activeCatalogLabel = 'Active catalog URL: ' + opts.sourceUrl;
      if (typeof storage.setActiveCatalogUrl === 'function') {
        storage.setActiveCatalogUrl(opts.sourceUrl);
      }
      syncQueryParamUrl(opts.sourceUrl);
    } else if (opts.fileName) {
      activeCatalogUrl = null;
      activeCatalogLabel = 'Active local file: ' + opts.fileName;
      if (typeof storage.clearActiveCatalogUrl === 'function') {
        storage.clearActiveCatalogUrl();
      }
      syncQueryParamUrl(null);
    } else {
      activeCatalogUrl = null;
      activeCatalogLabel = null;
    }

    resetAppStateForCatalog();
    applyCatalogData(catalog, opts);
    const hadExistingChecklist = safeGetItem(CHECKLIST_KEY) !== null;
    loadStateFromStorage();

    // Only seed Got it? = TRUE from a Sheet when no local/synced checklist baseline exists yet
    // so user unchecks in Disk Crate or cloud D1 stay authoritative across Sheet reloads.
    if (!hadExistingChecklist && opts.sheetChecklist && typeof opts.sheetChecklist === 'object') {
      let addedFromSheet = false;
      Object.keys(opts.sheetChecklist).forEach(function (id) {
        if (opts.sheetChecklist[id] && !state.acquiredMap[id]) {
          state.acquiredMap[id] = true;
          addedFromSheet = true;
        }
      });
      if (addedFromSheet) {
        safeSetItem(CHECKLIST_KEY, JSON.stringify(state.acquiredMap));
      }
    }

    document.getElementById('viewModeLabel').textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
    hasLoadedCatalog = true;
    if (isCollectionMode()) {
      appMode = 'hunt';
      syncModeQueryParam('hunt');
    }
    updateModeUI();
    showCatalogLoader(false);
    renderCategoryPills();
    renderAll();
    if (!suppressSyncPush && opts.sourceUrl) {
      scheduleCloudPush();
    }
  }

  function isCatalogIndex(data) {
    return Boolean(
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Array.isArray(data.catalogs) &&
      !Array.isArray(data.items)
    );
  }

  function applyCatalogIndex(data, normalizedUrl, labelPrefix) {
    const baseUrl = normalizedUrl.replace(/\/[^/]*$/, '/');
    activeMetadataBaseUrl = baseUrl;
    customRepoLoaded = true;
    presetsLoaded = true;
    activeCatalogLabel = (labelPrefix || 'Loaded repository index: ') + normalizedUrl;
    clearErrorBanner();
    showCatalogLoader(true);
    const urlInput = document.getElementById('catalogUrlInput');
    if (urlInput) urlInput.value = normalizedUrl;
    renderCatalogPresets(data.catalogs, baseUrl);
    return { type: 'index', url: normalizedUrl, catalogs: data.catalogs };
  }

  function getSheetCacheKey(normalizedUrl) {
    return storage.deriveStoragePrefix({ sourceUrl: normalizedUrl }) + '_sheet_csv_v1';
  }

  function formatDuplicateWarningToast(duplicates, warningOnly) {
    const list = Array.isArray(duplicates) ? duplicates : [];
    const labels = [];
    const seen = new Set();
    list.forEach(function (d) {
      const label = (d && (d.key || d.title)) ? String(d.key || d.title) : '';
      if (label && !seen.has(label) && labels.length < 3) {
        seen.add(label);
        labels.push(label);
      }
    });
    const suffix = labels.length > 0 ? ' (' + labels.join(', ') + ')' : '';
    if (warningOnly) {
      return 'Warning: ' + list.length + ' duplicate catalog entr' + (list.length === 1 ? 'y' : 'ies') + suffix;
    }
    return 'Merged ' + list.length + ' duplicate row' + (list.length === 1 ? '' : 's') + suffix;
  }

  async function loadAndApplyCatalogFromUrl(rawUrl) {
    const normalizedUrl = normalizeCatalogUrl(rawUrl);
    if (!normalizedUrl) {
      throw new Error('Please enter a valid metadata JSON, repository, or Google Sheet URL.');
    }

    if (sheetAdapter && sheetAdapter.isGoogleSheetCsvUrl(normalizedUrl)) {
      const cacheKey = getSheetCacheKey(normalizedUrl);
      let csvText = null;
      let loadedFromOfflineCache = false;

      try {
        const sheetRes = await fetch(normalizedUrl);
        if (!sheetRes.ok) {
          throw new Error('Failed to load catalog from ' + normalizedUrl + ' (HTTP ' + sheetRes.status + ')');
        }
        csvText = await sheetRes.text();
        safeSetItem(cacheKey, csvText);
      } catch (err) {
        const cachedCsv = safeGetItem(cacheKey);
        if (!cachedCsv) throw err;
        csvText = cachedCsv;
        loadedFromOfflineCache = true;
      }

      const sheetParsed = sheetAdapter.parseGoogleSheetCsv(csvText, {
        sourceUrl: normalizedUrl
      });
      applyValidatedCatalog(sheetParsed.catalog, {
        sourceUrl: normalizedUrl,
        sheetChecklist: sheetParsed.sheetChecklist
      });

      const hasDups = Array.isArray(sheetParsed.duplicates) && sheetParsed.duplicates.length > 0;
      const dupMsg = hasDups ? formatDuplicateWarningToast(sheetParsed.duplicates, false) : '';
      if (loadedFromOfflineCache && hasDups) {
        showToast('Loaded cached Google Sheet (offline) · ' + dupMsg);
      } else if (loadedFromOfflineCache) {
        showToast('Loaded cached Google Sheet (offline)');
      } else if (hasDups) {
        showToast(dupMsg);
      }
      return {
        type: 'catalog',
        url: normalizedUrl,
        cached: loadedFromOfflineCache,
        toastShown: Boolean(loadedFromOfflineCache || hasDups)
      };
    }

    const res = await fetch(normalizedUrl);
    if (!res.ok) {
      throw new Error('Failed to load catalog from ' + normalizedUrl + ' (HTTP ' + res.status + ')');
    }

    const data = await res.json();
    if (isCatalogIndex(data)) {
      return applyCatalogIndex(data, normalizedUrl, 'Loaded repository index: ');
    }

    if (data && data.meta && data.meta.googleSheetUrl && sheetAdapter) {
      try {
        const sheetCsvUrl = normalizeCatalogUrl(data.meta.googleSheetUrl);
        if (sheetCsvUrl && sheetAdapter.isGoogleSheetCsvUrl(sheetCsvUrl)) {
          const sheetRes = await fetch(sheetCsvUrl);
          if (sheetRes.ok) {
            const sheetCsvText = await sheetRes.text();
            const sheetParsed = sheetAdapter.parseGoogleSheetCsv(sheetCsvText, {
              sourceUrl: data.meta.googleSheetUrl
            });
            const merged = sheetAdapter.mergeCatalogWithSheet(data, sheetParsed);
            applyValidatedCatalog(merged.catalog, {
              sourceUrl: normalizedUrl,
              sheetChecklist: merged.sheetChecklist
            });
            const hasMergeDups = Array.isArray(merged.duplicates) && merged.duplicates.length > 0;
            if (hasMergeDups) {
              showToast(formatDuplicateWarningToast(merged.duplicates, false));
            }
            return { type: 'catalog', url: normalizedUrl, toastShown: hasMergeDups };
          }
        }
      } catch (err) {
        // Non-fatal offline fallback: still apply base JSON catalog
      }
    }

    const jsonDups =
      sheetAdapter && typeof sheetAdapter.detectCatalogDuplicates === 'function'
        ? sheetAdapter.detectCatalogDuplicates(data && data.items)
        : [];
    applyValidatedCatalog(data, { sourceUrl: normalizedUrl });
    const hasJsonDups = jsonDups.length > 0;
    if (hasJsonDups) {
      showToast(formatDuplicateWarningToast(jsonDups, true));
    }
    return { type: 'catalog', url: normalizedUrl, toastShown: hasJsonDups };
  }

  function getSyncDebounceMs() {
    const ns = window.DiskCrate || window.CDHunt || {};
    const cfg = ns.config || {};
    return typeof cfg.syncDebounceMs === 'number' && cfg.syncDebounceMs >= 0 ? cfg.syncDebounceMs : 2500;
  }

  function updateSyncUI(statusText, tone) {
    const authBtn = document.getElementById('githubAuthBtn');
    const signOutBtn = document.getElementById('githubSignOutBtn');
    const agentLinkBtn = document.getElementById('copyAgentLinkBtn');
    const statusPill = document.getElementById('syncStatusPill');

    if (!sync || !syncApiUrl) {
      if (authBtn) authBtn.classList.add('hidden');
      if (signOutBtn) signOutBtn.classList.add('hidden');
      if (agentLinkBtn) agentLinkBtn.classList.add('hidden');
      if (statusPill) statusPill.classList.add('hidden');
      return;
    }

    if (syncSession) {
      if (authBtn) authBtn.classList.add('hidden');
      if (signOutBtn) signOutBtn.classList.remove('hidden');
      if (agentLinkBtn) agentLinkBtn.classList.toggle('hidden', !syncShareUrl);
      if (statusPill) {
        statusPill.classList.remove('hidden', 'sync-pill-ok', 'sync-pill-warn', 'sync-pill-muted');
        statusPill.classList.add(
          tone === 'warn' ? 'sync-pill-warn' : tone === 'muted' ? 'sync-pill-muted' : 'sync-pill-ok'
        );
        statusPill.textContent = '@' + syncSession.user.login + (statusText ? ' · ' + statusText : '');
      }
      return;
    }

    if (authBtn) authBtn.classList.remove('hidden');
    if (signOutBtn) signOutBtn.classList.add('hidden');
    if (agentLinkBtn) agentLinkBtn.classList.add('hidden');
    if (statusPill) {
      if (statusText) {
        statusPill.classList.remove('hidden', 'sync-pill-ok', 'sync-pill-warn', 'sync-pill-muted');
        statusPill.classList.add(tone === 'ok' ? 'sync-pill-ok' : tone === 'muted' ? 'sync-pill-muted' : 'sync-pill-warn');
        statusPill.textContent = statusText;
      } else {
        statusPill.classList.add('hidden');
      }
    }
  }

  async function flushCloudPush(options) {
    if (syncPushTimer !== null) {
      clearTimeout(syncPushTimer);
      syncPushTimer = null;
    }
    if (!sync || !syncApiUrl || !syncSession) return;
    if (syncPausedUntil) {
      updateSyncUI('Paused until 00:00 UTC', 'warn');
      return;
    }
    updateSyncUI('Syncing...', 'muted');
    const payload = sync.buildLocalSyncPayload(
      storage,
      activeCatalogUrl,
      activeStoragePrefix,
      hasLoadedCatalog ? state : null
    );
    if (!payload.updatedAt) payload.updatedAt = Date.now();
    if (hasLoadedCatalog && sheetAdapter) {
      const sheetUrl =
        (CATALOG_META && CATALOG_META.googleSheetUrl) ||
        (activeCatalogUrl && sheetAdapter.isGoogleSheetCsvUrl(activeCatalogUrl) ? activeCatalogUrl : '');
      if (sheetUrl) {
        payload.sheetSync = {
          googleSheetUrl: sheetUrl,
          checklistByCatNo: sheetAdapter.buildChecklistByCatNo(ALBUMS, state.acquiredMap)
        };
      }
    }
    const pushOpts = options && options.keepalive ? { keepalive: true } : undefined;
    const res = await sync.pushCloudState(syncApiUrl, syncSession.token, payload, undefined, pushOpts);
    if (res.unauthorized) {
      sync.clearAuthSession(storage);
      syncSession = null;
      syncShareUrl = null;
      updateSyncUI('Session expired', 'warn');
      showToast('GitHub sync session expired — please sign in again');
      return;
    }
    if (res.paused) {
      syncPausedUntil = res.resetsAt || '00:00 UTC';
      updateSyncUI('Paused until 00:00 UTC', 'warn');
      return;
    }
    if (res.rateLimited) {
      updateSyncUI('Rate limited — saved locally', 'warn');
      return;
    }
    if (res.payloadTooLarge) {
      updateSyncUI('Too large for cloud — local only', 'warn');
      return;
    }
    if (!res.ok) {
      updateSyncUI('Offline — saved locally', 'muted');
      return;
    }
    if (res.shareUrl) {
      syncShareUrl = res.shareUrl;
    }
    updateSyncUI('Synced', 'ok');
  }

  function scheduleCloudPush() {
    if (!sync || !syncApiUrl || !syncSession || suppressSyncPush) return;
    if (activeStoragePrefix && typeof sync.markPrefixUpdated === 'function') {
      sync.markPrefixUpdated(storage, activeStoragePrefix);
    }
    if (syncPausedUntil) {
      updateSyncUI('Paused until 00:00 UTC', 'warn');
      return;
    }
    clearTimeout(syncPushTimer);
    updateSyncUI('Pending...', 'muted');
    syncPushTimer = setTimeout(flushCloudPush, getSyncDebounceMs());
  }

  function flushPendingCloudPush(options) {
    if (syncPushTimer === null) return;
    flushCloudPush(options);
  }

  async function hydrateOwnedFromDb() {
    if (!db || typeof db.getAllOwnedReleases !== 'function') return;
    try {
      const [allRows, meta] = await Promise.all([
        db.getAllOwnedReleases({ includeDeleted: true }),
        typeof db.getSyncMeta === 'function' ? db.getSyncMeta('collectionSync') : null
      ]);
      ownedAllReleases = Array.isArray(allRows) ? allRows : [];
      ownedReleases = ownedAllReleases.filter(function (r) {
        return r && (r.deletedAt === null || r.deletedAt === undefined);
      });
      if (meta && meta.lastOwnedSheetUrl) {
        ownedSheetUrl = String(meta.lastOwnedSheetUrl);
      }
      rebuildOwnedStateAndCovers();
      updateBatchGraduateButton();
      if (hasLoadedCatalog || isCollectionMode()) {
        renderCategoryPills();
        renderAll();
        const modal = document.getElementById('lightboxModal');
        if (modal && modal.classList.contains('open')) {
          renderLightbox();
        }
      }
    } catch (err) {
      // Ignore IndexedDB hydration errors cleanly
    }
  }

  async function syncCollectionNow(options) {
    if (collectionSyncTimer !== null) {
      clearTimeout(collectionSyncTimer);
      collectionSyncTimer = null;
    }
    const opts = options || {};
    if (!db || !sync || !syncApiUrl || !syncSession || typeof sync.syncOwnedCollection !== 'function') {
      return { ok: false, offline: true };
    }
    if (syncPausedUntil) {
      if (!opts.quietOnIdle || isCollectionMode()) updateSyncUI('Paused until 00:00 UTC', 'warn');
      return { ok: false, paused: true };
    }
    if (collectionSyncInFlight) {
      collectionSyncPendingRerun = true;
      return { ok: false, pending: true };
    }

    collectionSyncInFlight = true;
    if (!opts.quietOnIdle || isCollectionMode()) {
      updateSyncUI('Syncing...', 'muted');
    }

    let res = { ok: false, offline: true };
    try {
      res = await sync.syncOwnedCollection(db, syncApiUrl, syncSession.token, undefined, opts.keepalive ? { keepalive: true } : undefined);
      if (res.unauthorized) {
        sync.clearAuthSession(storage);
        syncSession = null;
        syncShareUrl = null;
        updateSyncUI('Session expired', 'warn');
        showToast('GitHub sync session expired — please sign in again');
        return res;
      }
      if (res.paused) {
        syncPausedUntil = res.resetsAt || '00:00 UTC';
        if (!opts.quietOnIdle || isCollectionMode()) updateSyncUI('Paused until 00:00 UTC', 'warn');
        return res;
      }
      if (res.rateLimited) {
        if (!opts.quietOnIdle || isCollectionMode()) updateSyncUI('Rate limited — saved locally', 'warn');
        return res;
      }
      if (!res.ok) {
        if (!opts.quietOnIdle || isCollectionMode()) updateSyncUI('Offline — saved locally', 'muted');
        return res;
      }

      if (res.pulledCount > 0 || res.conflictCount > 0 || res.pushedCount > 0) {
        await hydrateOwnedFromDb();
      }
      if (!opts.quietOnIdle || isCollectionMode() || res.pulledCount > 0 || res.pushedCount > 0) {
        updateSyncUI('Synced', 'ok');
      }
      return res;
    } finally {
      collectionSyncInFlight = false;
      if (collectionSyncPendingRerun) {
        collectionSyncPendingRerun = false;
        setTimeout(function () { syncCollectionNow({ quietOnIdle: true }); }, 0);
      }
    }
  }

  function scheduleCollectionSync() {
    if (!sync || !syncApiUrl || !syncSession || suppressSyncPush) return;
    if (syncPausedUntil) {
      updateSyncUI('Paused until 00:00 UTC', 'warn');
      return;
    }
    clearTimeout(collectionSyncTimer);
    updateSyncUI('Pending...', 'muted');
    collectionSyncTimer = setTimeout(function () { syncCollectionNow(); }, getSyncDebounceMs());
  }

  function flushPendingCollectionSync(options) {
    if (collectionSyncTimer === null) return;
    syncCollectionNow(options);
  }

  async function tryLoadUserMetadataRepo(login) {
    if (!login) return false;
    const repoIndexUrl = 'https://raw.githubusercontent.com/' + encodeURIComponent(login) + '/cd-metadata/main/index.json';
    try {
      const res = await fetch(repoIndexUrl);
      if (!res.ok) return false;
      const data = await res.json();
      if (!isCatalogIndex(data)) return false;
      applyCatalogIndex(data, repoIndexUrl, 'Loaded ' + login + '/cd-metadata: ');
      return true;
    } catch (err) {
      return false;
    }
  }

  const state = {
    search: '',
    category: 'All',
    huntingOnly: false,
    viewMode: 'grid',
    acquiredMap: {},
    coverCache: {},
    lightboxIndex: 0
  };

  const pendingQueue = [];
  const queuedIds = new Set();
  const inFlightIds = new Set();
  let activeWorkers = 0;
  const MAX_WORKERS = 3;
  let cardObserver = null;
  let toastTimer = null;

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2100);
  }

  function loadStateFromStorage() {
    storage.purgeLegacyCoverCaches(ACTIVE_STORAGE_CONTEXT);

    const savedView = safeGetItem(VIEW_MODE_KEY);
    if (savedView === 'single' || savedView === 'grid') {
      state.viewMode = savedView;
    }

    if (safeGetItem(NOTE_DISMISSED_KEY) === '1') {
      document.getElementById('digitalNoteBanner').classList.add('hidden');
      document.getElementById('compactCountBar').classList.remove('hidden');
    }

    const rawChecklist = safeGetItem(CHECKLIST_KEY);
    if (rawChecklist) {
      try {
        const parsed = JSON.parse(rawChecklist);
        if (Array.isArray(parsed)) {
          parsed.forEach(function (entry) {
            if (entry && entry.id && entry.checked) {
              state.acquiredMap[entry.id] = true;
            }
          });
        } else if (parsed && typeof parsed === 'object') {
          state.acquiredMap = parsed;
        }
      } catch (e) {}
    }

    const rawCache = safeGetItem(COVER_CACHE_KEY);
    if (rawCache) {
      try {
        const parsedCache = JSON.parse(rawCache);
        if (parsedCache && typeof parsedCache === 'object') {
          state.coverCache = parsedCache;
        }
      } catch (e) {}
    }
  }

  function saveChecklistSync() {
    const rawChecklist = safeGetItem(CHECKLIST_KEY);
    if (rawChecklist) {
      try {
        const parsed = JSON.parse(rawChecklist);
        if (Array.isArray(parsed)) {
          const updated = parsed.map(function (entry) {
            return Object.assign({}, entry, { checked: !!state.acquiredMap[entry.id] });
          });
          safeSetItem(CHECKLIST_KEY, JSON.stringify(updated));
          return;
        }
      } catch (e) {}
    }
    safeSetItem(CHECKLIST_KEY, JSON.stringify(state.acquiredMap));
  }

  function saveCoverCache() {
    if (isCollectionMode()) return;
    safeSetItem(COVER_CACHE_KEY, JSON.stringify(state.coverCache));
  }

  async function upsertLocalOwnedState(savedRecord) {
    if (!savedRecord || !savedRecord.id) return;
    const nextAll = ownedAllReleases.filter(function (r) { return r && r.id !== savedRecord.id; });
    nextAll.push(savedRecord);
    ownedAllReleases = nextAll;
    ownedReleases = nextAll.filter(function (r) {
      return r && (r.deletedAt === null || r.deletedAt === undefined);
    });
    rebuildOwnedStateAndCovers();
    updateBatchGraduateButton();
  }

  async function persistOwnedCoverChange(releaseId) {
    const owned = findOwnedById(releaseId);
    if (!owned || !db || typeof db.putOwnedRelease !== 'function') return;
    const cacheEntry = collectionCoverCache[releaseId];
    let customCovers = null;
    let selectedVariant = null;
    if (cacheEntry && Array.isArray(cacheEntry.variants) && cacheEntry.variants.length > 0) {
      const customVars = [];
      let customSel = 0;
      cacheEntry.variants.forEach(function (v, idx) {
        if (v && v.source === 'custom' && v.url) {
          if (idx === (cacheEntry.selectedIndex || 0)) customSel = customVars.length;
          customVars.push({
            url: v.url,
            label: v.label || 'Custom Jacket',
            catNo: v.catNo || '',
            source: 'custom',
            isRegular: !!v.isRegular
          });
        }
      });
      if (customVars.length > 0) {
        customCovers = { variants: customVars, selectedIndex: customSel };
      }
      const selIdx = Math.max(0, Math.min(cacheEntry.selectedIndex || 0, cacheEntry.variants.length - 1));
      const activeVar = cacheEntry.variants[selIdx];
      if (activeVar && activeVar.url) {
        selectedVariant = { url: activeVar.url, selectedIndex: selIdx, label: activeVar.label || '' };
      }
    }

    const updated = Object.assign({}, owned, {
      clientUpdatedAt: Date.now(),
      dirty: 1
    });
    if (customCovers) updated.customCovers = customCovers;
    else delete updated.customCovers;
    if (selectedVariant) updated.selectedVariant = selectedVariant;
    else delete updated.selectedVariant;

    const stored = await db.putOwnedRelease(updated);
    await upsertLocalOwnedState(stored || updated);
    scheduleCollectionSync();
  }

  async function syncOwnedReleaseTracksChange(item, tracks, trackSource) {
    if (!isCollectionMode() || !item || !db || typeof db.putOwnedRelease !== 'function') return;
    const owned = findOwnedById(item.id);
    if (!owned) return;
    const updated = Object.assign({}, owned, {
      clientUpdatedAt: Date.now(),
      dirty: 1
    });
    if (Array.isArray(tracks) && tracks.length > 0) {
      updated.tracks = tracks;
      updated.trackSource = trackSource || 'manual';
    } else {
      delete updated.tracks;
      delete updated.trackSource;
    }
    const stored = await db.putOwnedRelease(updated);
    await upsertLocalOwnedState(stored || updated);
    scheduleCollectionSync();
  }

  async function softDeleteOwnedRelease(releaseId) {
    const owned = findOwnedById(releaseId);
    if (!owned || !db || typeof db.putOwnedRelease !== 'function') return false;
    const ts = Date.now();
    const tombstone = Object.assign({}, owned, {
      deletedAt: ts,
      clientUpdatedAt: ts,
      dirty: 1
    });
    const stored = await db.putOwnedRelease(tombstone);
    delete collectionCoverCache[releaseId];
    await upsertLocalOwnedState(stored || tombstone);
    renderCategoryPills();
    renderAll();
    const modal = document.getElementById('lightboxModal');
    if (modal && modal.classList.contains('open')) {
      const remaining = getFilteredAlbums();
      if (remaining.length === 0) {
        closeLightbox();
      } else {
        if (state.lightboxIndex >= remaining.length) state.lightboxIndex = remaining.length - 1;
        renderLightbox();
      }
    }
    scheduleCollectionSync();
    showToast('Removed from Collection (synced as tombstone)');
    return true;
  }

  function getTrackReleaseKey(item) {
    if (!item) return '';
    if (trackResolver && typeof trackResolver.deriveTrackReleaseKey === 'function') {
      return trackResolver.deriveTrackReleaseKey(item);
    }
    return String(item.mbid || item.regCatNo || item.id || '').trim();
  }

  function getEffectiveTracksInfo(item) {
    if (!item) {
      return { tracks: [], trackSource: null, sourceDetail: '', isOverride: false, hasCatalogTracks: false, mbid: '' };
    }
    const key = getTrackReleaseKey(item);
    const manualRecord = key ? manualTracksByKey[key] : null;
    const cacheRecord = key ? trackCacheByKey[key] : null;
    if (trackResolver && typeof trackResolver.resolveEffectiveTracks === 'function') {
      return trackResolver.resolveEffectiveTracks(item, { manualRecord: manualRecord, cacheRecord: cacheRecord });
    }
    const tracks = Array.isArray(item.tracks) ? item.tracks : [];
    return {
      tracks: tracks,
      trackSource: tracks.length > 0 ? (item.trackSource || 'catalog') : null,
      sourceDetail: item.regCatNo || 'Catalog',
      isOverride: false,
      hasCatalogTracks: tracks.length > 0,
      mbid: item.mbid || ''
    };
  }

  async function hydrateTracksFromDb() {
    if (!db) return;
    try {
      const [cachedRows, manualRows] = await Promise.all([
        typeof db.getAllTrackCache === 'function' ? db.getAllTrackCache() : [],
        typeof db.getAllManualTracks === 'function' ? db.getAllManualTracks() : []
      ]);
      const nextCache = {};
      (Array.isArray(cachedRows) ? cachedRows : []).forEach(function (row) {
        if (row && row.releaseKey) nextCache[row.releaseKey] = row;
      });
      const nextManual = {};
      (Array.isArray(manualRows) ? manualRows : []).forEach(function (row) {
        if (row && row.releaseKey) nextManual[row.releaseKey] = row;
      });
      trackCacheByKey = nextCache;
      manualTracksByKey = nextManual;
      if (ownedReleases.length > 0) {
        rebuildOwnedStateAndCovers();
      }
      if (hasLoadedCatalog || isCollectionMode()) {
        if (state.search || ownedReleases.length > 0) renderAll();
        const modal = document.getElementById('lightboxModal');
        if (modal && modal.classList.contains('open')) {
          renderLightbox();
        }
      }
    } catch (err) {
      // Ignore IndexedDB hydration errors safely
    }
  }

  function getTrackSourceDisplay(info) {
    if (!info || !info.trackSource || !Array.isArray(info.tracks) || info.tracks.length === 0) {
      return null;
    }
    if (info.trackSource === 'manual') {
      return { text: 'Custom', cls: 'source-manual' };
    }
    if (info.trackSource === 'catalog') {
      return {
        text: info.sourceDetail && info.sourceDetail !== 'Catalog' ? 'Catalog · ' + info.sourceDetail : 'Catalog',
        cls: 'source-catalog'
      };
    }
    if (info.trackSource === 'itunes') {
      return { text: 'iTunes · Digital', cls: 'source-itunes' };
    }
    return {
      text: info.sourceDetail ? 'MusicBrainz · ' + info.sourceDetail : 'MusicBrainz',
      cls: 'source-musicbrainz'
    };
  }

  function getHuntCrossRef(item) {
    if (isCollectionMode() || !collectionMod || !ownedIndex || ownedIndex.activeCount === 0 || !item) {
      return null;
    }
    const eff = getEffectiveTracksInfo(item);
    return collectionMod.crossReferenceHuntItem(item, ownedIndex, eff.tracks, trackResolver);
  }

  function buildTrackListRowsHTML(tracks, xref) {
    const discIds = new Set();
    let hasNonCd = false;
    tracks.forEach(function (t) {
      discIds.add(t.disc || 1);
      if (t.mediaType && t.mediaType !== 'CD') hasNonCd = true;
    });
    const showDiscHeaders = discIds.size > 1 || hasNonCd;

    const overlapByKey = new Map();
    if (xref && xref.trackOverlap && Array.isArray(xref.trackOverlap.matches)) {
      xref.trackOverlap.matches.forEach(function (m) {
        if (!m || !m.targetTrack || m.matchType === 'none' || !m.ownedRelease) return;
        const k = (m.targetTrack.disc || 1) + ':' + (m.targetTrack.number || 0) + ':' + m.targetTrack.title;
        overlapByKey.set(k, m);
      });
    }

    let html = '';
    let activeDisc = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const disc = t.disc || 1;
      const mediaType = t.mediaType || 'CD';
      if (showDiscHeaders && disc !== activeDisc) {
        activeDisc = disc;
        html += '<div class="track-disc-header">Disc ' + disc + ' · ' + escapeHTML(mediaType) + '</div>';
      }
      const numStr = String(t.number || (i + 1)).padStart(2, '0');
      const durStr = trackResolver && typeof trackResolver.formatDurationMs === 'function'
        ? trackResolver.formatDurationMs(t.durationMs)
        : '';
      const notesPill = t.notes
        ? '<span class="track-variant-pill">' + escapeHTML(t.notes) + '</span>'
        : '';
      const overlapKey = disc + ':' + (t.number || 0) + ':' + t.title;
      const overlapMatch = overlapByKey.get(overlapKey);
      let overlapTag = '';
      if (overlapMatch) {
        const ownedCat = escapeHTML(overlapMatch.ownedRelease.catNo || overlapMatch.ownedRelease.title || 'Owned');
        overlapTag = overlapMatch.matchType === 'exact'
          ? '<span class="track-overlap-tag">Owned · ' + ownedCat + '</span>'
          : '<span class="track-overlap-tag variant-only">Variant Owned · ' + ownedCat + '</span>';
      }
      const jaHTML = t.titleJa && t.titleJa !== t.title
        ? '<div class="track-title-ja">' + escapeHTML(t.titleJa) + '</div>'
        : '';
      const artistHTML = t.artist
        ? '<div class="track-artist">' + escapeHTML(t.artist) + '</div>'
        : '';
      html +=
        '<div class="track-row">' +
          '<span class="track-num">' + numStr + '</span>' +
          '<div class="track-main">' +
            '<div class="track-title-line"><span>' + escapeHTML(t.title) + '</span>' + notesPill + overlapTag + '</div>' +
            jaHTML +
            artistHTML +
          '</div>' +
          (durStr ? '<span class="track-dur">' + escapeHTML(durStr) + '</span>' : '') +
        '</div>';
    }
    return html;
  }

  function renderLightboxTracksPanel(item, xrefOverride) {
    const panel = document.getElementById('lbTracksPanel');
    if (!panel || !item) return;

    const key = getTrackReleaseKey(item);
    const info = getEffectiveTracksInfo(item);
    const tracks = Array.isArray(info.tracks) ? info.tracks : [];
    const isFetching = !!(key && trackFetchInFlight.has(key));

    const toggleBtn = document.getElementById('lbTracksToggleBtn');
    const headingEl = document.getElementById('lbTracksHeading');
    const sourceBadgeEl = document.getElementById('lbTrackSourceBadge');
    const chevronEl = document.getElementById('lbTracksChevron');
    const bodyEl = document.getElementById('lbTracksBody');
    const disclaimerEl = document.getElementById('lbTrackDisclaimer');
    const fetchBtn = document.getElementById('lbFetchTracksBtn');
    const switchBtn = document.getElementById('lbSwitchTrackSourceBtn');
    const resetBtn = document.getElementById('lbResetTracksBtn');
    const listEl = document.getElementById('lbTracksList');
    const editorDrawer = document.getElementById('lbTrackEditorDrawer');

    if (headingEl) {
      if (tracks.length > 0) {
        const discs = new Set(tracks.map(function (t) { return t.disc || 1; }));
        headingEl.textContent = 'Track List (' + tracks.length + (tracks.length === 1 ? ' track' : ' tracks') +
          (discs.size > 1 ? ' · ' + discs.size + ' discs' : '') + ')';
      } else {
        headingEl.textContent = isFetching ? 'Track List (Fetching...)' : 'Track List';
      }
    }

    const srcDisp = getTrackSourceDisplay(info);
    if (sourceBadgeEl) {
      if (srcDisp) {
        sourceBadgeEl.textContent = srcDisp.text;
        sourceBadgeEl.className = 'track-source-pill ' + srcDisp.cls;
      } else {
        sourceBadgeEl.textContent = '';
        sourceBadgeEl.className = 'track-source-pill hidden';
      }
    }

    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', tracksExpanded ? 'true' : 'false');
    if (chevronEl) chevronEl.textContent = tracksExpanded ? '▾' : '▸';
    if (bodyEl) bodyEl.classList.toggle('hidden', !tracksExpanded);

    if (disclaimerEl) {
      if (tracks.length > 0 && info.trackSource === 'itunes') {
        disclaimerEl.textContent = 'iTunes · Digital — may differ from physical CD editions (bonus tracks / Disc 2 omitted).';
        disclaimerEl.classList.remove('hidden');
      } else {
        disclaimerEl.textContent = '';
        disclaimerEl.classList.add('hidden');
      }
    }

    if (fetchBtn) {
      fetchBtn.disabled = isFetching;
      fetchBtn.textContent = isFetching ? 'Fetching...' : (tracks.length > 0 ? '↻ Refetch Tracks' : '↻ Fetch Tracks');
    }
    if (switchBtn) {
      switchBtn.disabled = isFetching;
      const targetSource = info.trackSource === 'itunes' ? 'musicbrainz' : 'itunes';
      switchBtn.textContent = targetSource === 'musicbrainz' ? 'Try MusicBrainz' : 'Try iTunes';
      switchBtn.setAttribute('data-target-source', targetSource);
    }
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !info.isOverride);
    }

    if (listEl) {
      if (isFetching && tracks.length === 0) {
        listEl.innerHTML = '<div class="lb-tracks-empty">Looking up track list...</div>';
      } else if (tracks.length === 0) {
        listEl.innerHTML = trackFetchAttempted.has(key)
          ? '<div class="lb-tracks-empty">No track list found automatically. Try switching source or paste tracks manually.</div>'
          : '<div class="lb-tracks-empty">No tracks loaded yet. Click Fetch Tracks or Edit / Paste.</div>';
      } else {
        const xref = xrefOverride !== undefined ? xrefOverride : getHuntCrossRef(item);
        listEl.innerHTML = buildTrackListRowsHTML(tracks, xref);
      }
    }

    if (editorDrawer) {
      editorDrawer.classList.toggle('hidden', !trackEditorOpen);
    }
  }

  async function fetchTracksForAlbum(item, sourceMode, force) {
    if (!item || !trackResolver) return;
    const key = getTrackReleaseKey(item);
    if (!key) return;
    const mode = sourceMode || 'auto';

    if (!force && mode === 'auto') {
      const current = getEffectiveTracksInfo(item);
      if (current.tracks.length > 0 || trackFetchAttempted.has(key) || trackFetchInFlight.has(key)) {
        return;
      }
    }

    if (trackFetchInFlight.has(key)) return;
    if (force && manualTracksByKey[key]) {
      showToast('Reset Override first to auto-fetch tracks');
      return;
    }

    trackFetchInFlight.add(key);
    const filteredBefore = getFilteredAlbums();
    const activeBefore = filteredBefore[state.lightboxIndex];
    if (activeBefore && activeBefore.id === item.id) {
      renderLightboxTracksPanel(activeBefore);
    }

    try {
      const res = await trackResolver.fetchTracksForItem(item, { source: mode });
      trackFetchAttempted.add(key);
      if (res && Array.isArray(res.tracks) && res.tracks.length > 0) {
        const resolvedSource = res.trackSource || (mode === 'itunes' ? 'itunes' : 'musicbrainz');
        const record = {
          releaseKey: key,
          catNo: item.regCatNo || item.catNo || '',
          mbid: res.mbid || '',
          trackSource: resolvedSource,
          sourceDetail: res.sourceDetail || '',
          fetchedAt: Date.now(),
          tracks: res.tracks
        };
        trackCacheByKey[key] = record;
        if (db && typeof db.putTrackCache === 'function') {
          await db.putTrackCache(record);
        }
        if (isCollectionMode()) {
          await syncOwnedReleaseTracksChange(item, res.tracks, resolvedSource);
          renderAll();
        } else {
          rebuildOwnedStateAndCovers();
          if (state.search) renderAll();
        }
        showToast('Loaded ' + res.tracks.length + ' tracks (' + (resolvedSource === 'itunes' ? 'iTunes' : 'MusicBrainz') + ')');
      } else {
        showToast('No track list found');
      }
    } catch (err) {
      trackFetchAttempted.add(key);
      showToast('Failed to load tracks');
    } finally {
      trackFetchInFlight.delete(key);
      const modal = document.getElementById('lightboxModal');
      if (modal && modal.classList.contains('open')) {
        const currentFiltered = getFilteredAlbums();
        const currentItem = currentFiltered[state.lightboxIndex];
        if (currentItem && currentItem.id === item.id) {
          renderLightboxTracksPanel(currentItem);
        }
      }
    }
  }

  function findMatchedTrackTitle(item, searchRaw) {
    if (!searchRaw) return '';
    const info = getEffectiveTracksInfo(item);
    const tracks = info && Array.isArray(info.tracks) ? info.tracks : [];
    if (tracks.length === 0) return '';

    const normForMatch = trackResolver && typeof coverResolver.normalizeForMatch === 'function'
      ? coverResolver.normalizeForMatch
      : (coverResolver.normalizeForMatch || null);
    const normQuery = normForMatch ? normForMatch(searchRaw) : '';

    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      const fields = [tr.title, tr.titleJa, tr.artist, tr.notes].filter(Boolean).join(' ');
      if (fields.toLowerCase().indexOf(searchRaw) !== -1) {
        return tr.title || tr.titleJa || '';
      }
      if (normForMatch && normQuery && normForMatch(fields).indexOf(normQuery) !== -1) {
        return tr.title || tr.titleJa || '';
      }
    }
    return '';
  }

  function getFilteredAlbums() {
    trackMatchesByAlbumId = {};
    if (isCollectionMode()) {
      return ownedDisplayItems.filter(function (item) {
        if (collectionCategory !== 'All' && item.category !== collectionCategory) {
          return false;
        }
        if (collectionQuickFilter === 'has-tracks') {
          if (getEffectiveTracksInfo(item).tracks.length === 0) return false;
        } else if (collectionQuickFilter === 'missing-tracks') {
          if (getEffectiveTracksInfo(item).tracks.length > 0) return false;
        } else if (collectionQuickFilter === 'has-notes') {
          if (!((item.notes && item.notes.trim()) || (item.purchaseShop && item.purchaseShop.trim()))) {
            return false;
          }
        }
        if (state.search) {
          const hay = [
            item.artist,
            item.artistJa,
            item.title,
            item.titleJa,
            item.catalog,
            item.catNo,
            item.editionLabel,
            item.barcode,
            item.purchaseShop,
            item.purchasePrice,
            item.purchaseDate,
            item.notes,
            item.category
          ].join(' ').toLowerCase();
          if (hay.indexOf(state.search) === -1) {
            const trackTitleMatch = findMatchedTrackTitle(item, state.search);
            if (!trackTitleMatch) return false;
            trackMatchesByAlbumId[item.id] = trackTitleMatch;
          }
        }
        return true;
      });
    }

    return ALBUMS.filter(function (item) {
      if (state.category !== 'All' && item.category !== state.category) {
        return false;
      }
      if (state.huntingOnly && state.acquiredMap[item.id]) {
        return false;
      }
      if (state.search) {
        const hay = [
          item.artist,
          item.artistJa,
          item.title,
          item.titleJa,
          item.catalog,
          item.regCatNo,
          item.barcode,
          item.filing,
          item.kana
        ].join(' ').toLowerCase();
        if (hay.indexOf(state.search) === -1) {
          const trackTitleMatch = findMatchedTrackTitle(item, state.search);
          if (!trackTitleMatch) {
            return false;
          }
          trackMatchesByAlbumId[item.id] = trackTitleMatch;
        }
      }
      return true;
    });
  }

  function getActiveVariant(item) {
    const cache = getActiveCoverCache();
    const entry = cache[item.id];
    if (entry && Array.isArray(entry.variants) && entry.variants.length > 0) {
      const idx = Math.max(0, Math.min(entry.selectedIndex || 0, entry.variants.length - 1));
      return {
        variant: entry.variants[idx],
        index: idx,
        total: entry.variants.length,
        variants: entry.variants
      };
    }
    return null;
  }

  async function resolveCoverForAlbum(item) {
    const cache = getActiveCoverCache();
    const mbVariants = await tryMusicBrainzCovers(item);
    const itunesVariants = await tryItunesCovers(item);
    const existingCustom = ((cache[item.id] && cache[item.id].variants) || []).filter(function (v) {
      return v.source === 'custom';
    });

    const merged = [];
    const seen = new Set();
    mbVariants.concat(itunesVariants, existingCustom).forEach(function (v) {
      if (v && v.url && !seen.has(v.url)) {
        seen.add(v.url);
        merged.push(v);
      }
    });

    merged.sort(function (a, b) {
      return (b.isRegular ? 1 : 0) - (a.isRegular ? 1 : 0);
    });

    cache[item.id] = {
      variants: merged,
      selectedIndex: 0
    };
    saveCoverCache();
    refreshCardDOM(item.id);
    return merged;
  }

  function setupIntersectionObserver() {
    if ('IntersectionObserver' in window) {
      cardObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('data-album-id');
            if (id) enqueueCoverLookup(id, false);
            cardObserver.unobserve(entry.target);
          }
        });
      }, { rootMargin: '250px 0px' });
    }
  }

  function observeCards() {
    const cache = getActiveCoverCache();
    const cards = document.querySelectorAll('[data-album-id]');
    cards.forEach(function (card) {
      const id = card.getAttribute('data-album-id');
      if (!id || cache[id]) return;
      if (cardObserver) {
        cardObserver.observe(card);
      } else {
        enqueueCoverLookup(id, false);
      }
    });
  }

  function enqueueCoverLookup(id, highPriority) {
    const cache = getActiveCoverCache();
    if (!id || cache[id] || inFlightIds.has(id) || queuedIds.has(id)) return;
    queuedIds.add(id);
    if (highPriority) {
      pendingQueue.unshift(id);
    } else {
      pendingQueue.push(id);
    }
    pumpLookupQueue();
  }

  function pumpLookupQueue() {
    const cache = getActiveCoverCache();
    while (activeWorkers < MAX_WORKERS && pendingQueue.length > 0) {
      const id = pendingQueue.shift();
      queuedIds.delete(id);
      if (!id || cache[id] || inFlightIds.has(id)) continue;

      const item = findActiveItemById(id);
      if (!item) continue;

      activeWorkers++;
      inFlightIds.add(id);
      setSpinner(id, true);

      resolveCoverForAlbum(item)
        .catch(function () {})
        .finally(function () {
          activeWorkers--;
          inFlightIds.delete(id);
          setSpinner(id, false);
          pumpLookupQueue();
        });
    }
  }

  function setSpinner(id, active) {
    const icon = document.getElementById('refresh-icon-' + id);
    if (icon) {
      if (active) icon.classList.add('spinning');
      else icon.classList.remove('spinning');
    }
  }

  function triggerCarouselAnimation(el, direction) {
    if (!el || !el.classList) return;
    const animClass = direction === 'next'
      ? 'carousel-anim-next'
      : direction === 'prev'
        ? 'carousel-anim-prev'
        : 'carousel-anim-flip';
    el.classList.remove('carousel-anim-next', 'carousel-anim-prev', 'carousel-anim-flip');
    void el.offsetWidth;
    el.classList.add(animClass);
  }

  function selectCoverVariant(id, index, directionOverride) {
    const cache = getActiveCoverCache();
    const entry = cache[id];
    if (!entry || !Array.isArray(entry.variants) || entry.variants.length === 0) return;
    const len = entry.variants.length;
    const prevIdx = entry.selectedIndex || 0;
    const direction = directionOverride || (index > prevIdx ? 'next' : index < prevIdx ? 'prev' : 'flip');
    entry.selectedIndex = ((index % len) + len) % len;
    refreshCardDOM(id, direction);
    if (isCollectionMode()) {
      persistOwnedCoverChange(id);
    } else {
      saveCoverCache();
      scheduleCloudPush();
    }
  }

  async function handlePerEntryRefresh(id, forceRefetch) {
    const item = findActiveItemById(id);
    if (!item || inFlightIds.has(id)) return;

    const existing = getActiveCoverCache()[id];
    if (!forceRefetch && existing && Array.isArray(existing.variants) && existing.variants.length > 1) {
      const nextIdx = ((existing.selectedIndex || 0) + 1) % existing.variants.length;
      selectCoverVariant(id, nextIdx, 'next');
      showToast('Edition ' + (nextIdx + 1) + '/' + existing.variants.length + ': ' + existing.variants[nextIdx].label);
      return;
    }

    const qIdx = pendingQueue.indexOf(id);
    if (qIdx !== -1) pendingQueue.splice(qIdx, 1);
    queuedIds.delete(id);

    inFlightIds.add(id);
    setSpinner(id, true);

    try {
      const variants = await resolveCoverForAlbum(item);
      if (variants.length > 0) {
        showToast('Loaded ' + variants.length + ' cover(s) (' + variants[0].label + ')');
      } else {
        showToast('Using bespoke Jewel Case SVG');
      }
    } finally {
      inFlightIds.delete(id);
      setSpinner(id, false);
      pumpLookupQueue();
    }
  }

  function buildCoverInnerHTML(item) {
    const fallbackURI = buildJewelCaseDataURI(item);
    const active = getActiveVariant(item);

    if (!active) {
      return '<img src="' + fallbackURI + '" alt="' + escapeAttr(item.title) + '" class="cover-img" />';
    }

    const variant = active.variant;
    const overlay = active.total > 1
      ? '<div class="edition-pill-overlay" data-stop-prop="1">' +
          '<button type="button" class="edition-step-btn" data-action="step-var" data-id="' + item.id + '" data-delta="-1" aria-label="Previous edition">&lsaquo;</button>' +
          '<span style="font-family:var(--font-mono); color:#6ee7b7; font-weight:700;">' + (active.index + 1) + '/' + active.total + '</span>' +
          '<span class="edition-label-truncate">' + escapeHTML(variant.label) + '</span>' +
          '<button type="button" class="edition-step-btn" data-action="step-var" data-id="' + item.id + '" data-delta="1" aria-label="Next edition">&rsaquo;</button>' +
        '</div>'
      : '<div class="edition-pill-overlay"><span class="edition-label-truncate">' + escapeHTML(variant.label) + '</span></div>';

    return (
      '<img src="' + fallbackURI + '" alt="" class="cover-img" />' +
      '<img src="' + escapeAttr(variant.url) + '" alt="' + escapeAttr(item.title) + '" loading="lazy" data-fallback-id="' + item.id + '" class="cover-img" />' +
      overlay
    );
  }

  function buildSingleVariantPillsHTML(item) {
    const active = getActiveVariant(item);
    if (!active || active.variants.length === 0) return '';
    return active.variants.map(function (v, idx) {
      const isSel = idx === active.index;
      return (
        '<button type="button" class="variant-pill ' + (isSel ? 'active' : '') + '" data-action="select-var" data-id="' + item.id + '" data-idx="' + idx + '">' +
        escapeHTML(v.label) + (v.catNo ? ' (' + escapeHTML(v.catNo) + ')' : '') +
        '</button>'
      );
    }).join('');
  }

  function refreshCardDOM(id, direction) {
    const item = findActiveItemById(id);
    if (!item) return;
    const slot = document.getElementById('art-slot-' + id);
    if (slot) {
      slot.innerHTML = buildCoverInnerHTML(item);
      attachImageErrorHandlers(slot);
      if (direction) {
        triggerCarouselAnimation(slot, direction);
      }
    }
    const pillsBox = document.getElementById('single-variants-' + id);
    if (pillsBox) {
      pillsBox.innerHTML = buildSingleVariantPillsHTML(item);
    }
    const modal = document.getElementById('lightboxModal');
    if (modal.classList.contains('open')) {
      const filtered = getFilteredAlbums();
      if (filtered[state.lightboxIndex] && filtered[state.lightboxIndex].id === id) {
        renderLightbox(direction);
      }
    }
  }

  function attachImageErrorHandlers(root) {
    const cache = getActiveCoverCache();
    const imgs = (root || document).querySelectorAll('img[data-fallback-id]');
    imgs.forEach(function (img) {
      img.onerror = function () {
        const id = img.getAttribute('data-fallback-id');
        const entry = cache[id];
        if (entry && Array.isArray(entry.variants) && entry.variants.length > 0) {
          const idx = Math.max(0, Math.min(entry.selectedIndex || 0, entry.variants.length - 1));
          entry.variants.splice(idx, 1);
          entry.selectedIndex = 0;
          saveCoverCache();
          refreshCardDOM(id);
        }
      };
    });
  }

  function toggleAcquired(id) {
    if (state.acquiredMap[id]) {
      delete state.acquiredMap[id];
    } else {
      state.acquiredMap[id] = true;
    }
    saveChecklistSync();
    updateBatchGraduateButton();
    renderAll();
    if (document.getElementById('lightboxModal').classList.contains('open')) {
      renderLightbox();
    }
    scheduleCloudPush();
  }

  function renderCategoryPills() {
    const container = document.getElementById('categoryPills');
    if (isCollectionMode()) {
      const colCats = deriveCategories(ownedDisplayItems);
      if (colCats.every(function (c) { return c.key !== collectionCategory; })) {
        collectionCategory = 'All';
      }
      container.innerHTML = colCats.map(function (cat) {
        const count = cat.key === 'All'
          ? ownedDisplayItems.length
          : ownedDisplayItems.filter(function (a) { return a.category === cat.key; }).length;
        const active = collectionCategory === cat.key;
        return (
          '<button type="button" class="pill ' + (active ? 'active' : '') + '" data-action="set-cat" data-cat="' + escapeAttr(cat.key) + '">' +
          '<span class="pill-dot" style="background:' + cat.dot + ';"></span>' +
          '<span>' + escapeHTML(cat.label) + '</span>' +
          '<span style="opacity:0.65; font-family:var(--font-mono); font-size:10px;">' + count + '</span>' +
          '</button>'
        );
      }).join('');
      return;
    }

    container.innerHTML = CATEGORIES.map(function (cat) {
      const count = cat.key === 'All'
        ? ALBUMS.length
        : ALBUMS.filter(function (a) { return a.category === cat.key; }).length;
      const active = state.category === cat.key;
      return (
        '<button type="button" class="pill ' + (active ? 'active' : '') + '" data-action="set-cat" data-cat="' + escapeAttr(cat.key) + '">' +
        '<span class="pill-dot" style="background:' + cat.dot + ';"></span>' +
        '<span>' + escapeHTML(cat.label) + '</span>' +
        '<span style="opacity:0.65; font-family:var(--font-mono); font-size:10px;">' + count + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function getPriorityToneClass(priority) {
    if (!priority) return '';
    const text = String(priority);
    if (/high|must|★★★|\bp1\b|\b1\b/i.test(text)) return 'priority-high';
    if (/low|bargain|★\b|\bp3\b|\b3\b/i.test(text)) return 'priority-low';
    return 'priority-med';
  }

  function buildPriorityBadgeHTML(priority) {
    if (!priority) return '';
    return '<span class="priority-badge ' + getPriorityToneClass(priority) + '">Priority: ' + escapeHTML(priority) + '</span>';
  }

  function buildHuntOwnedBadgesHTML(xref) {
    if (!xref) return '';
    const badges = [];
    if (xref.status === 'exact') {
      badges.push('<span class="owned-badge owned-exact">✓ Owned</span>');
    } else if (xref.status === 'other_edition') {
      const first = xref.matchedReleases && xref.matchedReleases[0];
      const suffix = first && first.catNo ? ' (' + escapeHTML(first.catNo) + ')' : '';
      badges.push('<span class="owned-badge owned-other">Other Ed. Owned' + suffix + '</span>');
    }
    if (xref.trackOverlap && (xref.trackOverlap.exactCount > 0 || xref.trackOverlap.variantCount > 0)) {
      const ownedCount = xref.trackOverlap.exactCount + xref.trackOverlap.variantCount;
      badges.push(
        '<span class="owned-badge owned-tracks">Tracks Owned: ' + ownedCount + '/' + xref.trackOverlap.total + '</span>'
      );
    }
    if (badges.length === 0) return '';
    return '<div class="owned-badges-row">' + badges.join('') + '</div>';
  }

  function buildCardHTML(item, lightboxIdx) {
    const colMode = isCollectionMode();
    const isAcquired = !colMode && !!state.acquiredMap[item.id];
    const isDigital = !colMode && !!item.digitalOnly;
    const spinningClass = inFlightIds.has(item.id) ? 'spinning' : '';
    const cardClasses = 'cd-card' + (isAcquired ? ' acquired' : '') + (isDigital ? ' digital' : '');

    const matchedTrackTitle = state.search && trackMatchesByAlbumId[item.id] ? trackMatchesByAlbumId[item.id] : '';
    const trackChipHTML = matchedTrackTitle
      ? '<div class="track-match-chip" title="' + escapeAttr('Track match: ' + matchedTrackTitle) + '">♪ ' + escapeHTML(matchedTrackTitle) + '</div>'
      : '';

    if (colMode) {
      const effTracks = getEffectiveTracksInfo(item).tracks;
      const trackBadgeHTML = effTracks.length > 0
        ? '<span class="owned-badge owned-tracks">' + effTracks.length + (effTracks.length === 1 ? ' track' : ' tracks') + '</span>'
        : '<span class="owned-badge owned-other">No tracks</span>';
      const topLeftBadge = escapeHTML(item.editionLabel || item.category || 'Owned');

      if (state.viewMode === 'single') {
        const metaLines = [];
        if (item.purchaseShop) metaLines.push('<strong>Shop:</strong> ' + escapeHTML(item.purchaseShop));
        if (item.purchaseDate) metaLines.push('<strong>Date:</strong> ' + escapeHTML(item.purchaseDate));
        if (item.barcode) metaLines.push('<strong>Barcode:</strong> ' + escapeHTML(item.barcode));
        if (item.notes) metaLines.push('<strong>Notes:</strong> ' + escapeHTML(item.notes));
        if (metaLines.length === 0) metaLines.push('<strong>Category:</strong> ' + escapeHTML(item.category));

        return (
          '<article class="' + cardClasses + '" data-album-id="' + item.id + '" data-action="open-lb" data-lb-idx="' + lightboxIdx + '">' +
            '<div class="cover-box">' +
              '<div id="art-slot-' + item.id + '" style="width:100%; height:100%;">' + buildCoverInnerHTML(item) + '</div>' +
              '<span class="badge-kana">' + topLeftBadge + '</span>' +
            '</div>' +
            '<div class="single-meta">' +
              '<div id="single-variants-' + item.id + '" class="variant-pills-row">' + buildSingleVariantPillsHTML(item) + '</div>' +
              '<div class="single-top-row">' +
                '<div>' +
                  '<div class="single-artist">' + escapeHTML(item.artist) + '</div>' +
                  '<div class="single-artist-ja">' + escapeHTML(item.artistJa) + '</div>' +
                '</div>' +
                '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;">' +
                  trackBadgeHTML +
                  (item.purchasePrice ? '<span class="price-badge">' + escapeHTML(item.purchasePrice) + '</span>' : '') +
                '</div>' +
              '</div>' +
              '<div>' +
                '<h2 class="single-title">' + escapeHTML(item.title) + '</h2>' +
                '<p class="single-title-ja">' + escapeHTML(item.titleJa) + '</p>' +
                trackChipHTML +
              '</div>' +
              '<div class="badges-wrap">' +
                '<button type="button" class="chip-btn chip-mono" data-action="copy-cat" data-catno="' + escapeAttr(item.catNo || item.catalog) + '" title="Copy catalog number">' +
                  '<span>📋 ' + escapeHTML(item.catalog) + '</span>' +
                '</button>' +
                '<button type="button" class="chip-btn" data-action="refetch-one" data-id="' + item.id + '" style="color:#fcd34d;">' +
                  '<span id="refresh-icon-' + item.id + '" class="' + spinningClass + '" style="display:inline-block;">↻</span>' +
                  '<span>Re-fetch Covers</span>' +
                '</button>' +
                '<button type="button" class="chip-btn" data-action="edit-owned" data-id="' + item.id + '">Edit</button>' +
                '<button type="button" class="chip-btn" data-action="delete-owned" data-id="' + item.id + '" style="color:#fda4af;">Delete</button>' +
              '</div>' +
              '<div class="filing-box">' + metaLines.join(' · ') + '</div>' +
            '</div>' +
          '</article>'
        );
      }

      return (
        '<article class="' + cardClasses + '" data-album-id="' + item.id + '" data-action="open-lb" data-lb-idx="' + lightboxIdx + '">' +
          '<div class="cover-box">' +
            '<div id="art-slot-' + item.id + '" style="width:100%; height:100%;">' + buildCoverInnerHTML(item) + '</div>' +
            '<span class="badge-kana">' + escapeHTML(item.category) + '</span>' +
            (item.purchasePrice ? '<span class="badge-price-top">' + escapeHTML(item.purchasePrice) + '</span>' : '') +
            '<button type="button" class="refresh-cover-btn" data-action="cycle-one" data-id="' + item.id + '" title="Switch edition cover or fetch cover" aria-label="Refresh cover">' +
              '<span id="refresh-icon-' + item.id + '" class="' + spinningClass + '" style="display:inline-block; font-size:13px; font-weight:700;">↻</span>' +
            '</button>' +
          '</div>' +
          '<div class="grid-meta">' +
            '<div class="grid-artist">' + escapeHTML(item.artist) + '</div>' +
            '<div class="grid-title">' + escapeHTML(item.title) + '</div>' +
            '<div class="grid-cat">' + escapeHTML(item.catNo) + '</div>' +
            '<div class="owned-badges-row">' + trackBadgeHTML + '</div>' +
            trackChipHTML +
          '</div>' +
        '</article>'
      );
    }

    const xref = getHuntCrossRef(item);
    const ownedBadgesHTML = buildHuntOwnedBadgesHTML(xref);

    if (state.viewMode === 'single') {
      const shopsHTML = item.recommendedShops
        ? '<div class="shops-row"><strong>Recommended Shops:</strong> ' + escapeHTML(item.recommendedShops) + '</div>'
        : '';
      return (
        '<article class="' + cardClasses + '" data-album-id="' + item.id + '" data-action="open-lb" data-lb-idx="' + lightboxIdx + '">' +
          '<div class="cover-box">' +
            '<div id="art-slot-' + item.id + '" style="width:100%; height:100%;">' + buildCoverInnerHTML(item) + '</div>' +
            '<span class="badge-kana">' + escapeHTML(item.kana) + '</span>' +
            '<button type="button" class="check-btn ' + (isAcquired ? 'checked' : '') + '" data-action="toggle-acq" data-id="' + item.id + '" aria-label="Toggle acquired">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="single-meta">' +
            '<div id="single-variants-' + item.id + '" class="variant-pills-row">' + buildSingleVariantPillsHTML(item) + '</div>' +
            '<div class="single-top-row">' +
              '<div>' +
                '<div class="single-artist">' + escapeHTML(item.artist) + '</div>' +
                '<div class="single-artist-ja">' + escapeHTML(item.artistJa) + '</div>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end;">' +
                buildPriorityBadgeHTML(item.priority) +
                '<span class="price-badge">' + escapeHTML(item.price) + '</span>' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<h2 class="single-title">' + escapeHTML(item.title) + '</h2>' +
              '<p class="single-title-ja">' + escapeHTML(item.titleJa) + '</p>' +
              ownedBadgesHTML +
              trackChipHTML +
            '</div>' +
            '<div class="badges-wrap">' +
              '<button type="button" class="chip-btn chip-mono" data-action="copy-cat" data-catno="' + escapeAttr(item.regCatNo || item.catalog) + '" title="Copy catalog number">' +
                '<span>📋 ' + escapeHTML(item.catalog) + '</span>' +
              '</button>' +
              '<button type="button" class="chip-btn" data-action="refetch-one" data-id="' + item.id + '" style="color:#fcd34d;">' +
                '<span id="refresh-icon-' + item.id + '" class="' + spinningClass + '" style="display:inline-block;">↻</span>' +
                '<span>Re-fetch Covers</span>' +
              '</button>' +
            '</div>' +
            '<div class="filing-box">' +
              '<div><strong>' + (isDigital ? 'Note:' : 'どこで探す:') + '</strong> ' + escapeHTML(item.filing) + '</div>' +
              shopsHTML +
            '</div>' +
            '<button type="button" class="acquire-full-btn ' + (isAcquired ? 'is-acquired' : '') + '" data-action="toggle-acq" data-id="' + item.id + '">' +
              (isDigital
                ? (isAcquired ? '✓ Saved / Streamed' : '+ Mark Saved (Digital)')
                : (isAcquired ? '✓ In Crate (Acquired)' : '+ Mark Acquired')) +
            '</button>' +
          '</div>' +
        '</article>'
      );
    }

    // Compact Grid Card
    return (
      '<article class="' + cardClasses + '" data-album-id="' + item.id + '" data-action="open-lb" data-lb-idx="' + lightboxIdx + '">' +
        '<div class="cover-box">' +
          '<div id="art-slot-' + item.id + '" style="width:100%; height:100%;">' + buildCoverInnerHTML(item) + '</div>' +
          '<span class="badge-kana">' + escapeHTML(item.kana) + '</span>' +
          '<span class="badge-price-top">' + escapeHTML(item.price.split('(')[0].trim()) + '</span>' +
          '<button type="button" class="check-btn ' + (isAcquired ? 'checked' : '') + '" data-action="toggle-acq" data-id="' + item.id + '" aria-label="Toggle acquired">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="refresh-cover-btn" data-action="cycle-one" data-id="' + item.id + '" title="Switch edition cover or fetch cover" aria-label="Refresh cover">' +
            '<span id="refresh-icon-' + item.id + '" class="' + spinningClass + '" style="display:inline-block; font-size:13px; font-weight:700;">↻</span>' +
          '</button>' +
        '</div>' +
        '<div class="grid-meta">' +
          '<div class="grid-artist">' + escapeHTML(item.artist) + '</div>' +
          '<div class="grid-title">' + escapeHTML(item.title) + '</div>' +
          '<div class="grid-cat">' + escapeHTML(item.regCatNo || item.catalog) + '</div>' +
          ownedBadgesHTML +
          trackChipHTML +
        '</div>' +
      '</article>'
    );
  }

  function renderAll() {
    const colMode = isCollectionMode();
    const gridEl = document.getElementById('albumGrid');
    const digSection = document.getElementById('digitalOnlySection');
    const digGrid = document.getElementById('digitalGrid');
    const emptyBox = document.getElementById('emptyState');
    const layoutClass = state.viewMode === 'single' ? 'cd-single-col' : 'cd-grid';

    if (colMode) {
      const totalReleases = ownedDisplayItems.length;
      const totalTracks = ownedDisplayItems.reduce(function (sum, it) {
        return sum + getEffectiveTracksInfo(it).tracks.length;
      }, 0);
      document.getElementById('progressBadge').textContent =
        totalReleases + (totalReleases === 1 ? ' release' : ' releases') + ' · ' +
        totalTracks + (totalTracks === 1 ? ' track' : ' tracks');

      const filtered = getFilteredAlbums();
      const countLabel = 'Showing ' + filtered.length + ' of ' + totalReleases + ' owned releases';
      document.getElementById('visibleCountText').textContent = countLabel;
      document.getElementById('visibleCountTextAlt').textContent = countLabel;

      digGrid.innerHTML = '';
      digSection.classList.add('hidden');

      if (filtered.length === 0) {
        gridEl.innerHTML = '';
        gridEl.classList.add('hidden');
        emptyBox.classList.remove('hidden');
        return;
      }
      emptyBox.classList.add('hidden');
      gridEl.classList.remove('hidden');
      gridEl.className = layoutClass;
      gridEl.innerHTML = filtered.map(function (item, idx) {
        return buildCardHTML(item, idx);
      }).join('');
      attachImageErrorHandlers(document);
      observeCards();
      return;
    }

    const physicalAll = ALBUMS.filter(function (a) { return !a.digitalOnly; });
    const acquiredPhysical = physicalAll.filter(function (a) { return !!state.acquiredMap[a.id]; }).length;
    document.getElementById('progressBadge').textContent = acquiredPhysical + ' / ' + physicalAll.length;
    updateBatchGraduateButton();

    const filtered = getFilteredAlbums();
    const physicalFiltered = filtered.filter(function (a) { return !a.digitalOnly; });
    const digitalFiltered = filtered.filter(function (a) { return !!a.digitalOnly; });

    const countLabel = digitalFiltered.length > 0
      ? 'Showing ' + physicalFiltered.length + ' physical + ' + digitalFiltered.length + ' digital-only'
      : 'Showing ' + physicalFiltered.length + ' of ' + physicalAll.length + ' physical covers';
    document.getElementById('visibleCountText').textContent = countLabel;
    document.getElementById('visibleCountTextAlt').textContent = countLabel;

    if (filtered.length === 0) {
      gridEl.classList.add('hidden');
      digSection.classList.add('hidden');
      emptyBox.classList.remove('hidden');
      return;
    }
    emptyBox.classList.add('hidden');

    if (physicalFiltered.length > 0) {
      gridEl.classList.remove('hidden');
      gridEl.className = layoutClass;
      gridEl.innerHTML = physicalFiltered.map(function (item) {
        const lbIdx = filtered.findIndex(function (f) { return f.id === item.id; });
        return buildCardHTML(item, lbIdx);
      }).join('');
    } else {
      gridEl.innerHTML = '';
      gridEl.classList.add('hidden');
    }

    if (digitalFiltered.length > 0) {
      digSection.classList.remove('hidden');
      document.getElementById('digitalSectionCount').textContent = digitalFiltered.length + ' DIGITAL ' + (digitalFiltered.length === 1 ? 'TRACK' : 'TRACKS');
      digGrid.className = layoutClass;
      digGrid.innerHTML = digitalFiltered.map(function (item) {
        const lbIdx = filtered.findIndex(function (f) { return f.id === item.id; });
        return buildCardHTML(item, lbIdx);
      }).join('');
    } else {
      digGrid.innerHTML = '';
      digSection.classList.add('hidden');
    }

    attachImageErrorHandlers(document);
    observeCards();
  }

  // Lightbox Functions
  function openLightbox(idx) {
    const filtered = getFilteredAlbums();
    if (filtered.length === 0) return;
    const modal = document.getElementById('lightboxModal');
    const isAlreadyOpen = modal.classList.contains('open');
    const prevIdx = state.lightboxIndex;
    const nextIdx = Math.max(0, Math.min(idx, filtered.length - 1));
    state.lightboxIndex = nextIdx;
    modal.classList.add('open');
    const direction = isAlreadyOpen && nextIdx !== prevIdx
      ? (nextIdx > prevIdx ? 'next' : 'prev')
      : 'flip';
    renderLightbox(direction);
  }

  function closeLightbox() {
    document.getElementById('lightboxModal').classList.remove('open');
  }

  function stepLightbox(delta) {
    const filtered = getFilteredAlbums();
    if (filtered.length === 0) return;
    state.lightboxIndex = (state.lightboxIndex + delta + filtered.length) % filtered.length;
    renderLightbox(delta >= 0 ? 'next' : 'prev');
  }

  function renderLightbox(direction) {
    const filtered = getFilteredAlbums();
    if (filtered.length === 0) {
      closeLightbox();
      return;
    }
    if (state.lightboxIndex >= filtered.length) state.lightboxIndex = 0;
    const item = filtered[state.lightboxIndex];
    enqueueCoverLookup(item.id, true);

    if (activeTrackItemId !== item.id) {
      activeTrackItemId = item.id;
      trackEditorOpen = false;
      const initialTrackInfo = getEffectiveTracksInfo(item);
      tracksExpanded = !!(initialTrackInfo && initialTrackInfo.tracks && initialTrackInfo.tracks.length > 0);
    }

    document.getElementById('lbCounter').textContent = (state.lightboxIndex + 1) + ' / ' + filtered.length;
    document.getElementById('lbCategoryBadge').textContent = item.category;
    const priorityBadge = document.getElementById('lbPriorityBadge');
    if (priorityBadge) {
      if (item.priority) {
        priorityBadge.textContent = 'Priority: ' + item.priority;
        priorityBadge.className = 'priority-badge ' + getPriorityToneClass(item.priority);
      } else {
        priorityBadge.textContent = '';
        priorityBadge.className = 'priority-badge hidden';
      }
    }
    document.getElementById('lbArtist').textContent = item.artist;
    document.getElementById('lbArtistJa').textContent = item.artistJa;
    document.getElementById('lbTitle').textContent = item.title;
    document.getElementById('lbTitleJa').textContent = item.titleJa;
    document.getElementById('lbCatalogText').textContent = '📋 ' + item.catalog;
    document.getElementById('lbPrice').textContent = item.price;

    const colMode = isCollectionMode();
    const filingLabelEl = document.getElementById('lbFilingLabel');
    if (filingLabelEl) {
      filingLabelEl.textContent = colMode ? 'Collection Info:' : (item.digitalOnly ? 'Note:' : 'どこで探す (Shelf):');
    }
    if (colMode) {
      const infoParts = [];
      if (item.purchaseShop) infoParts.push('Shop: ' + item.purchaseShop);
      if (item.purchaseDate) infoParts.push('Date: ' + item.purchaseDate);
      if (item.barcode) infoParts.push('Barcode: ' + item.barcode);
      if (item.notes) infoParts.push('Notes: ' + item.notes);
      document.getElementById('lbFiling').textContent = infoParts.length > 0 ? infoParts.join(' · ') : 'In Owned Collection';
    } else {
      document.getElementById('lbFiling').textContent = item.filing;
    }

    const shopsRow = document.getElementById('lbShopsRow');
    const shopsEl = document.getElementById('lbShops');
    if (shopsRow && shopsEl) {
      if (!colMode && item.recommendedShops) {
        shopsEl.textContent = item.recommendedShops;
        shopsRow.classList.remove('hidden');
      } else {
        shopsEl.textContent = '';
        shopsRow.classList.add('hidden');
      }
    }

    const xref = !colMode ? getHuntCrossRef(item) : null;
    const crossRefBox = document.getElementById('lbOwnedCrossRefBox');
    if (crossRefBox) {
      const hasOverlap = !!(xref && xref.trackOverlap && (xref.trackOverlap.exactCount > 0 || xref.trackOverlap.variantCount > 0));
      if (!colMode && xref && (xref.status !== 'none' || hasOverlap)) {
        const lines = [];
        if (xref.status === 'exact') {
          const labels = (xref.matchedReleases || []).map(function (r) {
            return escapeHTML(r.catNo + (r.editionLabel ? ' (' + r.editionLabel + ')' : ''));
          }).join(', ');
          lines.push('<div><strong>✓ Exact Edition Already Owned:</strong> ' + labels + '</div>');
        } else if (xref.status === 'other_edition') {
          const labels = (xref.matchedReleases || []).map(function (r) {
            return escapeHTML(r.catNo + (r.editionLabel ? ' (' + r.editionLabel + ')' : ''));
          }).join(', ');
          lines.push('<div><strong>Other Edition Owned:</strong> ' + labels + '</div>');
        }
        if (hasOverlap) {
          const ov = xref.trackOverlap;
          const sourcesMap = new Map();
          ov.matches.forEach(function (m) {
            if (m && m.matchType !== 'none' && m.ownedRelease) {
              sourcesMap.set(m.ownedRelease.id, m.ownedRelease.catNo + ' (' + m.ownedRelease.title + ')');
            }
          });
          const summaryParts = [];
          if (ov.exactCount > 0) summaryParts.push(ov.exactCount + ' exact');
          if (ov.variantCount > 0) summaryParts.push(ov.variantCount + ' variant');
          lines.push(
            '<div><strong>Track Overlap:</strong> ' + summaryParts.join(', ') + ' of ' + ov.total + ' tracks · Found on: ' +
            escapeHTML(Array.from(sourcesMap.values()).join(', ')) + '</div>'
          );
        }
        crossRefBox.innerHTML = lines.join('');
        crossRefBox.className = 'lb-crossref-box' +
          (xref.status === 'other_edition' ? ' crossref-other' : xref.status === 'none' ? ' crossref-tracks' : '');
      } else {
        crossRefBox.innerHTML = '';
        crossRefBox.className = 'lb-crossref-box hidden';
      }
    }

    const artBox = document.getElementById('lbArtBox');
    artBox.innerHTML = buildCoverInnerHTML(item);
    attachImageErrorHandlers(artBox);
    if (direction) {
      triggerCarouselAnimation(artBox, direction);
    }

    const qText = typeof coverResolver.buildJacketSearchQuery === 'function'
      ? coverResolver.buildJacketSearchQuery(item)
      : [item.regCatNo || '', item.artist || '', item.titleJa || item.title || '', item.digitalOnly ? 'ジャケット' : '通常盤 CD'].filter(Boolean).join(' ').trim();
    document.getElementById('lbGoogleSearchLink').href = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(qText);

    const isAcquired = !colMode && !!state.acquiredMap[item.id];
    const acqBtn = document.getElementById('lbAcquireBtn');
    acqBtn.classList.toggle('hidden', colMode);
    if (!colMode) {
      acqBtn.textContent = item.digitalOnly
        ? (isAcquired ? '✓ Saved / Streamed' : '+ Mark Saved (Digital)')
        : (isAcquired ? '✓ In Crate (Acquired)' : '+ Mark Acquired');
    }

    const graduateBtn = document.getElementById('lbGraduateBtn');
    if (graduateBtn) {
      graduateBtn.classList.toggle('hidden', colMode || !!item.digitalOnly);
    }
    const editReleaseBtn = document.getElementById('lbEditReleaseBtn');
    if (editReleaseBtn) {
      editReleaseBtn.classList.toggle('hidden', !colMode);
    }
    const deleteReleaseBtn = document.getElementById('lbDeleteReleaseBtn');
    if (deleteReleaseBtn) {
      deleteReleaseBtn.classList.toggle('hidden', !colMode);
    }

    const activeInfo = getActiveVariant(item);
    const variantsPanel = document.getElementById('lbVariantsPanel');
    const variantsList = document.getElementById('lbVariantsList');
    if (activeInfo && activeInfo.variants.length > 0) {
      variantsPanel.classList.remove('hidden');
      document.getElementById('lbVariantsHeading').textContent = 'Saved Edition Covers (' + activeInfo.variants.length + ')';
      document.getElementById('lbActiveVariantBadge').textContent = activeInfo.variant.label;
      variantsList.innerHTML = activeInfo.variants.map(function (v, vIdx) {
        const isSel = vIdx === activeInfo.index;
        return (
          '<div class="lb-var-chip ' + (isSel ? 'active' : '') + '" data-action="select-var" data-id="' + item.id + '" data-idx="' + vIdx + '" style="cursor:pointer;">' +
            '<img src="' + escapeAttr(v.url) + '" alt="" class="lb-var-thumb" />' +
            '<div>' +
              '<div style="font-size:11px; font-weight:700; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHTML(v.label) + '</div>' +
              '<div style="font-family:var(--font-mono); font-size:9.5px; color:var(--text-muted);">' + escapeHTML(v.catNo || v.source) + '</div>' +
            '</div>' +
            '<button type="button" class="lb-var-del" data-action="del-var" data-id="' + item.id + '" data-idx="' + vIdx + '" aria-label="Remove variant">×</button>' +
          '</div>'
        );
      }).join('');
    } else {
      variantsPanel.classList.add('hidden');
    }

    const strip = document.getElementById('lbFilmstrip');
    strip.innerHTML = filtered.map(function (fItem, i) {
      const active = i === state.lightboxIndex;
      const actVar = getActiveVariant(fItem);
      const thumbSrc = actVar ? actVar.variant.url : buildJewelCaseDataURI(fItem);
      return (
        '<button type="button" class="film-thumb ' + (active ? 'active' : '') + '" data-action="open-lb" data-lb-idx="' + i + '">' +
          '<img src="' + escapeAttr(thumbSrc) + '" alt="" style="width:100%; height:100%; object-fit:cover;" />' +
        '</button>'
      );
    }).join('');

    renderLightboxTracksPanel(item, xref);
  }

  function copyText(text, customToast) {
    const toastMsg = customToast || ('Copied: ' + text);
    if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === 'function') {
      window.navigator.clipboard.writeText(text).then(
        function () { showToast(toastMsg); },
        function () { fallbackCopyText(text, toastMsg); }
      );
      return;
    }
    fallbackCopyText(text, toastMsg);
  }

  function fallbackCopyText(text, toastMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(toastMsg || ('Copied: ' + text));
    } catch (e) {
      showToast('Copy failed');
    }
    document.body.removeChild(ta);
  }

  function bindEvents() {
    async function submitCatalogUrl(rawUrl) {
      try {
        const res = await loadAndApplyCatalogFromUrl(rawUrl);
        if (res && res.type === 'index') {
          showToast('Repository presets loaded (' + res.catalogs.length + ')');
        } else if (!res || !res.toastShown) {
          showToast('Catalog loaded successfully');
        }
      } catch (err) {
        showErrorBanner('App Initialization Error: ' + (err && err.message ? err.message : String(err)));
        showCatalogLoader(true);
      }
    }

    document.addEventListener('click', function (e) {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');

      if (action === 'load-preset') {
        e.stopPropagation();
        const presetUrl = target.getAttribute('data-preset-url');
        const urlInput = document.getElementById('catalogUrlInput');
        if (urlInput && presetUrl) urlInput.value = presetUrl;
        submitCatalogUrl(presetUrl);
      } else if (action === 'set-cat') {
        e.stopPropagation();
        const chosenCat = target.getAttribute('data-cat') || 'All';
        if (isCollectionMode()) {
          collectionCategory = chosenCat;
        } else {
          state.category = chosenCat;
        }
        renderCategoryPills();
        renderAll();
      } else if (action === 'set-col-filter') {
        e.stopPropagation();
        collectionQuickFilter = target.getAttribute('data-filter') || 'all';
        const row = document.getElementById('collectionQuickFilters');
        if (row && typeof row.querySelectorAll === 'function') {
          row.querySelectorAll('[data-filter]').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-filter') === collectionQuickFilter);
          });
        }
        renderAll();
      } else if (action === 'toggle-acq') {
        e.stopPropagation();
        toggleAcquired(target.getAttribute('data-id'));
      } else if (action === 'edit-owned') {
        e.stopPropagation();
        openReleaseFormForEdit(target.getAttribute('data-id'));
      } else if (action === 'delete-owned') {
        e.stopPropagation();
        softDeleteOwnedRelease(target.getAttribute('data-id'));
      } else if (action === 'cycle-one') {
        e.stopPropagation();
        handlePerEntryRefresh(target.getAttribute('data-id'), false);
      } else if (action === 'refetch-one') {
        e.stopPropagation();
        handlePerEntryRefresh(target.getAttribute('data-id'), true);
      } else if (action === 'step-var') {
        e.stopPropagation();
        const id = target.getAttribute('data-id');
        const delta = parseInt(target.getAttribute('data-delta'), 10) || 1;
        const entry = getActiveCoverCache()[id];
        if (entry && Array.isArray(entry.variants)) {
          selectCoverVariant(id, (entry.selectedIndex || 0) + delta);
        }
      } else if (action === 'select-var') {
        e.stopPropagation();
        const id = target.getAttribute('data-id');
        const idx = parseInt(target.getAttribute('data-idx'), 10) || 0;
        selectCoverVariant(id, idx);
      } else if (action === 'del-var') {
        e.stopPropagation();
        const id = target.getAttribute('data-id');
        const idx = parseInt(target.getAttribute('data-idx'), 10) || 0;
        const entry = getActiveCoverCache()[id];
        if (entry && Array.isArray(entry.variants)) {
          entry.variants.splice(idx, 1);
          entry.selectedIndex = Math.max(0, Math.min(entry.selectedIndex || 0, entry.variants.length - 1));
          refreshCardDOM(id);
          if (isCollectionMode()) {
            persistOwnedCoverChange(id);
          } else {
            saveCoverCache();
            scheduleCloudPush();
          }
          showToast('Removed cover variant');
        }
      } else if (action === 'copy-cat') {
        e.stopPropagation();
        copyText(target.getAttribute('data-catno') || '');
      } else if (action === 'open-lb') {
        const idx = parseInt(target.getAttribute('data-lb-idx'), 10) || 0;
        openLightbox(idx);
      }
    });

    const modeHuntBtn = document.getElementById('modeHuntBtn');
    if (modeHuntBtn) {
      modeHuntBtn.addEventListener('click', function () {
        setAppMode('hunt');
      });
    }

    const modeCollectionBtn = document.getElementById('modeCollectionBtn');
    if (modeCollectionBtn) {
      modeCollectionBtn.addEventListener('click', function () {
        setAppMode('collection');
      });
    }

    document.getElementById('viewModeBtn').addEventListener('click', function () {
      state.viewMode = state.viewMode === 'grid' ? 'single' : 'grid';
      if (!isCollectionMode()) safeSetItem(VIEW_MODE_KEY, state.viewMode);
      document.getElementById('viewModeLabel').textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
      renderAll();
      if (!isCollectionMode()) scheduleCloudPush();
    });

    document.getElementById('huntingOnlyBtn').addEventListener('click', function () {
      state.huntingOnly = !state.huntingOnly;
      this.classList.toggle('btn-active-filter', state.huntingOnly);
      renderAll();
    });

    document.getElementById('refreshAllBtn').addEventListener('click', function () {
      state.coverCache = {};
      pendingQueue.length = 0;
      queuedIds.clear();
      inFlightIds.clear();
      safeRemoveItem(COVER_CACHE_KEY);
      renderAll();
      if (document.getElementById('lightboxModal').classList.contains('open')) {
        renderLightbox();
      }
      showToast('Cache cleared — resolving 通常盤 Regular covers first');
    });

    document.getElementById('openCrateFlipBtn').addEventListener('click', function () {
      openLightbox(0);
    });

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    searchInput.addEventListener('input', function () {
      state.search = searchInput.value.trim().toLowerCase();
      clearBtn.classList.toggle('visible', !!state.search);
      renderAll();
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      state.search = '';
      clearBtn.classList.remove('visible');
      renderAll();
    });

    document.getElementById('resetFiltersBtn').addEventListener('click', function () {
      searchInput.value = '';
      state.search = '';
      clearBtn.classList.remove('visible');
      if (isCollectionMode()) {
        collectionCategory = 'All';
        collectionQuickFilter = 'all';
        const row = document.getElementById('collectionQuickFilters');
        if (row) {
          row.querySelectorAll('[data-filter]').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-filter') === 'all');
          });
        }
      } else {
        state.category = 'All';
        state.huntingOnly = false;
        document.getElementById('huntingOnlyBtn').classList.remove('btn-active-filter');
      }
      renderCategoryPills();
      renderAll();
    });

    document.getElementById('dismissNoteBtn').addEventListener('click', function () {
      document.getElementById('digitalNoteBanner').classList.add('hidden');
      document.getElementById('compactCountBar').classList.remove('hidden');
      safeSetItem(NOTE_DISMISSED_KEY, '1');
      scheduleCloudPush();
    });

    document.getElementById('restoreNoteBtn').addEventListener('click', function () {
      document.getElementById('digitalNoteBanner').classList.remove('hidden');
      document.getElementById('compactCountBar').classList.add('hidden');
      safeRemoveItem(NOTE_DISMISSED_KEY);
      scheduleCloudPush();
    });

    document.getElementById('closeLightboxBtn').addEventListener('click', closeLightbox);
    document.getElementById('lbPrevBtn').addEventListener('click', function () { stepLightbox(-1); });
    document.getElementById('lbNextBtn').addEventListener('click', function () { stepLightbox(1); });

    document.getElementById('lbCatalogBtn').addEventListener('click', function () {
      const filtered = getFilteredAlbums();
      const item = filtered[state.lightboxIndex];
      if (item) copyText(item.regCatNo || item.catalog);
    });

    document.getElementById('lbAcquireBtn').addEventListener('click', function () {
      const filtered = getFilteredAlbums();
      const item = filtered[state.lightboxIndex];
      if (item) toggleAcquired(item.id);
    });

    document.getElementById('lbRefreshCoverBtn').addEventListener('click', function () {
      const filtered = getFilteredAlbums();
      const item = filtered[state.lightboxIndex];
      if (item) handlePerEntryRefresh(item.id, true);
    });

    document.getElementById('lbToggleCustomBtn').addEventListener('click', function () {
      document.getElementById('customCoverDrawer').classList.toggle('open');
    });

    document.getElementById('saveCustomCoverBtn').addEventListener('click', function () {
      const filtered = getFilteredAlbums();
      const item = filtered[state.lightboxIndex];
      const url = document.getElementById('customCoverInput').value.trim();
      const label = document.getElementById('customCoverLabel').value || 'Custom Jacket';
      if (!item || !url) return;

      const cache = getActiveCoverCache();
      if (!cache[item.id] || !Array.isArray(cache[item.id].variants)) {
        cache[item.id] = { variants: [], selectedIndex: 0 };
      }
      const variants = cache[item.id].variants;
      const refCat = item.catNo || item.regCatNo || '';
      variants.push({
        url: url,
        label: label,
        catNo: label.indexOf('通常') !== -1 ? refCat : '',
        source: 'custom',
        isRegular: label.indexOf('通常') !== -1
      });
      cache[item.id].selectedIndex = variants.length - 1;
      refreshCardDOM(item.id);
      if (isCollectionMode()) {
        persistOwnedCoverChange(item.id);
      } else {
        saveCoverCache();
        scheduleCloudPush();
      }
      document.getElementById('customCoverInput').value = '';
      showToast('Added cover variant: ' + label);
    });

    function getActiveLightboxItem() {
      const filtered = getFilteredAlbums();
      return filtered[state.lightboxIndex] || null;
    }

    function updateTrackEditorPreview() {
      const previewEl = document.getElementById('lbTrackEditorPreview');
      const inputEl = document.getElementById('lbTrackEditorInput');
      if (!previewEl || !inputEl) return;
      const parsed = trackResolver && typeof trackResolver.parseTracklistText === 'function'
        ? trackResolver.parseTracklistText(inputEl.value)
        : [];
      const discCount = new Set(parsed.map(function (t) { return t.disc || 1; })).size;
      previewEl.textContent = parsed.length + (parsed.length === 1 ? ' track' : ' tracks') +
        (discCount > 1 ? ' · ' + discCount + ' discs' : '');
    }

    const tracksToggleBtn = document.getElementById('lbTracksToggleBtn');
    if (tracksToggleBtn) {
      tracksToggleBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (!item) return;
        tracksExpanded = !tracksExpanded;
        renderLightboxTracksPanel(item);
        if (tracksExpanded) {
          const info = getEffectiveTracksInfo(item);
          const key = getTrackReleaseKey(item);
          if (info.tracks.length === 0 && !trackFetchAttempted.has(key) && !trackFetchInFlight.has(key)) {
            fetchTracksForAlbum(item, 'auto', false);
          }
        }
      });
    }

    const fetchTracksBtn = document.getElementById('lbFetchTracksBtn');
    if (fetchTracksBtn) {
      fetchTracksBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (!item) return;
        tracksExpanded = true;
        fetchTracksForAlbum(item, 'auto', true);
      });
    }

    const switchTrackSourceBtn = document.getElementById('lbSwitchTrackSourceBtn');
    if (switchTrackSourceBtn) {
      switchTrackSourceBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (!item) return;
        tracksExpanded = true;
        const targetSrc = switchTrackSourceBtn.getAttribute('data-target-source') || 'itunes';
        fetchTracksForAlbum(item, targetSrc, true);
      });
    }

    const editTracksBtn = document.getElementById('lbEditTracksBtn');
    if (editTracksBtn) {
      editTracksBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (!item) return;
        tracksExpanded = true;
        trackEditorOpen = !trackEditorOpen;
        if (trackEditorOpen) {
          const inputEl = document.getElementById('lbTrackEditorInput');
          if (inputEl) {
            const info = getEffectiveTracksInfo(item);
            inputEl.value = trackResolver && typeof trackResolver.formatTracklistForEdit === 'function'
              ? trackResolver.formatTracklistForEdit(info.tracks)
              : '';
          }
          updateTrackEditorPreview();
        }
        renderLightboxTracksPanel(item);
      });
    }

    const trackEditorInput = document.getElementById('lbTrackEditorInput');
    if (trackEditorInput) {
      trackEditorInput.addEventListener('input', updateTrackEditorPreview);
    }

    const cancelManualTracksBtn = document.getElementById('cancelManualTracksBtn');
    if (cancelManualTracksBtn) {
      cancelManualTracksBtn.addEventListener('click', function () {
        trackEditorOpen = false;
        const item = getActiveLightboxItem();
        if (item) renderLightboxTracksPanel(item);
      });
    }

    const saveManualTracksBtn = document.getElementById('saveManualTracksBtn');
    if (saveManualTracksBtn) {
      saveManualTracksBtn.addEventListener('click', async function () {
        const item = getActiveLightboxItem();
        const inputEl = document.getElementById('lbTrackEditorInput');
        if (!item || !inputEl || !trackResolver) return;
        const parsed = trackResolver.parseTracklistText(inputEl.value);
        if (parsed.length === 0) {
          showToast('Enter at least 1 track before saving');
          return;
        }
        const key = getTrackReleaseKey(item);
        if (!key) return;
        const record = {
          releaseKey: key,
          trackSource: 'manual',
          sourceDetail: 'Custom',
          updatedAt: Date.now(),
          tracks: parsed
        };
        manualTracksByKey[key] = record;
        if (db && typeof db.putManualTracks === 'function') {
          await db.putManualTracks(record);
        }
        trackEditorOpen = false;
        tracksExpanded = true;
        if (isCollectionMode()) {
          await syncOwnedReleaseTracksChange(item, parsed, 'manual');
          const refreshed = getActiveLightboxItem() || item;
          renderLightboxTracksPanel(refreshed);
          renderAll();
        } else {
          rebuildOwnedStateAndCovers();
          renderLightboxTracksPanel(item);
          if (state.search) renderAll();
        }
        showToast('Saved ' + parsed.length + ' tracks (Custom)');
      });
    }

    const resetTracksBtn = document.getElementById('lbResetTracksBtn');
    if (resetTracksBtn) {
      resetTracksBtn.addEventListener('click', async function () {
        const item = getActiveLightboxItem();
        if (!item) return;
        const key = getTrackReleaseKey(item);
        if (!key) return;
        const hadManual = !!manualTracksByKey[key];
        delete manualTracksByKey[key];
        if (db && typeof db.deleteManualTracks === 'function') {
          await db.deleteManualTracks(key);
        }
        trackEditorOpen = false;
        if (isCollectionMode()) {
          const fallbackCache = key ? trackCacheByKey[key] : null;
          await syncOwnedReleaseTracksChange(
            item,
            fallbackCache && Array.isArray(fallbackCache.tracks) ? fallbackCache.tracks : [],
            fallbackCache && fallbackCache.trackSource ? fallbackCache.trackSource : null
          );
          const refreshed = getActiveLightboxItem() || item;
          const nextInfo = getEffectiveTracksInfo(refreshed);
          renderLightboxTracksPanel(refreshed);
          renderAll();
          if (hadManual) {
            showToast(nextInfo.tracks.length > 0 ? 'Restored underlying track list' : 'Cleared custom track list');
          }
          return;
        }
        rebuildOwnedStateAndCovers();
        const nextInfo = getEffectiveTracksInfo(item);
        renderLightboxTracksPanel(item);
        if (state.search) renderAll();
        if (hadManual) {
          showToast(nextInfo.tracks.length > 0 ? 'Restored underlying track list' : 'Cleared custom track list');
        }
      });
    }

    const backupModal = document.getElementById('backupModal');
    const backupTextarea = document.getElementById('backupTextarea');

    document.getElementById('backupBtn').addEventListener('click', function () {
      backupTextarea.value = JSON.stringify({
        checklist: state.acquiredMap,
        covers: state.coverCache,
        viewMode: state.viewMode
      }, null, 2);
      backupModal.classList.add('open');
    });

    document.getElementById('closeBackupBtn').addEventListener('click', function () {
      backupModal.classList.remove('open');
    });

    document.getElementById('copyBackupBtn').addEventListener('click', function () {
      copyText(backupTextarea.value);
    });

    document.getElementById('importBackupBtn').addEventListener('click', function () {
      try {
        const parsed = JSON.parse(backupTextarea.value);
        if (parsed.checklist && typeof parsed.checklist === 'object') {
          state.acquiredMap = parsed.checklist;
          saveChecklistSync();
        }
        if (parsed.covers && typeof parsed.covers === 'object') {
          state.coverCache = parsed.covers;
          saveCoverCache();
        }
        if (parsed.viewMode === 'grid' || parsed.viewMode === 'single') {
          state.viewMode = parsed.viewMode;
          safeSetItem(VIEW_MODE_KEY, state.viewMode);
          document.getElementById('viewModeLabel').textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
        }
        renderAll();
        backupModal.classList.remove('open');
        scheduleCloudPush();
        showToast('Backup restored successfully');
      } catch (err) {
        showToast('Invalid JSON format');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (!document.getElementById('lightboxModal').classList.contains('open')) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    });

    let touchStartX = 0;
    let touchStartY = 0;
    const coverFrame = document.getElementById('lbCoverFrame');
    if (coverFrame) {
      coverFrame.addEventListener('touchstart', function (e) {
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        touchStartX = touch.screenX;
        touchStartY = typeof touch.screenY === 'number' ? touch.screenY : 0;
      }, { passive: true });
      coverFrame.addEventListener('touchend', function (e) {
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        const dx = touch.screenX - touchStartX;
        const dy = typeof touch.screenY === 'number' ? touch.screenY - touchStartY : 0;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
          stepLightbox(dx < 0 ? 1 : -1);
        }
      }, { passive: true });
    }

    // Catalog Metadata Loader Controls
    const openLoaderBtn = document.getElementById('openCatalogLoaderBtn');
    if (openLoaderBtn) {
      openLoaderBtn.addEventListener('click', function () {
        showCatalogLoader(true);
      });
    }

    const closeLoaderBtn = document.getElementById('closeCatalogLoaderBtn');
    if (closeLoaderBtn) {
      closeLoaderBtn.addEventListener('click', function () {
        if (!hasLoadedCatalog) return;
        clearErrorBanner();
        showCatalogLoader(false);
        renderAll();
      });
    }

    const loadUrlBtn = document.getElementById('loadCatalogUrlBtn');
    const urlInput = document.getElementById('catalogUrlInput');
    if (loadUrlBtn && urlInput) {
      loadUrlBtn.addEventListener('click', function () {
        submitCatalogUrl(urlInput.value);
      });
      urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitCatalogUrl(urlInput.value);
        }
      });
    }

    const loadFileBtn = document.getElementById('loadCatalogFileBtn');
    const fileInput = document.getElementById('catalogFileInput');
    if (loadFileBtn && fileInput) {
      loadFileBtn.addEventListener('click', function () {
        fileInput.click();
      });
      fileInput.addEventListener('change', async function (e) {
        const files = (e && e.target && e.target.files) || fileInput.files;
        const file = files && files[0];
        if (!file) return;
        try {
          const text = typeof file.text === 'function'
            ? await file.text()
            : await new Promise(function (resolve, reject) {
                const reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result || '')); };
                reader.onerror = function () { reject(new Error('Failed to read file')); };
                reader.readAsText(file);
              });
          const fileName = file.name || 'local-catalog.json';
          const isCsvFile =
            /\.csv$/i.test(fileName) ||
            (file.type && String(file.type).toLowerCase().indexOf('csv') !== -1);

          function applyLocalCsv(csvText) {
            const sheetParsed = sheetAdapter.parseGoogleSheetCsv(csvText, {});
            applyValidatedCatalog(sheetParsed.catalog, {
              fileName: fileName,
              sheetChecklist: sheetParsed.sheetChecklist
            });
            const dupSuffix =
              Array.isArray(sheetParsed.duplicates) && sheetParsed.duplicates.length > 0
                ? ' · ' + formatDuplicateWarningToast(sheetParsed.duplicates, false)
                : '';
            showToast('Loaded local CSV: ' + fileName + dupSuffix);
          }

          if (isCsvFile && sheetAdapter) {
            applyLocalCsv(text);
          } else {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (jsonErr) {
              if (sheetAdapter && /^\s*(?:Got it\?|Aisle|Category|Disk Crate|CD Hunt)/i.test(text.replace(/^\uFEFF/, ''))) {
                applyLocalCsv(text);
                return;
              }
              throw jsonErr;
            }
            const jsonDups =
              sheetAdapter && typeof sheetAdapter.detectCatalogDuplicates === 'function'
                ? sheetAdapter.detectCatalogDuplicates(parsed && parsed.items)
                : [];
            applyValidatedCatalog(parsed, { fileName: fileName });
            const dupSuffix = jsonDups.length > 0 ? ' · ' + formatDuplicateWarningToast(jsonDups, true) : '';
            showToast('Loaded local file: ' + fileName + dupSuffix);
          }
        } catch (err) {
          showErrorBanner('App Initialization Error: ' + (err && err.message ? err.message : String(err)));
          showCatalogLoader(true);
        } finally {
          fileInput.value = '';
        }
      });
    }

    const copyBotBtn = document.getElementById('copySheetBotEmailBtn');
    if (copyBotBtn) {
      copyBotBtn.addEventListener('click', function () {
        if (!sheetSyncBotEmail) return;
        copyText(sheetSyncBotEmail, 'Copied Sheet sync bot email');
      });
    }

    const shareBtn = document.getElementById('copyShareLinkBtn');
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        if (!activeCatalogUrl) return;
        copyText(buildShareUrl(activeCatalogUrl));
      });
    }

    const githubAuthBtn = document.getElementById('githubAuthBtn');
    if (githubAuthBtn) {
      githubAuthBtn.addEventListener('click', function () {
        if (!sync || !syncApiUrl) return;
        const loginUrl = sync.buildLoginUrl(syncApiUrl, window.location);
        if (loginUrl && window.location && typeof window.location.assign === 'function') {
          window.location.assign(loginUrl);
        } else if (loginUrl && window.location) {
          window.location.href = loginUrl;
        }
      });
    }

    const copyAgentLinkBtn = document.getElementById('copyAgentLinkBtn');
    if (copyAgentLinkBtn) {
      copyAgentLinkBtn.addEventListener('click', function () {
        if (!syncShareUrl) return;
        const suffix = isCollectionMode() ? '?format=markdown&include=collection' : '?format=markdown';
        copyText(syncShareUrl + suffix, 'Copied semi-private Agent status link');
      });
    }

    const githubSignOutBtn = document.getElementById('githubSignOutBtn');
    if (githubSignOutBtn) {
      githubSignOutBtn.addEventListener('click', function () {
        if (!sync) return;
        clearTimeout(syncPushTimer);
        syncPushTimer = null;
        clearTimeout(collectionSyncTimer);
        collectionSyncTimer = null;
        sync.clearAuthSession(storage);
        syncSession = null;
        syncShareUrl = null;
        syncPausedUntil = null;
        updateSyncUI();
        showToast('Signed out of cloud sync (local progress kept)');
      });
    }

    // ── Phase 2: Release Add / Edit Form Modal + Lookup + Graduation ──
    const releaseFormModal = document.getElementById('releaseFormModal');
    let rfDraftCustomCovers = null;
    let rfDraftSelectedVariant = null;
    let rfDraftTrackSource = 'manual';
    let rfDraftTracksOrigText = '';
    let rfLookupCandidates = [];

    function updateRfTracksPreview() {
      const previewEl = document.getElementById('rfTracksPreview');
      const inputEl = document.getElementById('rfTracksInput');
      if (!previewEl || !inputEl) return;
      const parsed = trackResolver && typeof trackResolver.parseTracklistText === 'function'
        ? trackResolver.parseTracklistText(inputEl.value)
        : [];
      const discCount = new Set(parsed.map(function (t) { return t.disc || 1; })).size;
      previewEl.textContent = parsed.length + (parsed.length === 1 ? ' track' : ' tracks') +
        (discCount > 1 ? ' · ' + discCount + ' discs' : '');
    }

    function openReleaseFormModal(prefill, headingText) {
      if (!releaseFormModal) return;
      const data = prefill || {};
      document.getElementById('releaseFormHeading').textContent = headingText || 'Add Owned Release';
      document.getElementById('rfId').value = data.id || '';
      document.getElementById('rfArtist').value = data.artist || '';
      document.getElementById('rfArtistJa').value = data.artistJa || '';
      document.getElementById('rfTitle').value = data.title || '';
      document.getElementById('rfTitleJa').value = data.titleJa || '';
      document.getElementById('rfCategory').value = data.category || (isCollectionMode() && collectionCategory !== 'All' ? collectionCategory : 'Soundtrack');
      document.getElementById('rfCatNo').value = data.catNo || '';
      document.getElementById('rfEditionLabel').value = data.editionLabel || '';
      document.getElementById('rfBarcode').value = data.barcode || '';
      document.getElementById('rfMbid').value = data.mbid || '';
      document.getElementById('rfPurchasePrice').value = data.purchasePrice || '';
      document.getElementById('rfPurchaseShop').value = data.purchaseShop || '';
      document.getElementById('rfPurchaseDate').value = data.purchaseDate || '';
      document.getElementById('rfNotes').value = data.notes || '';

      const tracksStr = Array.isArray(data.tracks) && data.tracks.length > 0 && trackResolver
        ? trackResolver.formatTracklistForEdit(data.tracks)
        : '';
      document.getElementById('rfTracksInput').value = tracksStr;
      rfDraftTracksOrigText = tracksStr;
      rfDraftTrackSource = data.trackSource || 'manual';
      rfDraftCustomCovers = data.customCovers || null;
      rfDraftSelectedVariant = data.selectedVariant || null;
      rfLookupCandidates = [];
      updateRfTracksPreview();

      const lookupInput = document.getElementById('releaseLookupInput');
      if (lookupInput) lookupInput.value = '';
      const lookupRes = document.getElementById('releaseLookupResults');
      if (lookupRes) {
        lookupRes.innerHTML = '';
        lookupRes.classList.add('hidden');
      }
      releaseFormModal.classList.add('open');
    }

    function openReleaseFormForEdit(releaseId) {
      const owned = findOwnedById(releaseId);
      if (!owned) return;
      const disp = collectionMod ? collectionMod.ownedToDisplayItem(owned) : null;
      const eff = disp ? getEffectiveTracksInfo(disp) : null;
      const mergedData = Object.assign({}, owned, {
        tracks: eff && eff.tracks && eff.tracks.length > 0 ? eff.tracks : (owned.tracks || []),
        trackSource: (eff && eff.trackSource) || owned.trackSource || 'manual'
      });
      openReleaseFormModal(mergedData, 'Edit Owned Release');
    }

    const addReleaseBtn = document.getElementById('addReleaseBtn');
    if (addReleaseBtn) {
      addReleaseBtn.addEventListener('click', function () {
        openReleaseFormModal(null, 'Add Owned Release');
      });
    }

    const lbEditReleaseBtn = document.getElementById('lbEditReleaseBtn');
    if (lbEditReleaseBtn) {
      lbEditReleaseBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (item) openReleaseFormForEdit(item.id);
      });
    }

    const lbDeleteReleaseBtn = document.getElementById('lbDeleteReleaseBtn');
    if (lbDeleteReleaseBtn) {
      lbDeleteReleaseBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (item) softDeleteOwnedRelease(item.id);
      });
    }

    const lbGraduateBtn = document.getElementById('lbGraduateBtn');
    if (lbGraduateBtn) {
      lbGraduateBtn.addEventListener('click', function () {
        const item = getActiveLightboxItem();
        if (!item || !collectionMod) return;
        const activeInfo = getActiveVariant(item);
        const effTracks = getEffectiveTracksInfo(item);
        const draft = collectionMod.graduateHuntItemToOwned(item, {
          activeVariant: activeInfo ? activeInfo.variant : null,
          selectedVariantIndex: activeInfo ? activeInfo.index : 0,
          effectiveTracksInfo: effTracks,
          customCoverEntry: state.coverCache[item.id] || null,
          existingIds: ownedAllReleases
        });
        draft.id = '';
        openReleaseFormModal(draft, 'Add Hunt Release to Collection');
      });
    }

    const batchGraduateBtn = document.getElementById('batchGraduateBtn');
    if (batchGraduateBtn) {
      batchGraduateBtn.addEventListener('click', async function () {
        if (!collectionMod || !db || typeof db.putOwnedReleasesBatch !== 'function') return;
        const usedIds = new Set(ownedAllReleases.map(function (r) { return r && r.id; }).filter(Boolean));
        const toCreate = [];
        const nowMs = Date.now();
        ALBUMS.forEach(function (item) {
          if (!item || item.digitalOnly || !state.acquiredMap[item.id]) return;
          const xref = ownedIndex
            ? collectionMod.crossReferenceHuntItem(item, ownedIndex, null, trackResolver)
            : { status: 'none' };
          if (xref.status === 'exact') return;
          const activeInfo = getActiveVariant(item);
          const effTracks = getEffectiveTracksInfo(item);
          const rec = collectionMod.graduateHuntItemToOwned(item, {
            activeVariant: activeInfo ? activeInfo.variant : null,
            selectedVariantIndex: activeInfo ? activeInfo.index : 0,
            effectiveTracksInfo: effTracks,
            customCoverEntry: state.coverCache[item.id] || null,
            existingIds: usedIds,
            nowMs: nowMs
          });
          usedIds.add(rec.id);
          toCreate.push(rec);
        });
        if (toCreate.length === 0) {
          showToast('All checked physical Hunt items are already owned');
          return;
        }
        const saved = await db.putOwnedReleasesBatch(toCreate);
        for (let i = 0; i < (saved || toCreate).length; i++) {
          await upsertLocalOwnedState((saved || toCreate)[i]);
        }
        renderAll();
        scheduleCollectionSync();
        showToast('Added ' + toCreate.length + (toCreate.length === 1 ? ' release' : ' releases') + ' to Owned Collection');
      });
    }

    const closeReleaseFormBtn = document.getElementById('closeReleaseFormBtn');
    const cancelReleaseFormBtn = document.getElementById('cancelReleaseFormBtn');
    if (closeReleaseFormBtn) {
      closeReleaseFormBtn.addEventListener('click', function () {
        if (releaseFormModal) releaseFormModal.classList.remove('open');
      });
    }
    if (cancelReleaseFormBtn) {
      cancelReleaseFormBtn.addEventListener('click', function () {
        if (releaseFormModal) releaseFormModal.classList.remove('open');
      });
    }

    const rfTracksInput = document.getElementById('rfTracksInput');
    if (rfTracksInput) {
      rfTracksInput.addEventListener('input', updateRfTracksPreview);
    }

    async function runReleaseLookup() {
      const inputEl = document.getElementById('releaseLookupInput');
      const resultsEl = document.getElementById('releaseLookupResults');
      if (!inputEl || !resultsEl || !trackResolver || typeof trackResolver.lookupReleaseCandidates !== 'function') return;
      const q = inputEl.value.trim();
      if (!q) return;
      resultsEl.classList.remove('hidden');
      resultsEl.innerHTML = '<div class="preset-sub">Searching MusicBrainz &amp; iTunes...</div>';
      try {
        const candidates = await trackResolver.lookupReleaseCandidates(q);
        rfLookupCandidates = Array.isArray(candidates) ? candidates : [];
        if (rfLookupCandidates.length === 0) {
          resultsEl.innerHTML = '<div class="preset-sub">No matching releases found — enter details manually below.</div>';
          return;
        }
        resultsEl.innerHTML = rfLookupCandidates.map(function (c, idx) {
          const trackCnt = Array.isArray(c.tracks) ? c.tracks.length : 0;
          return (
            '<button type="button" class="lookup-cand-btn" data-lookup-idx="' + idx + '">' +
              '<div style="min-width:0;">' +
                '<div style="font-size:12px; font-weight:700;">' + escapeHTML(c.artist + ' — ' + c.title) + '</div>' +
                '<div class="preset-sub">' + escapeHTML([c.catNo, c.editionLabel, c.barcode].filter(Boolean).join(' · ') || 'No catalog #') + '</div>' +
              '</div>' +
              '<span class="tag-sky">' + trackCnt + ' tracks</span>' +
            '</button>'
          );
        }).join('');
      } catch (err) {
        resultsEl.innerHTML = '<div class="preset-sub">Lookup unavailable offline.</div>';
      }
    }

    const releaseLookupBtn = document.getElementById('releaseLookupBtn');
    const releaseLookupInput = document.getElementById('releaseLookupInput');
    if (releaseLookupBtn) {
      releaseLookupBtn.addEventListener('click', runReleaseLookup);
    }
    if (releaseLookupInput) {
      releaseLookupInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          runReleaseLookup();
        }
      });
    }

    const releaseLookupResults = document.getElementById('releaseLookupResults');
    if (releaseLookupResults) {
      releaseLookupResults.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-lookup-idx]');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-lookup-idx'), 10);
        const c = rfLookupCandidates[idx];
        if (!c) return;
        document.getElementById('rfArtist').value = c.artist || '';
        document.getElementById('rfArtistJa').value = c.artistJa || '';
        document.getElementById('rfTitle').value = c.title || '';
        document.getElementById('rfTitleJa').value = c.titleJa || '';
        if (c.catNo) document.getElementById('rfCatNo').value = c.catNo;
        if (c.editionLabel) document.getElementById('rfEditionLabel').value = c.editionLabel;
        if (c.barcode) document.getElementById('rfBarcode').value = c.barcode;
        if (c.mbid) document.getElementById('rfMbid').value = c.mbid;
        if (Array.isArray(c.tracks) && c.tracks.length > 0 && trackResolver) {
          const text = trackResolver.formatTracklistForEdit(c.tracks);
          document.getElementById('rfTracksInput').value = text;
          rfDraftTracksOrigText = text;
          rfDraftTrackSource = c.trackSource || 'musicbrainz';
          updateRfTracksPreview();
        }
        releaseLookupResults.classList.add('hidden');
        showToast('Applied lookup candidate');
      });
    }

    const saveReleaseFormBtn = document.getElementById('saveReleaseFormBtn');
    if (saveReleaseFormBtn) {
      saveReleaseFormBtn.addEventListener('click', async function () {
        if (!collectionMod || !db || typeof db.putOwnedRelease !== 'function') return;
        const idVal = document.getElementById('rfId').value.trim();
        const artist = document.getElementById('rfArtist').value.trim();
        const artistJa = document.getElementById('rfArtistJa').value.trim();
        const title = document.getElementById('rfTitle').value.trim();
        const titleJa = document.getElementById('rfTitleJa').value.trim();
        const category = document.getElementById('rfCategory').value.trim() || 'Uncategorized';
        const rawCatNo = document.getElementById('rfCatNo').value.trim();
        const editionLabel = document.getElementById('rfEditionLabel').value.trim();
        const rawBarcode = document.getElementById('rfBarcode').value.trim();
        const mbid = document.getElementById('rfMbid').value.trim();
        const purchasePrice = document.getElementById('rfPurchasePrice').value.trim();
        const purchaseShop = document.getElementById('rfPurchaseShop').value.trim();
        const purchaseDate = document.getElementById('rfPurchaseDate').value.trim();
        const notes = document.getElementById('rfNotes').value.trim();
        const tracksText = document.getElementById('rfTracksInput').value;

        if (!artist || !title || !rawCatNo) {
          showToast('Artist, Title, and Catalog Number are required');
          return;
        }
        const cleanBarcode = rawBarcode.replace(/[\s-]+/g, '').trim();
        if (cleanBarcode && !/^\d{8,14}$/.test(cleanBarcode)) {
          showToast('Barcode must contain 8 to 14 digits');
          return;
        }
        if (mbid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mbid)) {
          showToast('MusicBrainz ID must be a valid UUID');
          return;
        }

        const existingOwned = idVal ? findOwnedById(idVal) : null;
        const parsedTracks = trackResolver && tracksText.trim()
          ? trackResolver.parseTracklistText(tracksText)
          : [];
        const tracksEdited = tracksText !== rfDraftTracksOrigText;
        const trackSource = parsedTracks.length > 0
          ? (tracksEdited ? 'manual' : (rfDraftTrackSource || 'manual'))
          : undefined;

        const nowMs = Date.now();
        const record = collectionMod.createOwnedRelease(
          {
            id: idVal || collectionMod.generateReleaseId(rawCatNo, ownedAllReleases),
            artist: artist,
            artistJa: artistJa,
            title: title,
            titleJa: titleJa,
            category: category,
            catNo: rawCatNo,
            editionLabel: editionLabel,
            barcode: cleanBarcode,
            mbid: mbid,
            tracks: parsedTracks.length > 0 ? parsedTracks : undefined,
            trackSource: trackSource,
            customCovers: (existingOwned && existingOwned.customCovers) || rfDraftCustomCovers || undefined,
            selectedVariant: (existingOwned && existingOwned.selectedVariant) || rfDraftSelectedVariant || undefined,
            purchasePrice: purchasePrice,
            purchaseShop: purchaseShop,
            purchaseDate: purchaseDate,
            notes: notes,
            createdAt: existingOwned && Number.isInteger(existingOwned.createdAt) ? existingOwned.createdAt : nowMs,
            clientUpdatedAt: nowMs,
            syncSeq: existingOwned && existingOwned.syncSeq !== undefined ? existingOwned.syncSeq : null,
            deletedAt: null,
            dirty: 1
          },
          nowMs
        );

        const stored = await db.putOwnedRelease(record);
        if (parsedTracks.length > 0 && tracksEdited && trackResolver && typeof db.putManualTracks === 'function') {
          const rKey = trackResolver.deriveTrackReleaseKey(collectionMod.ownedToDisplayItem(record));
          if (rKey) {
            const manualRec = {
              releaseKey: rKey,
              trackSource: 'manual',
              sourceDetail: 'Custom',
              updatedAt: nowMs,
              tracks: parsedTracks
            };
            manualTracksByKey[rKey] = manualRec;
            await db.putManualTracks(manualRec);
          }
        }

        await upsertLocalOwnedState(stored || record);
        if (releaseFormModal) releaseFormModal.classList.remove('open');
        renderCategoryPills();
        renderAll();
        const modal = document.getElementById('lightboxModal');
        if (isCollectionMode() && modal && modal.classList.contains('open')) {
          renderLightbox();
        }
        scheduleCollectionSync();
        showToast(existingOwned ? 'Updated release: ' + record.catNo : 'Added to Collection: ' + record.catNo);
      });
    }

    // ── Phase 2: Collection JSON & Google Sheet Sync Modal ──
    const collectionBackupModal = document.getElementById('collectionBackupModal');
    const collectionBackupBtn = document.getElementById('collectionBackupBtn');
    const collectionBackupTextarea = document.getElementById('collectionBackupTextarea');

    function openCollectionBackupModal() {
      if (!collectionBackupModal || !collectionMod) return;
      const snapshot = collectionMod.exportCollectionJson(
        ownedReleases,
        ownedSheetUrl ? { ownedSheetUrl: ownedSheetUrl } : undefined
      );
      if (collectionBackupTextarea) {
        collectionBackupTextarea.value = JSON.stringify(snapshot, null, 2);
      }
      const sheetInput = document.getElementById('ownedSheetUrlInput');
      if (sheetInput && !sheetInput.value && ownedSheetUrl) {
        sheetInput.value = ownedSheetUrl;
      }
      const botBanner = document.getElementById('ownedSheetBotBanner');
      if (botBanner) {
        if (sheetSyncBotEmail) {
          botBanner.textContent = 'Two-way Google Sheet sync: share your Owned Sheet as Editor with ' + sheetSyncBotEmail;
          botBanner.classList.remove('hidden');
        } else {
          botBanner.classList.add('hidden');
          loadSheetSyncBotInfo();
        }
      }
      const agentColBtn = document.getElementById('copyCollectionAgentLinkBtn');
      if (agentColBtn) {
        agentColBtn.classList.toggle('hidden', !(syncSession && syncShareUrl));
      }
      collectionBackupModal.classList.add('open');
    }

    if (collectionBackupBtn) {
      collectionBackupBtn.addEventListener('click', openCollectionBackupModal);
    }

    const closeCollectionBackupBtn = document.getElementById('closeCollectionBackupBtn');
    if (closeCollectionBackupBtn) {
      closeCollectionBackupBtn.addEventListener('click', function () {
        if (collectionBackupModal) collectionBackupModal.classList.remove('open');
      });
    }

    const copyCollectionBackupBtn = document.getElementById('copyCollectionBackupBtn');
    if (copyCollectionBackupBtn) {
      copyCollectionBackupBtn.addEventListener('click', function () {
        if (collectionBackupTextarea) copyText(collectionBackupTextarea.value, 'Copied Collection JSON');
      });
    }

    const downloadCollectionJsonBtn = document.getElementById('downloadCollectionJsonBtn');
    if (downloadCollectionJsonBtn) {
      downloadCollectionJsonBtn.addEventListener('click', function () {
        if (!collectionBackupTextarea) return;
        try {
          if (typeof Blob === 'function' && window.URL && typeof window.URL.createObjectURL === 'function') {
            const blob = new Blob([collectionBackupTextarea.value], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'owned-collection.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (typeof window.URL.revokeObjectURL === 'function') window.URL.revokeObjectURL(url);
            showToast('Downloaded owned-collection.json');
            return;
          }
        } catch (err) {}
        copyText(collectionBackupTextarea.value, 'Copied Collection JSON');
      });
    }

    const uploadCollectionJsonBtn = document.getElementById('uploadCollectionJsonBtn');
    const collectionJsonFileInput = document.getElementById('collectionJsonFileInput');
    if (uploadCollectionJsonBtn && collectionJsonFileInput) {
      uploadCollectionJsonBtn.addEventListener('click', function () {
        collectionJsonFileInput.click();
      });
      collectionJsonFileInput.addEventListener('change', async function (e) {
        const files = (e && e.target && e.target.files) || collectionJsonFileInput.files;
        const file = files && files[0];
        if (!file || !collectionBackupTextarea) return;
        try {
          const text = typeof file.text === 'function'
            ? await file.text()
            : await new Promise(function (resolve, reject) {
                const reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result || '')); };
                reader.onerror = function () { reject(new Error('Failed to read JSON file')); };
                reader.readAsText(file);
              });
          collectionBackupTextarea.value = text;
          showToast('Loaded ' + (file.name || 'file') + ' — click Merge JSON or Replace All');
        } catch (err) {
          showToast('Failed to read JSON file');
        } finally {
          collectionJsonFileInput.value = '';
        }
      });
    }

    async function handleCollectionJsonImport(mode) {
      if (!collectionMod || !db || !collectionBackupTextarea || typeof db.putOwnedReleasesBatch !== 'function') return;
      let parsed;
      try {
        parsed = JSON.parse(collectionBackupTextarea.value);
      } catch (err) {
        showToast('Invalid JSON format');
        return;
      }
      const plan = collectionMod.planCollectionJsonImport(parsed, ownedAllReleases, mode);
      if (!plan.ok) {
        showToast('Validation failed: ' + (plan.errors[0] || 'Invalid schema'));
        return;
      }
      if (plan.toUpsert.length > 0) {
        await db.putOwnedReleasesBatch(plan.toUpsert);
        await hydrateOwnedFromDb();
        scheduleCollectionSync();
      }
      if (collectionBackupModal) collectionBackupModal.classList.remove('open');
      showToast(
        'Collection import (' + mode + '): +' + plan.addedCount + ' added, ' +
        plan.updatedCount + ' updated' + (plan.deletedCount > 0 ? ', ' + plan.deletedCount + ' removed' : '')
      );
    }

    const importCollectionMergeBtn = document.getElementById('importCollectionMergeBtn');
    const importCollectionReplaceBtn = document.getElementById('importCollectionReplaceBtn');
    if (importCollectionMergeBtn) {
      importCollectionMergeBtn.addEventListener('click', function () { handleCollectionJsonImport('merge'); });
    }
    if (importCollectionReplaceBtn) {
      importCollectionReplaceBtn.addEventListener('click', function () { handleCollectionJsonImport('replace'); });
    }

    const copyCollectionAgentLinkBtn = document.getElementById('copyCollectionAgentLinkBtn');
    if (copyCollectionAgentLinkBtn) {
      copyCollectionAgentLinkBtn.addEventListener('click', function () {
        if (!syncShareUrl) return;
        copyText(syncShareUrl + '?format=markdown&include=collection', 'Copied Agent Collection status link');
      });
    }

    async function persistLastOwnedSheetUrl(url) {
      ownedSheetUrl = url;
      if (db && typeof db.getSyncMeta === 'function' && typeof db.putSyncMeta === 'function') {
        const meta = (await db.getSyncMeta('collectionSync')) || { lastSyncSeq: 0, lastPulledAt: 0, lastPushedAt: 0 };
        meta.lastOwnedSheetUrl = url;
        await db.putSyncMeta('collectionSync', meta);
      }
    }

    const importOwnedSheetBtn = document.getElementById('importOwnedSheetBtn');
    if (importOwnedSheetBtn) {
      importOwnedSheetBtn.addEventListener('click', async function () {
        if (!sheetAdapter || !collectionMod || !db || typeof db.putOwnedReleasesBatch !== 'function') return;
        const inputEl = document.getElementById('ownedSheetUrlInput');
        const rawUrl = inputEl ? inputEl.value.trim() : '';
        const csvUrl = normalizeCatalogUrl(rawUrl);
        if (!csvUrl || !sheetAdapter.isGoogleSheetCsvUrl(csvUrl)) {
          showToast('Enter a valid Google Sheet URL');
          return;
        }
        try {
          const res = await fetch(csvUrl);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const csvText = await res.text();
          const parsed = sheetAdapter.parseOwnedSheetCsv(csvText);
          const plan = collectionMod.planOwnedSheetMerge(parsed.items, ownedAllReleases);
          if (plan.toUpsert.length > 0) {
            await db.putOwnedReleasesBatch(plan.toUpsert);
          }
          await persistLastOwnedSheetUrl(rawUrl);
          await hydrateOwnedFromDb();
          scheduleCollectionSync();
          if (collectionBackupModal) collectionBackupModal.classList.remove('open');
          showToast('Imported Owned Sheet: +' + plan.addedCount + ' added, ' + plan.updatedCount + ' merged');
        } catch (err) {
          showToast('Failed to import Owned Sheet: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }

    const pushOwnedSheetBtn = document.getElementById('pushOwnedSheetBtn');
    if (pushOwnedSheetBtn) {
      pushOwnedSheetBtn.addEventListener('click', async function () {
        if (!sync || !syncApiUrl || !syncSession || typeof sync.pushOwnedSheetSync !== 'function') {
          showToast('Sign in with GitHub first to sync to Google Sheets');
          return;
        }
        const inputEl = document.getElementById('ownedSheetUrlInput');
        const rawUrl = inputEl ? inputEl.value.trim() : '';
        if (!rawUrl || (sheetAdapter && !sheetAdapter.isGoogleSheetCsvUrl(rawUrl))) {
          showToast('Enter a valid Google Sheet URL');
          return;
        }
        await persistLastOwnedSheetUrl(rawUrl);
        await syncCollectionNow();
        const res = await sync.pushOwnedSheetSync(syncApiUrl, syncSession.token, rawUrl);
        if (res.ok) {
          showToast('Synced ' + res.writtenRows + ' owned row(s) to Google Sheet');
        } else if (res.skipped) {
          showToast('Sheet sync unavailable: service account not configured');
        } else {
          showToast('Google Sheet sync failed: ' + (res.error || 'Try again later'));
        }
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        flushPendingCloudPush({ keepalive: true });
        flushPendingCollectionSync({ keepalive: true });
      }
    });
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', function () {
        flushPendingCloudPush({ keepalive: true });
        flushPendingCollectionSync({ keepalive: true });
      });
    }
  }

  async function initApp() {
    setupIntersectionObserver();
    bindEvents();

    const ns = window.DiskCrate || window.CDHunt || {};
    const cfg = ns.config || {};
    syncApiUrl = sync ? sync.resolveSyncApiUrl(window.location, storage, cfg) : '';
    if (sync && syncApiUrl) {
      const captured = sync.captureAuthTokenFromHash(window.location, window.history, storage);
      syncSession = captured || sync.getAuthSession(storage);
      updateSyncUI(syncSession ? 'Syncing...' : '', 'muted');
    } else {
      updateSyncUI();
    }

    try {
      const params = new URLSearchParams(window.location.search || '');
      const initialMode = params.get('mode') === 'collection' ? 'collection' : 'hunt';
      if (initialMode === 'collection') {
        appMode = 'collection';
        updateModeUI();
      }

      await hydrateTracksFromDb();
      await hydrateOwnedFromDb();

      let needsCloudBackfill = false;
      let statePullOk = false;
      if (sync && syncApiUrl && syncSession) {
        const pullRes = await sync.pullCloudState(syncApiUrl, syncSession.token);
        if (pullRes.unauthorized) {
          sync.clearAuthSession(storage);
          syncSession = null;
          syncShareUrl = null;
          updateSyncUI('Session expired', 'warn');
        } else if (pullRes.paused) {
          syncPausedUntil = pullRes.resetsAt || '00:00 UTC';
          updateSyncUI('Paused until 00:00 UTC', 'warn');
        } else if (pullRes.offline || !pullRes.ok) {
          updateSyncUI('Offline — saved locally', 'muted');
        } else {
          statePullOk = true;
          const localPayload = sync.buildLocalSyncPayload(storage, null, null, null);
          if (pullRes.state) {
            const mergeRes = sync.mergeAndApplyCloudState(storage, localPayload, pullRes.state);
            needsCloudBackfill = mergeRes.changedRemote;
          } else if (Object.keys(localPayload.catalogs).length > 0 || localPayload.activeCatalogUrl) {
            needsCloudBackfill = true;
          }
          syncShareUrl = pullRes.shareUrl || null;
          updateSyncUI('Synced', 'ok');
        }
      }

      if (statePullOk && syncSession) {
        await syncCollectionNow({ quietOnIdle: true });
      }

      const queryUrl = params.get('catalog');
      const savedUrl = typeof storage.getActiveCatalogUrl === 'function' ? storage.getActiveCatalogUrl() : null;
      const initialUrl = queryUrl || savedUrl;

      suppressSyncPush = true;
      try {
        if (initialUrl) {
          await loadAndApplyCatalogFromUrl(initialUrl);
        } else if (window.CD_HUNT_CATALOG) {
          applyValidatedCatalog(window.CD_HUNT_CATALOG, {});
        } else if (initialMode !== 'collection') {
          const loadedUserRepo = syncSession ? await tryLoadUserMetadataRepo(syncSession.user.login) : false;
          if (!loadedUserRepo) {
            showCatalogLoader(true);
          }
        }
        if (initialMode === 'collection') {
          setAppMode('collection', { skipQuerySync: true });
        }
      } finally {
        suppressSyncPush = false;
      }

      if (needsCloudBackfill && syncSession) {
        scheduleCloudPush();
      }
    } catch (err) {
      showErrorBanner('App Initialization Error: ' + (err && err.message ? err.message : String(err)));
      showCatalogLoader(true);
      console.error(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
