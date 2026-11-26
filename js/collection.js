/**
 * @fileoverview Owned Collection domain logic: normalization, Hunt <-> Owned cross-referencing,
 * lossless JSON export/import planning, and non-destructive Owned Google Sheet merge
 * (window.DiskCrate.collection / legacy alias window.CDHunt.collection / CommonJS).
 */
(function (root) {
  'use strict';

  const validateMod =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./validate.js')
      : (root && (root.DiskCrate || root.CDHunt)) || root || {};

  const trackModDefault =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./track-resolver.js')
      : (root && (root.DiskCrate || root.CDHunt) && (root.DiskCrate || root.CDHunt).trackResolver) || {};

  const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff]/;
  const CAT_CODE_EXTRACT_REGEX = /\b([A-Z]{2,6}-\d{3,6}(?:[~～〜]\d+)?)\b/g;

  function cloneJson(val) {
    if (val === undefined || val === null) return val;
    try {
      return JSON.parse(JSON.stringify(val));
    } catch (e) {
      return val;
    }
  }

  function normalizeCatNo(raw) {
    return String(raw || '').trim().replace(/[～〜]/g, '~').toUpperCase();
  }

  function normalizeBarcode(raw) {
    const digits = String(raw || '').replace(/[\s-]+/g, '').trim();
    return /^\d{8,14}$/.test(digits) ? digits : '';
  }

  function slugify(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function normalizeIdSet(existingIds) {
    const set = new Set();
    if (!existingIds) return set;
    if (existingIds instanceof Set) {
      existingIds.forEach(function (v) { if (v) set.add(String(v)); });
    } else if (existingIds instanceof Map) {
      existingIds.forEach(function (_val, k) { if (k) set.add(String(k)); });
    } else if (Array.isArray(existingIds)) {
      existingIds.forEach(function (v) {
        if (typeof v === 'string') set.add(v);
        else if (v && v.id) set.add(String(v.id));
      });
    }
    return set;
  }

  function generateReleaseId(catNo, existingIds) {
    const used = normalizeIdSet(existingIds);
    const baseSlug = slugify(normalizeCatNo(catNo)) || 'release';
    const baseId = 'own-' + baseSlug;
    if (!used.has(baseId)) {
      return baseId;
    }
    let counter = 2;
    while (used.has(baseId + '-' + counter)) {
      counter++;
    }
    return baseId + '-' + counter;
  }

  function stripTrailingParens(str) {
    let cur = String(str || '');
    let prev;
    do {
      prev = cur;
      cur = cur.replace(/\s*(?:\([^()（）]*\)|（[^()（）]*）)\s*/g, ' ').trim();
    } while (cur !== prev);
    return cur.replace(/\s+/g, ' ').trim();
  }

  function normalizeTextKey(str) {
    return String(str || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '');
  }

  function extractItemCatCodes(item) {
    if (!item || typeof item !== 'object') return [];
    const codes = new Set();
    function addCode(raw) {
      const norm = normalizeCatNo(raw);
      if (!norm) return;
      if (/^(?:N\/A|DIGITAL|—|-|NONE)/i.test(norm)) return;
      codes.add(norm);
      if (norm.indexOf('~') !== -1) {
        const base = norm.split('~')[0].trim();
        if (base) codes.add(base);
      }
    }

    if (item.catNo) addCode(item.catNo);
    if (item.regCatNo) addCode(item.regCatNo);
    if (Array.isArray(item.mbEditions)) {
      item.mbEditions.forEach(function (ed) {
        if (ed && (ed.catno || ed.catNo)) addCode(ed.catno || ed.catNo);
      });
    }
    if (item.catalog) {
      let m;
      CAT_CODE_EXTRACT_REGEX.lastIndex = 0;
      const text = String(item.catalog);
      while ((m = CAT_CODE_EXTRACT_REGEX.exec(text)) !== null) {
        addCode(m[1]);
      }
    }
    return Array.from(codes);
  }

  function extractCustomOnlyCovers(coverEntry) {
    if (!coverEntry || !Array.isArray(coverEntry.variants)) return null;
    const customVariants = [];
    let selectedIndex = 0;
    coverEntry.variants.forEach(function (v, idx) {
      if (v && v.source === 'custom' && typeof v.url === 'string' && v.url.trim()) {
        if (idx === (coverEntry.selectedIndex || 0)) {
          selectedIndex = customVariants.length;
        }
        customVariants.push({
          url: String(v.url).trim(),
          label: String(v.label || 'Custom Jacket'),
          catNo: String(v.catNo || ''),
          source: 'custom',
          isRegular: !!v.isRegular
        });
      }
    });
    if (customVariants.length === 0) return null;
    return { variants: customVariants, selectedIndex: selectedIndex };
  }

  function createOwnedRelease(input, nowMs) {
    const src = input && typeof input === 'object' ? input : {};
    const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const catNo = normalizeCatNo(src.catNo || src.regCatNo || '');
    const tracks = Array.isArray(src.tracks) && src.tracks.length > 0
      ? (trackModDefault && typeof trackModDefault.normalizeTracksList === 'function'
          ? trackModDefault.normalizeTracksList(src.tracks)
          : cloneJson(src.tracks))
      : undefined;

    const record = {
      id: src.id ? String(src.id).trim().replace(/[^a-zA-Z0-9_-]/g, '') : generateReleaseId(catNo, src.existingIds),
      artist: String(src.artist || 'Unknown Artist').trim(),
      title: String(src.title || 'Untitled Release').trim(),
      category: String(src.category || 'Uncategorized').trim(),
      catNo: catNo || 'UNCATALOGED',
      createdAt: Number.isInteger(src.createdAt) ? src.createdAt : ts,
      clientUpdatedAt: Number.isInteger(src.clientUpdatedAt) ? src.clientUpdatedAt : ts,
      syncSeq: src.syncSeq === undefined ? null : src.syncSeq,
      deletedAt: src.deletedAt === undefined ? null : src.deletedAt,
      dirty: src.dirty === 0 ? 0 : 1
    };

    if (src.artistJa) record.artistJa = String(src.artistJa).trim();
    if (src.titleJa) record.titleJa = String(src.titleJa).trim();
    if (src.editionLabel) record.editionLabel = String(src.editionLabel).trim();
    const cleanBarcode = normalizeBarcode(src.barcode);
    if (cleanBarcode) record.barcode = cleanBarcode;
    if (src.mbid && String(src.mbid).trim()) record.mbid = String(src.mbid).trim();
    if (src.accent) record.accent = String(src.accent).trim();
    if (tracks && tracks.length > 0) {
      record.tracks = tracks;
      record.trackSource = src.trackSource || 'manual';
    } else if (src.trackSource) {
      record.trackSource = src.trackSource;
    }
    if (src.customCovers && typeof src.customCovers === 'object') {
      record.customCovers = cloneJson(src.customCovers);
    }
    if (src.selectedVariant && typeof src.selectedVariant === 'object') {
      record.selectedVariant = cloneJson(src.selectedVariant);
    }
    if (src.purchasePrice) record.purchasePrice = String(src.purchasePrice).trim();
    if (src.purchaseShop) record.purchaseShop = String(src.purchaseShop).trim();
    if (src.purchaseDate) record.purchaseDate = String(src.purchaseDate).trim();
    if (src.notes) record.notes = String(src.notes).trim();

    return record;
  }

  function ownedToDisplayItem(owned) {
    if (!owned || typeof owned !== 'object') return null;
    const catNo = normalizeCatNo(owned.catNo);
    const catalogStr = owned.editionLabel ? (catNo + ' (' + owned.editionLabel + ')') : catNo;
    const artistTerm = stripTrailingParens(owned.artistJa || owned.artist);
    const titleTerm = stripTrailingParens(owned.titleJa || owned.title);
    const requiredGroups = [];
    const titleKws = [titleTerm, owned.titleJa, owned.title].filter(Boolean);
    const artistKws = [artistTerm, owned.artistJa, owned.artist].filter(Boolean);
    if (titleKws.length > 0) requiredGroups.push(Array.from(new Set(titleKws)));
    if (artistKws.length > 0) requiredGroups.push(Array.from(new Set(artistKws)));

    const item = {
      id: owned.id,
      category: owned.category || 'Uncategorized',
      artist: owned.artist || 'Unknown Artist',
      artistJa: owned.artistJa || '',
      title: owned.title || 'Untitled Release',
      titleJa: owned.titleJa || '',
      catalog: catalogStr,
      regCatNo: catNo,
      catNo: catNo,
      editionLabel: owned.editionLabel || '',
      mbEditions: catNo ? [{ catno: catNo, label: owned.editionLabel || '通常盤 Regular' }] : [],
      barcode: owned.barcode || '',
      mbid: owned.mbid || '',
      kana: '—',
      filing: owned.purchaseShop
        ? (owned.purchaseShop + (owned.purchaseDate ? ' · ' + owned.purchaseDate : ''))
        : (owned.notes || 'Owned Release'),
      price: owned.purchasePrice || '—',
      purchasePrice: owned.purchasePrice || '',
      purchaseShop: owned.purchaseShop || '',
      purchaseDate: owned.purchaseDate || '',
      notes: owned.notes || '',
      accent: owned.accent || '',
      tracks: Array.isArray(owned.tracks) ? cloneJson(owned.tracks) : [],
      itunesQuery: [artistTerm, titleTerm].filter(Boolean).join(' ').trim(),
      requiredGroups: requiredGroups.length > 0 ? requiredGroups : [['Soundtrack']]
    };
    if (owned.trackSource) item.trackSource = owned.trackSource;
    return item;
  }

  function graduateHuntItemToOwned(huntItem, options) {
    const opts = options || {};
    const h = huntItem && typeof huntItem === 'object' ? huntItem : {};
    const activeVariant = opts.activeVariant || null;
    const effTracks = opts.effectiveTracksInfo || null;
    const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

    const firstEdCat = Array.isArray(h.mbEditions) && h.mbEditions[0] && h.mbEditions[0].catno
      ? h.mbEditions[0].catno
      : '';
    const extracted = extractItemCatCodes(h);
    const chosenCatNo = normalizeCatNo(
      (activeVariant && activeVariant.catNo) ||
      h.regCatNo ||
      firstEdCat ||
      extracted[0] ||
      h.id
    );
    const editionLabel = String((activeVariant && activeVariant.label) || opts.editionLabel || '通常盤 Regular').trim();

    const tracks = effTracks && Array.isArray(effTracks.tracks) && effTracks.tracks.length > 0
      ? effTracks.tracks
      : (Array.isArray(h.tracks) && h.tracks.length > 0 ? h.tracks : undefined);
    const trackSource = effTracks && effTracks.trackSource
      ? effTracks.trackSource
      : (tracks ? (h.trackSource || 'catalog') : undefined);

    const customCovers = extractCustomOnlyCovers(opts.customCoverEntry);
    const selectedVariant = activeVariant && activeVariant.url
      ? {
          url: String(activeVariant.url),
          selectedIndex: typeof opts.selectedVariantIndex === 'number' ? opts.selectedVariantIndex : 0,
          label: String(activeVariant.label || editionLabel)
        }
      : undefined;

    const rawMbid = String((effTracks && effTracks.mbid) || h.mbid || '').trim();
    const validMbid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawMbid)
      ? rawMbid
      : undefined;

    return createOwnedRelease(
      {
        id: generateReleaseId(chosenCatNo, opts.existingIds),
        artist: h.artist,
        artistJa: h.artistJa,
        title: h.title,
        titleJa: h.titleJa,
        category: h.category,
        catNo: chosenCatNo,
        editionLabel: editionLabel,
        barcode: h.barcode,
        mbid: validMbid,
        accent: h.accent,
        tracks: tracks,
        trackSource: trackSource,
        customCovers: customCovers,
        selectedVariant: selectedVariant,
        purchasePrice: opts.purchasePrice,
        purchaseShop: opts.purchaseShop,
        purchaseDate: opts.purchaseDate,
        notes: opts.notes,
        dirty: 1
      },
      nowMs
    );
  }

  function addMapList(map, key, val) {
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, [val]);
    } else {
      map.get(key).push(val);
    }
  }

  function getArtistTitleKeys(item) {
    if (!item) return [];
    const artists = [
      item.artist,
      item.artistJa,
      stripTrailingParens(item.artist),
      stripTrailingParens(item.artistJa)
    ].map(normalizeTextKey).filter(Boolean);
    const titles = [
      item.title,
      item.titleJa,
      stripTrailingParens(item.title),
      stripTrailingParens(item.titleJa)
    ].map(normalizeTextKey).filter(Boolean);

    const out = new Set();
    artists.forEach(function (a) {
      titles.forEach(function (t) {
        out.add(a + '|' + t);
      });
    });
    return Array.from(out);
  }

  function buildOwnedIndex(ownedReleases, trackResolverApi) {
    const trApi = trackResolverApi || trackModDefault;
    const byCatNo = new Map();
    const byBarcode = new Map();
    const byArtistTitle = new Map();
    const byTrackBase = new Map();
    const byTrackCompact = new Map();

    const active = (Array.isArray(ownedReleases) ? ownedReleases : []).filter(function (r) {
      return r && (r.deletedAt === null || r.deletedAt === undefined);
    });

    active.forEach(function (owned) {
      extractItemCatCodes(owned).forEach(function (code) {
        addMapList(byCatNo, code, owned);
      });

      const barcode = normalizeBarcode(owned.barcode);
      if (barcode) {
        addMapList(byBarcode, barcode, owned);
      }

      getArtistTitleKeys(owned).forEach(function (key) {
        addMapList(byArtistTitle, key, owned);
      });

      if (Array.isArray(owned.tracks) && owned.tracks.length > 0 && trApi && typeof trApi.normalizeTrackTitle === 'function') {
        owned.tracks.forEach(function (tr) {
          if (!tr || !tr.title) return;
          const forms = [trApi.normalizeTrackTitle(tr.title, tr.notes)];
          if (tr.titleJa) forms.push(trApi.normalizeTrackTitle(tr.titleJa, tr.notes));
          const validForms = forms.filter(function (f) { return !!(f && f.base); });
          if (validForms.length === 0) return;

          const entry = { ownedRelease: owned, track: tr, forms: validForms };
          validForms.forEach(function (f) {
            addMapList(byTrackBase, f.base, entry);
            if (f.compact) {
              addMapList(byTrackCompact, f.compact, entry);
            }
          });
        });
      }
    });

    return {
      activeCount: active.length,
      byCatNo: byCatNo,
      byBarcode: byBarcode,
      byArtistTitle: byArtistTitle,
      byTrackBase: byTrackBase,
      byTrackCompact: byTrackCompact
    };
  }

  function crossReferenceHuntItem(huntItem, ownedIndex, effectiveTracks, trackResolverApi) {
    if (!huntItem || !ownedIndex || ownedIndex.activeCount === 0) {
      return { status: 'none', matchedReleases: [], trackOverlap: null };
    }
    const trApi = trackResolverApi || trackModDefault;

    const exactMap = new Map();
    if (!huntItem.digitalOnly) {
      extractItemCatCodes(huntItem).forEach(function (code) {
        const list = ownedIndex.byCatNo.get(code) || [];
        list.forEach(function (ow) { exactMap.set(ow.id, ow); });
      });
      const barcode = normalizeBarcode(huntItem.barcode);
      if (barcode) {
        const list = ownedIndex.byBarcode.get(barcode) || [];
        list.forEach(function (ow) { exactMap.set(ow.id, ow); });
      }
    }

    let status = 'none';
    let matchedReleases = Array.from(exactMap.values());
    if (matchedReleases.length > 0) {
      status = 'exact';
    } else {
      const otherMap = new Map();
      getArtistTitleKeys(huntItem).forEach(function (key) {
        const list = ownedIndex.byArtistTitle.get(key) || [];
        list.forEach(function (ow) { otherMap.set(ow.id, ow); });
      });
      matchedReleases = Array.from(otherMap.values());
      if (matchedReleases.length > 0) {
        status = 'other_edition';
      }
    }

    const targets = Array.isArray(effectiveTracks) ? effectiveTracks : [];
    let trackOverlap = null;
    if (targets.length > 0 && trApi && typeof trApi.normalizeTrackTitle === 'function') {
      const matchedIdsSet = new Set(matchedReleases.map(function (r) { return r.id; }));
      let exactCount = 0;
      let variantCount = 0;

      const matches = targets.map(function (tr) {
        const tForms = [trApi.normalizeTrackTitle(tr.title, tr.notes)];
        if (tr.titleJa) tForms.push(trApi.normalizeTrackTitle(tr.titleJa, tr.notes));

        const candidateSet = new Set();
        tForms.forEach(function (f) {
          if (!f || !f.base) return;
          (ownedIndex.byTrackBase.get(f.base) || []).forEach(function (c) { candidateSet.add(c); });
          if (CJK_CHAR_REGEX.test(f.base) && f.compact) {
            (ownedIndex.byTrackCompact.get(f.compact) || []).forEach(function (c) { candidateSet.add(c); });
          }
        });

        let bestMatchType = 'none';
        let bestOwned = null;
        let bestTrack = null;
        let bestFromMatchedRelease = false;

        candidateSet.forEach(function (cand) {
          const candIsMatched = matchedIdsSet.has(cand.ownedRelease.id);
          for (let a = 0; a < tForms.length; a++) {
            const tf = tForms[a];
            if (!tf || !tf.base) continue;
            for (let b = 0; b < cand.forms.length; b++) {
              const of = cand.forms[b];
              const sameText =
                tf.base === of.base ||
                ((CJK_CHAR_REGEX.test(tf.base) || CJK_CHAR_REGEX.test(of.base)) && tf.compact === of.compact);
              if (!sameText) continue;

              const candType = tf.variant === of.variant ? 'exact' : 'variant';
              const isBetterType =
                (candType === 'exact' && bestMatchType !== 'exact') ||
                (candType === bestMatchType && candIsMatched && !bestFromMatchedRelease);
              if (bestMatchType === 'none' || isBetterType) {
                bestMatchType = candType;
                bestOwned = cand.ownedRelease;
                bestTrack = cand.track;
                bestFromMatchedRelease = candIsMatched;
              }
            }
          }
        });

        if (bestMatchType === 'exact') exactCount++;
        else if (bestMatchType === 'variant') variantCount++;

        return {
          targetTrack: tr,
          matchType: bestMatchType,
          matchedTrack: bestTrack,
          ownedRelease: bestOwned
        };
      });

      trackOverlap = {
        total: targets.length,
        exactCount: exactCount,
        variantCount: variantCount,
        matches: matches
      };
    }

    return {
      status: status,
      matchedReleases: matchedReleases,
      trackOverlap: trackOverlap
    };
  }

  function sanitizeOwnedForExport(record) {
    const clean = cloneJson(record);
    delete clean.dirty;
    if (clean.barcode === '') delete clean.barcode;
    if (clean.mbid === '') delete clean.mbid;
    return clean;
  }

  function exportCollectionJson(ownedReleases, meta) {
    const active = (Array.isArray(ownedReleases) ? ownedReleases : [])
      .filter(function (r) { return r && (r.deletedAt === null || r.deletedAt === undefined); })
      .map(sanitizeOwnedForExport);

    const out = {
      $schema: 'https://dopingus-build.github.io/disk-crate/schemas/collection.v1.schema.json',
      schemaVersion: 1,
      exportedAt: Date.now(),
      items: active
    };
    if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
      out.meta = cloneJson(meta);
    }
    return out;
  }

  function planCollectionJsonImport(parsedJson, existingReleases, mode, nowMs) {
    const validator = typeof validateMod.validateCollection === 'function' ? validateMod.validateCollection : null;
    if (validator) {
      const check = validator(parsedJson);
      if (!check.valid) {
        return { ok: false, errors: check.errors, toUpsert: [], addedCount: 0, updatedCount: 0, deletedCount: 0 };
      }
    } else if (!parsedJson || parsedJson.schemaVersion !== 1 || !Array.isArray(parsedJson.items)) {
      return { ok: false, errors: ['Invalid collection JSON payload'], toUpsert: [], addedCount: 0, updatedCount: 0, deletedCount: 0 };
    }

    const importMode = mode === 'replace' ? 'replace' : 'merge';
    const ts = typeof nowMs === 'number' ? nowMs : Date.now();
    const existingList = Array.isArray(existingReleases) ? existingReleases : [];

    const byId = new Map();
    const byCatEdition = new Map();
    const byBarcode = new Map();
    const usedIds = new Set();

    existingList.forEach(function (r) {
      if (!r || !r.id) return;
      usedIds.add(r.id);
      byId.set(r.id, r);
      if (r.deletedAt === null || r.deletedAt === undefined) {
        const ceKey = normalizeCatNo(r.catNo) + '|' + String(r.editionLabel || '').trim().toLowerCase();
        if (!byCatEdition.has(ceKey)) byCatEdition.set(ceKey, r);
        const bc = normalizeBarcode(r.barcode);
        if (bc && !byBarcode.has(bc)) byBarcode.set(bc, r);
      }
    });

    const toUpsert = [];
    const keptExistingIds = new Set();
    let addedCount = 0;
    let updatedCount = 0;

    parsedJson.items.forEach(function (rawItem) {
      if (!rawItem) return;
      let match = rawItem.id ? byId.get(rawItem.id) : null;
      if (!match) {
        const ceKey = normalizeCatNo(rawItem.catNo) + '|' + String(rawItem.editionLabel || '').trim().toLowerCase();
        match = byCatEdition.get(ceKey) || null;
      }
      if (!match) {
        const bc = normalizeBarcode(rawItem.barcode);
        if (bc) match = byBarcode.get(bc) || null;
      }

      if (match) {
        keptExistingIds.add(match.id);
        const merged = createOwnedRelease(
          Object.assign({}, match, rawItem, {
            id: match.id,
            createdAt: Number.isInteger(match.createdAt) ? match.createdAt : rawItem.createdAt,
            clientUpdatedAt: ts,
            syncSeq: match.syncSeq !== undefined ? match.syncSeq : null,
            deletedAt: null,
            dirty: 1
          }),
          ts
        );
        toUpsert.push(merged);
        updatedCount++;
      } else {
        const newId = rawItem.id && !usedIds.has(rawItem.id)
          ? rawItem.id
          : generateReleaseId(rawItem.catNo, usedIds);
        usedIds.add(newId);
        const created = createOwnedRelease(
          Object.assign({}, rawItem, {
            id: newId,
            clientUpdatedAt: ts,
            syncSeq: null,
            deletedAt: null,
            dirty: 1
          }),
          ts
        );
        toUpsert.push(created);
        addedCount++;
      }
    });

    let deletedCount = 0;
    if (importMode === 'replace') {
      existingList.forEach(function (r) {
        if (!r || !r.id) return;
        if ((r.deletedAt === null || r.deletedAt === undefined) && !keptExistingIds.has(r.id)) {
          toUpsert.push(
            Object.assign({}, cloneJson(r), {
              deletedAt: ts,
              clientUpdatedAt: ts,
              dirty: 1
            })
          );
          deletedCount++;
        }
      });
    }

    return {
      ok: true,
      errors: [],
      toUpsert: toUpsert,
      addedCount: addedCount,
      updatedCount: updatedCount,
      deletedCount: deletedCount
    };
  }

  function planOwnedSheetMerge(parsedSheetItems, existingReleases, nowMs) {
    const ts = typeof nowMs === 'number' ? nowMs : Date.now();
    const sheetRows = Array.isArray(parsedSheetItems) ? parsedSheetItems : [];
    const existingList = Array.isArray(existingReleases) ? existingReleases : [];

    const usedIds = new Set();
    const byCatNo = new Map();
    const byBarcode = new Map();

    existingList.forEach(function (r) {
      if (!r || !r.id) return;
      usedIds.add(r.id);
      if (r.deletedAt !== null && r.deletedAt !== undefined) return;
      addMapList(byCatNo, normalizeCatNo(r.catNo), r);
      const bc = normalizeBarcode(r.barcode);
      if (bc) addMapList(byBarcode, bc, r);
    });

    const toUpsert = [];
    let addedCount = 0;
    let updatedCount = 0;

    sheetRows.forEach(function (row) {
      if (!row || !row.catNo) return;
      const normCat = normalizeCatNo(row.catNo);
      const normEd = String(row.editionLabel || '').trim().toLowerCase();
      const catCandidates = byCatNo.get(normCat) || [];
      let match = null;
      if (normEd && catCandidates.length > 1) {
        match = catCandidates.find(function (c) {
          return String(c.editionLabel || '').trim().toLowerCase() === normEd;
        }) || catCandidates[0];
      } else if (catCandidates.length > 0) {
        match = catCandidates[0];
      }
      if (!match) {
        const bc = normalizeBarcode(row.barcode);
        if (bc) {
          const bcCandidates = byBarcode.get(bc) || [];
          match = bcCandidates[0] || null;
        }
      }

      if (match) {
        const merged = cloneJson(match);
        merged.catNo = normCat || merged.catNo;
        if (row.editionLabel) merged.editionLabel = row.editionLabel;
        if (row.category && row.category !== 'Uncategorized') merged.category = row.category;
        if (row.artist) merged.artist = row.artist;
        if (row.artistJa) merged.artistJa = row.artistJa;
        if (row.title) merged.title = row.title;
        if (row.titleJa) merged.titleJa = row.titleJa;
        const cleanBc = normalizeBarcode(row.barcode);
        if (cleanBc) merged.barcode = cleanBc;
        if (row.purchasePrice !== undefined && row.purchasePrice !== '') merged.purchasePrice = row.purchasePrice;
        if (row.purchaseShop !== undefined && row.purchaseShop !== '') merged.purchaseShop = row.purchaseShop;
        if (row.purchaseDate !== undefined && row.purchaseDate !== '') merged.purchaseDate = row.purchaseDate;
        if (row.notes !== undefined && row.notes !== '') merged.notes = row.notes;

        // Explicitly preserve structured local/synced fields: tracks, trackSource, mbid, customCovers, selectedVariant
        merged.clientUpdatedAt = ts;
        merged.dirty = 1;
        merged.deletedAt = null;
        toUpsert.push(merged);
        updatedCount++;
      } else {
        const newId = generateReleaseId(normCat, usedIds);
        usedIds.add(newId);
        const created = createOwnedRelease(
          Object.assign({}, row, {
            id: newId,
            clientUpdatedAt: ts,
            syncSeq: null,
            deletedAt: null,
            dirty: 1
          }),
          ts
        );
        toUpsert.push(created);
        addMapList(byCatNo, normCat, created);
        addedCount++;
      }
    });

    return {
      toUpsert: toUpsert,
      addedCount: addedCount,
      updatedCount: updatedCount
    };
  }

  const collectionApi = {
    normalizeCatNo: normalizeCatNo,
    normalizeBarcode: normalizeBarcode,
    generateReleaseId: generateReleaseId,
    createOwnedRelease: createOwnedRelease,
    ownedToDisplayItem: ownedToDisplayItem,
    graduateHuntItemToOwned: graduateHuntItemToOwned,
    buildOwnedIndex: buildOwnedIndex,
    crossReferenceHuntItem: crossReferenceHuntItem,
    exportCollectionJson: exportCollectionJson,
    planCollectionJsonImport: planCollectionJsonImport,
    planOwnedSheetMerge: planOwnedSheetMerge
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.collection = collectionApi;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = collectionApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
