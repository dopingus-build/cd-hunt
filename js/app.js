(function () {
  'use strict';

  const CDHunt = window.CDHunt || {};
  const storage = CDHunt.storage;
  const coverResolver = CDHunt.coverResolver;
  const validateCatalog = window.validateCatalog || CDHunt.validateCatalog;

  if (!storage || !coverResolver) {
    throw new Error('Required CDHunt modules (storage, coverResolver) are not loaded.');
  }

  const safeGetItem = storage.safeGetItem;
  const safeSetItem = storage.safeSetItem;
  const safeRemoveItem = storage.safeRemoveItem;

  const escapeHTML = coverResolver.escapeHTML;
  const escapeAttr = coverResolver.escapeAttr;
  const buildJewelCaseDataURI = coverResolver.buildJewelCaseDataURI;
  const tryMusicBrainzCovers = coverResolver.tryMusicBrainzCovers;
  const tryItunesCovers = coverResolver.tryItunesCovers;

  let CHECKLIST_KEY = 'osaka_cd_checklist_v2';
  let COVER_CACHE_KEY = 'osaka_cd_cover_cache_v6';
  let VIEW_MODE_KEY = 'osaka_cd_view_mode_v1';
  let NOTE_DISMISSED_KEY = 'osaka_cd_note_dismissed_v1';

  let ALBUMS = [];
  let CATEGORIES = [];
  let CATALOG_META = {};

  function deriveCategories(items) {
    const cats = [{ key: 'All', label: 'All Releases', dot: '#a1a1aa' }];
    const seen = new Set(['All']);
    const palette = ['#f59e0b', '#f43f5e', '#10b981', '#38bdf8', '#a855f7', '#22d3ee'];
    let idx = 0;
    items.forEach(function (item) {
      if (item && item.category && !seen.has(item.category)) {
        seen.add(item.category);
        cats.push({
          key: item.category,
          label: item.category,
          dot: item.accent || palette[idx % palette.length]
        });
        idx++;
      }
    });
    return cats;
  }

  function applyCatalogData(catalog) {
    const data = catalog && typeof catalog === 'object' ? catalog : {};
    CATALOG_META = data.meta && typeof data.meta === 'object' ? data.meta : {};
    ALBUMS = Array.isArray(data.items) ? data.items : [];
    CATEGORIES = Array.isArray(data.categories) && data.categories.length > 0
      ? data.categories
      : deriveCategories(ALBUMS);

    const keys = storage.getStorageKeys(CATALOG_META.storagePrefix);
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
      document.getElementById('digitalNoteTag').textContent = 'DIGITAL-ONLY (' + digitalItems.length + ')';
      const namesHTML = digitalItems.map(function (d) {
        const shortTitle = String(d.title || '').split('(')[0].trim();
        return '<strong>' + escapeHTML(d.artist) + ' — ' + escapeHTML(shortTitle) + '</strong>';
      }).join(' &amp; ');
      document.getElementById('digitalNoteText').innerHTML = namesHTML + ' have no physical CDs (see section below).';
    }
  }

  async function loadCatalogData() {
    const params = new URLSearchParams(window.location.search);
    const customUrl = params.get('catalog');
    if (customUrl) {
      const res = await fetch(customUrl);
      if (!res.ok) throw new Error('Failed to load catalog from ' + customUrl + ' (HTTP ' + res.status + ')');
      return await res.json();
    }
    if (window.CD_HUNT_CATALOG) {
      return window.CD_HUNT_CATALOG;
    }
    try {
      const res = await fetch('./data/catalog.json');
      if (res.ok) return await res.json();
    } catch (e) {
      // Ignore file:// fetch errors
    }
    throw new Error('No catalog data found. Ensure data/catalog.js is present or pass ?catalog=<url>.');
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
    storage.purgeLegacyCoverCaches(CATALOG_META.storagePrefix);

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
    safeSetItem(COVER_CACHE_KEY, JSON.stringify(state.coverCache));
  }

  function getFilteredAlbums() {
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
          item.filing,
          item.kana
        ].join(' ').toLowerCase();
        if (hay.indexOf(state.search) === -1) {
          return false;
        }
      }
      return true;
    });
  }

  function getActiveVariant(item) {
    const entry = state.coverCache[item.id];
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
    const existingCustom = ((state.coverCache[item.id] && state.coverCache[item.id].variants) || []).filter(function (v) {
      return v.source === 'custom';
    });
    const mbVariants = await tryMusicBrainzCovers(item);
    const itunesVariants = await tryItunesCovers(item);

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

    state.coverCache[item.id] = {
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
    const cards = document.querySelectorAll('[data-album-id]');
    cards.forEach(function (card) {
      const id = card.getAttribute('data-album-id');
      if (!id || state.coverCache[id]) return;
      if (cardObserver) {
        cardObserver.observe(card);
      } else {
        enqueueCoverLookup(id, false);
      }
    });
  }

  function enqueueCoverLookup(id, highPriority) {
    if (!id || state.coverCache[id] || inFlightIds.has(id) || queuedIds.has(id)) return;
    queuedIds.add(id);
    if (highPriority) {
      pendingQueue.unshift(id);
    } else {
      pendingQueue.push(id);
    }
    pumpLookupQueue();
  }

  function pumpLookupQueue() {
    while (activeWorkers < MAX_WORKERS && pendingQueue.length > 0) {
      const id = pendingQueue.shift();
      queuedIds.delete(id);
      if (!id || state.coverCache[id] || inFlightIds.has(id)) continue;

      const item = ALBUMS.find(function (a) { return a.id === id; });
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

  function selectCoverVariant(id, index) {
    const entry = state.coverCache[id];
    if (!entry || !Array.isArray(entry.variants) || entry.variants.length === 0) return;
    const len = entry.variants.length;
    entry.selectedIndex = ((index % len) + len) % len;
    saveCoverCache();
    refreshCardDOM(id);
  }

  async function handlePerEntryRefresh(id, forceRefetch) {
    const item = ALBUMS.find(function (a) { return a.id === id; });
    if (!item || inFlightIds.has(id)) return;

    const existing = state.coverCache[id];
    if (!forceRefetch && existing && Array.isArray(existing.variants) && existing.variants.length > 1) {
      const nextIdx = ((existing.selectedIndex || 0) + 1) % existing.variants.length;
      selectCoverVariant(id, nextIdx);
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

  function refreshCardDOM(id) {
    const item = ALBUMS.find(function (a) { return a.id === id; });
    if (!item) return;
    const slot = document.getElementById('art-slot-' + id);
    if (slot) {
      slot.innerHTML = buildCoverInnerHTML(item);
      attachImageErrorHandlers(slot);
    }
    const pillsBox = document.getElementById('single-variants-' + id);
    if (pillsBox) {
      pillsBox.innerHTML = buildSingleVariantPillsHTML(item);
    }
    const modal = document.getElementById('lightboxModal');
    if (modal.classList.contains('open')) {
      const filtered = getFilteredAlbums();
      if (filtered[state.lightboxIndex] && filtered[state.lightboxIndex].id === id) {
        renderLightbox();
      }
    }
  }

  function attachImageErrorHandlers(root) {
    const imgs = (root || document).querySelectorAll('img[data-fallback-id]');
    imgs.forEach(function (img) {
      img.onerror = function () {
        const id = img.getAttribute('data-fallback-id');
        const entry = state.coverCache[id];
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
    renderAll();
    if (document.getElementById('lightboxModal').classList.contains('open')) {
      renderLightbox();
    }
  }

  function renderCategoryPills() {
    const container = document.getElementById('categoryPills');
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

  function buildCardHTML(item, lightboxIdx) {
    const isAcquired = !!state.acquiredMap[item.id];
    const isDigital = !!item.digitalOnly;
    const spinningClass = inFlightIds.has(item.id) ? 'spinning' : '';
    const cardClasses = 'cd-card' + (isAcquired ? ' acquired' : '') + (isDigital ? ' digital' : '');

    if (state.viewMode === 'single') {
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
              '<span class="price-badge">' + escapeHTML(item.price) + '</span>' +
            '</div>' +
            '<div>' +
              '<h2 class="single-title">' + escapeHTML(item.title) + '</h2>' +
              '<p class="single-title-ja">' + escapeHTML(item.titleJa) + '</p>' +
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
              '<strong>' + (isDigital ? 'Note:' : 'どこで探す:') + '</strong> ' + escapeHTML(item.filing) +
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
        '</div>' +
      '</article>'
    );
  }

  function renderAll() {
    const physicalAll = ALBUMS.filter(function (a) { return !a.digitalOnly; });
    const acquiredPhysical = physicalAll.filter(function (a) { return !!state.acquiredMap[a.id]; }).length;
    document.getElementById('progressBadge').textContent = acquiredPhysical + ' / ' + physicalAll.length;

    const filtered = getFilteredAlbums();
    const physicalFiltered = filtered.filter(function (a) { return !a.digitalOnly; });
    const digitalFiltered = filtered.filter(function (a) { return !!a.digitalOnly; });

    const countLabel = digitalFiltered.length > 0
      ? 'Showing ' + physicalFiltered.length + ' physical + ' + digitalFiltered.length + ' digital-only'
      : 'Showing ' + physicalFiltered.length + ' of ' + physicalAll.length + ' physical covers';
    document.getElementById('visibleCountText').textContent = countLabel;
    document.getElementById('visibleCountTextAlt').textContent = countLabel;

    const gridEl = document.getElementById('albumGrid');
    const digSection = document.getElementById('digitalOnlySection');
    const digGrid = document.getElementById('digitalGrid');
    const emptyBox = document.getElementById('emptyState');

    if (filtered.length === 0) {
      gridEl.classList.add('hidden');
      digSection.classList.add('hidden');
      emptyBox.classList.remove('hidden');
      return;
    }
    emptyBox.classList.add('hidden');

    const layoutClass = state.viewMode === 'single' ? 'cd-single-col' : 'cd-grid';

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
    state.lightboxIndex = Math.max(0, Math.min(idx, filtered.length - 1));
    document.getElementById('lightboxModal').classList.add('open');
    renderLightbox();
  }

  function closeLightbox() {
    document.getElementById('lightboxModal').classList.remove('open');
  }

  function stepLightbox(delta) {
    const filtered = getFilteredAlbums();
    if (filtered.length === 0) return;
    state.lightboxIndex = (state.lightboxIndex + delta + filtered.length) % filtered.length;
    renderLightbox();
  }

  function renderLightbox() {
    const filtered = getFilteredAlbums();
    if (filtered.length === 0) {
      closeLightbox();
      return;
    }
    if (state.lightboxIndex >= filtered.length) state.lightboxIndex = 0;
    const item = filtered[state.lightboxIndex];
    enqueueCoverLookup(item.id, true);

    document.getElementById('lbCounter').textContent = (state.lightboxIndex + 1) + ' / ' + filtered.length;
    document.getElementById('lbCategoryBadge').textContent = item.category;
    document.getElementById('lbArtist').textContent = item.artist;
    document.getElementById('lbArtistJa').textContent = item.artistJa;
    document.getElementById('lbTitle').textContent = item.title;
    document.getElementById('lbTitleJa').textContent = item.titleJa;
    document.getElementById('lbCatalogText').textContent = '📋 ' + item.catalog;
    document.getElementById('lbPrice').textContent = item.price;
    document.getElementById('lbFiling').textContent = item.filing;

    const artBox = document.getElementById('lbArtBox');
    artBox.innerHTML = buildCoverInnerHTML(item);
    attachImageErrorHandlers(artBox);

    const qText = (item.regCatNo || '') + ' ' + item.artist + ' ' + (item.titleJa || item.title) + ' 通常盤 CD';
    document.getElementById('lbGoogleSearchLink').href = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(qText);

    const isAcquired = !!state.acquiredMap[item.id];
    const acqBtn = document.getElementById('lbAcquireBtn');
    acqBtn.textContent = item.digitalOnly
      ? (isAcquired ? '✓ Saved / Streamed' : '+ Mark Saved (Digital)')
      : (isAcquired ? '✓ In Crate (Acquired)' : '+ Mark Acquired');

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
  }

  function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Copied: ' + text);
    } catch (e) {
      showToast('Copy failed');
    }
    document.body.removeChild(ta);
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');

      if (action === 'set-cat') {
        e.stopPropagation();
        state.category = target.getAttribute('data-cat') || 'All';
        renderCategoryPills();
        renderAll();
      } else if (action === 'toggle-acq') {
        e.stopPropagation();
        toggleAcquired(target.getAttribute('data-id'));
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
        const entry = state.coverCache[id];
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
        const entry = state.coverCache[id];
        if (entry && Array.isArray(entry.variants)) {
          entry.variants.splice(idx, 1);
          entry.selectedIndex = Math.max(0, Math.min(entry.selectedIndex || 0, entry.variants.length - 1));
          saveCoverCache();
          refreshCardDOM(id);
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

    document.getElementById('viewModeBtn').addEventListener('click', function () {
      state.viewMode = state.viewMode === 'grid' ? 'single' : 'grid';
      safeSetItem(VIEW_MODE_KEY, state.viewMode);
      document.getElementById('viewModeLabel').textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
      renderAll();
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
      state.category = 'All';
      state.huntingOnly = false;
      document.getElementById('huntingOnlyBtn').classList.remove('btn-active-filter');
      renderCategoryPills();
      renderAll();
    });

    document.getElementById('dismissNoteBtn').addEventListener('click', function () {
      document.getElementById('digitalNoteBanner').classList.add('hidden');
      document.getElementById('compactCountBar').classList.remove('hidden');
      safeSetItem(NOTE_DISMISSED_KEY, '1');
    });

    document.getElementById('restoreNoteBtn').addEventListener('click', function () {
      document.getElementById('digitalNoteBanner').classList.remove('hidden');
      document.getElementById('compactCountBar').classList.add('hidden');
      safeRemoveItem(NOTE_DISMISSED_KEY);
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

      if (!state.coverCache[item.id] || !Array.isArray(state.coverCache[item.id].variants)) {
        state.coverCache[item.id] = { variants: [], selectedIndex: 0 };
      }
      const variants = state.coverCache[item.id].variants;
      variants.push({
        url: url,
        label: label,
        catNo: label.indexOf('通常') !== -1 ? (item.regCatNo || '') : '',
        source: 'custom',
        isRegular: label.indexOf('通常') !== -1
      });
      state.coverCache[item.id].selectedIndex = variants.length - 1;
      saveCoverCache();
      refreshCardDOM(item.id);
      document.getElementById('customCoverInput').value = '';
      showToast('Added cover variant: ' + label);
    });

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
    const stage = document.getElementById('lbStage');
    stage.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      const dx = e.changedTouches[0].screenX - touchStartX;
      if (Math.abs(dx) > 45) {
        stepLightbox(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  }

  async function initApp() {
    try {
      const catalog = await loadCatalogData();
      if (typeof validateCatalog === 'function') {
        const validation = validateCatalog(catalog);
        if (!validation.valid) {
          throw new Error('Catalog validation failed: ' + validation.errors.join('; '));
        }
      }
      applyCatalogData(catalog);
      loadStateFromStorage();
      document.getElementById('viewModeLabel').textContent = state.viewMode === 'single' ? 'Grid View' : '1-Col View';
      setupIntersectionObserver();
      bindEvents();
      renderCategoryPills();
      renderAll();
    } catch (err) {
      const banner = document.getElementById('errorBanner');
      if (banner) {
        banner.style.display = 'block';
        banner.textContent = 'App Initialization Error: ' + (err && err.message ? err.message : String(err));
      }
      console.error(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
