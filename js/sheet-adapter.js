/**
 * @fileoverview Client-side Google Sheets CSV adapter and hybrid JSON overlay for CD Hunt.
 * Supports both Dashboard Layout and Flat Table Layout across the 9 canonical columns,
 * parses releases into schemaVersion 1 catalog objects, merges updates/new rows onto a
 * curated JSON catalog, and extracts catalog-number checklists for Sheet write-back.
 * Attaches to window.CDHunt.sheetAdapter and exports via CommonJS for Node tests.
 */
(function (root) {
  'use strict';

  const validateMod =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./validate.js')
      : (root && root.CDHunt) || root || {};

  const extractGoogleSheetId =
    validateMod.extractGoogleSheetId ||
    function (rawUrl) {
      const m = String(rawUrl || '').trim().match(
        /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)(?:\/[^\s?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i
      );
      if (!m) return null;
      const q = m[2] || '';
      const h = m[3] || '';
      const qg = q.match(/(?:^|&)gid=(\d+)/i);
      const hg = h.match(/(?:^|&)gid=(\d+)/i);
      return { sheetId: m[1], gid: (qg && qg[1]) || (hg && hg[1]) || null };
    };

  const CATEGORY_PALETTE = ['#f59e0b', '#f43f5e', '#10b981', '#38bdf8', '#a855f7', '#22d3ee'];
  const CAT_CODE_REGEX = /\b([A-Z]{2,6}-\d{3,6}(?:~\d+)?)\b/g;
  const SINGLE_CAT_CODE_REGEX = /^[A-Z]{2,6}-\d{3,6}(?:~\d+)?$/;

  /**
   * Parse RFC-4180 CSV text (supporting quoted commas, newlines, and escaped "" quotes).
   * @param {string} csvText
   * @returns {string[][]}
   */
  function parseCsv(csvText) {
    const clean = String(csvText || '').replace(/^\uFEFF/, '');
    if (!clean) return [];

    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') {
            currentCell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          currentCell += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentCell);
        currentCell = '';
      } else if (ch === '\r') {
        if (clean[i + 1] === '\n') i++;
        currentRow.push(currentCell);
        if (currentRow.some(function (cell) { return cell.trim() !== ''; })) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
      } else if (ch === '\n') {
        currentRow.push(currentCell);
        if (currentRow.some(function (cell) { return cell.trim() !== ''; })) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += ch;
      }
    }

    currentRow.push(currentCell);
    if (currentRow.some(function (cell) { return cell.trim() !== ''; })) {
      rows.push(currentRow);
    }

    return rows;
  }

  /**
   * Return true when the URL refers to a Google Spreadsheet (raw or CSV export URL).
   * @param {string} url
   * @returns {boolean}
   */
  function isGoogleSheetCsvUrl(url) {
    const str = String(url || '').trim();
    if (!str) return false;
    return Boolean(extractGoogleSheetId(str)) || /docs\.google\.com\/spreadsheets\/d\//i.test(str);
  }

  function normalizeHeaderKey(rawHeader) {
    return String(rawHeader || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function mapColumns(headerRow) {
    const map = {};
    for (let i = 0; i < headerRow.length; i++) {
      const key = normalizeHeaderKey(headerRow[i]);
      if (!key) continue;
      if (key === 'got it' || key === 'gotit' || key === 'acquired' || key === 'bought') {
        if (map.gotIt === undefined) map.gotIt = i;
      } else if (key.indexOf('aisle') !== -1 || key === 'category') {
        if (map.category === undefined) map.category = i;
      } else if (key.indexOf('artist') !== -1 || key === 'franchise') {
        if (map.artist === undefined) map.artist = i;
      } else if (key.indexOf('title') !== -1 || key.indexOf('release') !== -1) {
        if (map.title === undefined) map.title = i;
      } else if (key.indexOf('catalog') !== -1 || key === 'catno' || key === 'cat no') {
        if (map.catalog === undefined) map.catalog = i;
      } else if (key.indexOf('filing') !== -1 || key.indexOf('shelf') !== -1 || key.indexOf('location') !== -1) {
        if (map.filing === undefined) map.filing = i;
      } else if (key.indexOf('price') !== -1) {
        if (map.price === undefined) map.price = i;
      } else if (key === 'priority' || key.indexOf('priority') !== -1) {
        if (map.priority === undefined) map.priority = i;
      } else if (key.indexOf('recommended shop') !== -1 || key === 'shops' || key.indexOf('shop') !== -1) {
        if (map.recommendedShops === undefined) map.recommendedShops = i;
      } else if (key === 'id') {
        if (map.id === undefined) map.id = i;
      } else if (key === 'kana') {
        if (map.kana === undefined) map.kana = i;
      } else if (key === 'itunes query' || key === 'itunesquery') {
        if (map.itunesQuery === undefined) map.itunesQuery = i;
      }
    }
    return map;
  }

  function findHeaderRowIndex(rows) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const joined = row.map(normalizeHeaderKey);
      const hasGotIt = joined.some(function (k) { return k === 'got it' || k === 'acquired'; });
      const hasCatalogAndTitle =
        joined.some(function (k) { return k.indexOf('catalog') !== -1; }) &&
        joined.some(function (k) { return k.indexOf('title') !== -1; });
      if (hasGotIt || hasCatalogAndTitle) {
        return i;
      }
    }
    return -1;
  }

  function splitBilingualParen(rawText) {
    const trimmed = String(rawText || '').trim();
    const match = trimmed.match(/^(.*?)\s*[（(]([^()（）]*[\u3040-\u30ff\u3400-\u9fff][^()（）]*)[)）]\s*$/);
    if (match && match[1].trim()) {
      return { en: match[1].trim(), ja: match[2].trim() };
    }
    return { en: trimmed, ja: '' };
  }

  function extractCatalogCodes(rawCatalog, rawTitle) {
    const combined = [String(rawCatalog || ''), String(rawTitle || '')].join(' / ');
    const results = [];
    const seen = new Set();

    let match;
    CAT_CODE_REGEX.lastIndex = 0;
    while ((match = CAT_CODE_REGEX.exec(combined)) !== null) {
      const code = match[1];
      if (seen.has(code)) continue;
      seen.add(code);

      const tail = combined.slice(match.index + match[0].length, match.index + match[0].length + 40);
      const contextParen = tail.match(/^\s*\(([^)]+)\)/);
      const ctx = contextParen ? contextParen[1] : tail;
      const isLimited = /(初回|限定|limited|type\s*[ab]|anime|期間生産)/i.test(ctx);
      const isRegularHint = /(通常|reg\b|regular|std\b|standard)/i.test(ctx);

      let kind = 'other';
      if (isRegularHint && !isLimited) {
        kind = 'regular';
      } else if (isLimited) {
        kind = 'limited';
      }

      results.push({
        catno: code,
        kind: kind,
        label: kind === 'limited' ? (contextParen ? contextParen[1].trim() : '初回盤 Limited') : '通常盤 Regular'
      });
    }

    if (results.length > 0 && !results.some(function (r) { return r.kind === 'regular'; })) {
      const firstNonLimited = results.find(function (r) { return r.kind !== 'limited'; });
      if (firstNonLimited) {
        firstNonLimited.kind = 'regular';
        firstNonLimited.label = '通常盤 Regular';
      }
    }

    results.sort(function (a, b) {
      const rankA = a.kind === 'regular' ? 0 : a.kind === 'other' ? 1 : 2;
      const rankB = b.kind === 'regular' ? 0 : b.kind === 'other' ? 1 : 2;
      return rankA - rankB;
    });

    const regEntry = results.find(function (r) { return r.kind === 'regular'; }) || results[0] || null;
    return {
      regCatNo: regEntry ? regEntry.catno : '',
      mbEditions: results.map(function (r) { return { catno: r.catno, label: r.label }; }),
      allCodes: results.map(function (r) { return r.catno; })
    };
  }

  function extractKanaFromFiling(filingText) {
    const text = String(filingText || '').trim();
    if (!text) return '—';
    const lookMatch = text.match(/Look under\s+([^\s(（,;]+)/i);
    if (lookMatch && lookMatch[1]) {
      return lookMatch[1].replace(/[」"']+/g, '').trim() || '—';
    }
    const quotedKana = text.match(/[「"']([\u3040-\u30ffー]+)[」"']/);
    if (quotedKana && quotedKana[1]) {
      return quotedKana[1].trim();
    }
    return '—';
  }

  function slugify(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function cleanDisplayTitleForQuery(rawTitle) {
    return String(rawTitle || '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s*（[^）]*）\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'「]+|["'」]+$/g, '')
      .trim();
  }

  function buildRequiredGroups(artist, artistJa, title, titleJa) {
    const cleanTitle = cleanDisplayTitleForQuery(title) || String(title || '').trim();
    const titleGroup = [];
    if (cleanTitle) titleGroup.push(cleanTitle);
    if (titleJa && titleJa !== cleanTitle) titleGroup.push(titleJa);

    const groups = [];
    if (titleGroup.length > 0) {
      groups.push(titleGroup);
    }

    const artistGroup = [];
    if (artist) artistGroup.push(artist);
    if (artistJa && artistJa !== artist) artistGroup.push(artistJa);
    if (artistGroup.length > 0 && artistGroup[0] !== 'Various Artists') {
      groups.push(artistGroup);
    }

    if (groups.length === 0) {
      groups.push(['Soundtrack']);
    }
    return groups;
  }

  function isCheckedValue(val) {
    const norm = String(val || '').trim().toUpperCase();
    return norm === 'TRUE' || norm === 'YES' || norm === '1' || norm === '✓';
  }

  function deriveCategoriesFromItems(items) {
    const cats = [{ key: 'All', label: 'All Releases', dot: '#a1a1aa' }];
    const seen = new Set(['All']);
    let idx = 0;
    items.forEach(function (item) {
      if (item && item.category && !seen.has(item.category)) {
        seen.add(item.category);
        cats.push({
          key: item.category,
          label: item.category,
          dot: CATEGORY_PALETTE[idx % CATEGORY_PALETTE.length]
        });
        idx++;
      }
    });
    return cats;
  }

  /**
   * Parse CSV text from a canonical 9-column Google Sheet into a schemaVersion 1 catalog
   * plus extracted checklists.
   * @param {string} csvText
   * @param {{ sourceUrl?: string, googleSheetUrl?: string }} [options]
   * @returns {{
   *   catalog: { schemaVersion: 1, meta: object, categories: Array<object>, items: Array<object> },
   *   sheetChecklist: Record<string, boolean>,
   *   rowChecklistByCatNo: Record<string, boolean>
   * }}
   */
  function parseGoogleSheetCsv(csvText, options) {
    const opts = options || {};
    const rows = parseCsv(csvText);
    const headerIdx = findHeaderRowIndex(rows);
    if (headerIdx === -1) {
      throw new Error('Could not find canonical header row (Got it? / Catalog Number / Title) in Google Sheet CSV');
    }

    const colMap = mapColumns(rows[headerIdx]);
    if (colMap.title === undefined && colMap.artist === undefined) {
      throw new Error('Google Sheet header row is missing Artist or Title columns');
    }

    const meta = {};
    if (headerIdx >= 1 && rows[0] && String(rows[0][0] || '').trim()) {
      meta.title = String(rows[0][0]).trim();
      meta.documentTitle = meta.title + ' — CD Hunt';
    }
    if (headerIdx >= 2 && rows[1] && String(rows[1][0] || '').trim()) {
      const subText = String(rows[1][0]).trim();
      if (!/^TOTAL\s+PHYSICAL/i.test(subText) && !/^NOTE:/i.test(subText)) {
        meta.subtitle = subText;
      }
    }
    if (opts.googleSheetUrl || opts.sourceUrl) {
      meta.googleSheetUrl = String(opts.googleSheetUrl || opts.sourceUrl);
    }

    const items = [];
    const sheetChecklist = {};
    const rowChecklistByCatNo = {};
    const duplicates = [];
    const usedIds = new Set();
    const seenByCode = new Map();
    const seenByArtistTitle = new Map();
    let inDigitalSection = false;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const cell = function (idx) {
        return idx !== undefined && idx < row.length ? String(row[idx] || '').trim() : '';
      };

      const firstNonEmpty = row.find(function (c) { return String(c || '').trim() !== ''; }) || '';
      const firstTrimmed = firstNonEmpty.trim();

      if (/^Digital-Only Releases/i.test(firstTrimmed)) {
        inDigitalSection = true;
        continue;
      }
      if (/^(TOTAL\s+PHYSICAL|NOTE:)/i.test(firstTrimmed)) {
        continue;
      }

      const rawGotIt = cell(colMap.gotIt);
      const rawCategory = cell(colMap.category);
      const rawArtist = cell(colMap.artist);
      const rawTitle = cell(colMap.title);

      // Skip repeated header rows inside sections
      if (
        normalizeHeaderKey(rawGotIt) === 'got it' &&
        (normalizeHeaderKey(rawArtist).indexOf('artist') !== -1 || normalizeHeaderKey(rawCategory).indexOf('aisle') !== -1)
      ) {
        continue;
      }

      if (!rawArtist && !rawTitle) {
        continue;
      }

      const rawCatalog = cell(colMap.catalog) || (inDigitalSection ? 'N/A (Digital Only)' : '—');
      const rawFiling = cell(colMap.filing) || (inDigitalSection ? 'Digital-only release — skip physical shelf hunting.' : 'See Aisle / Category');
      const rawPrice = cell(colMap.price) || '—';
      const rawPriority = cell(colMap.priority);
      const rawRecommendedShops = cell(colMap.recommendedShops);
      const rawExplicitId = cell(colMap.id);
      const rawExplicitKana = cell(colMap.kana);
      const rawExplicitItunes = cell(colMap.itunesQuery);

      const artistSplit = splitBilingualParen(rawArtist || 'Unknown Artist');
      const titleSplit = splitBilingualParen(rawTitle || 'Untitled Release');
      const artist = artistSplit.en;
      const artistJa = artistSplit.ja;
      const title = rawTitle || 'Untitled Release';
      const titleJa = titleSplit.ja;

      const digitalOnly =
        inDigitalSection ||
        /^digital[\s-]*only$/i.test(rawCategory) ||
        /^n\/?a\s*\(digital\s*only\)/i.test(rawCatalog);

      const codeInfo = digitalOnly
        ? { regCatNo: '', mbEditions: [], allCodes: [] }
        : extractCatalogCodes(rawCatalog, rawTitle);

      let baseId = rawExplicitId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!baseId) {
        if (!digitalOnly && codeInfo.regCatNo) {
          baseId = 'sheet-' + slugify(codeInfo.regCatNo);
        } else {
          const fallbackSlug = slugify(artist + '-' + cleanDisplayTitleForQuery(title)) || ('row-' + r);
          baseId = (digitalOnly ? 'sheet-dig-' : 'sheet-') + fallbackSlug;
        }
      }
      let finalId = baseId;
      let dupCounter = 2;
      while (usedIds.has(finalId)) {
        finalId = baseId + '-' + dupCounter;
        dupCounter++;
      }
      usedIds.add(finalId);

      const kana = rawExplicitKana || (digitalOnly ? '—' : extractKanaFromFiling(rawFiling));
      const cleanTitleForSearch = cleanDisplayTitleForQuery(title) || title;
      const itunesQuery = rawExplicitItunes || [artist, cleanTitleForSearch].filter(Boolean).join(' ').trim();

      const item = {
        id: finalId,
        category: rawCategory || (digitalOnly ? 'Digital-Only' : 'Uncategorized'),
        artist: artist,
        title: title,
        catalog: rawCatalog,
        kana: kana,
        filing: rawFiling,
        price: rawPrice
      };

      if (artistJa) item.artistJa = artistJa;
      if (titleJa) item.titleJa = titleJa;
      if (digitalOnly) item.digitalOnly = true;
      if (codeInfo.regCatNo) item.regCatNo = codeInfo.regCatNo;
      if (codeInfo.mbEditions.length > 0) item.mbEditions = codeInfo.mbEditions;
      if (rawPriority) item.priority = rawPriority;
      if (rawRecommendedShops) item.recommendedShops = rawRecommendedShops;
      if (itunesQuery) {
        item.itunesQuery = itunesQuery;
        item.requiredGroups = buildRequiredGroups(artist, artistJa, title, titleJa);
      }

      const acquired = isCheckedValue(rawGotIt);
      const dupHit = findMatchingItem(item, null, seenByCode, seenByArtistTitle);
      if (dupHit) {
        const existing = dupHit.existing;
        mergeItemMetadata(existing, item);
        if (acquired) {
          sheetChecklist[existing.id] = true;
        }
        codeInfo.allCodes.forEach(function (code) {
          rowChecklistByCatNo[code] = Boolean(rowChecklistByCatNo[code] || acquired);
        });
        duplicates.push({
          rowNumber: r + 1,
          matchedId: existing.id,
          reason: dupHit.reason,
          key: dupHit.key,
          artist: item.artist,
          title: item.title
        });
        continue;
      }

      if (acquired) {
        sheetChecklist[finalId] = true;
      }
      codeInfo.allCodes.forEach(function (code) {
        rowChecklistByCatNo[code] = Boolean(rowChecklistByCatNo[code] || acquired);
      });

      items.push(item);
      indexItemIntoLookup(item, null, seenByCode, seenByArtistTitle);
    }

    if (items.length === 0) {
      throw new Error('Google Sheet CSV contained no release rows below the header');
    }

    return {
      catalog: {
        schemaVersion: 1,
        meta: meta,
        categories: deriveCategoriesFromItems(items),
        items: items
      },
      sheetChecklist: sheetChecklist,
      rowChecklistByCatNo: rowChecklistByCatNo,
      duplicates: duplicates
    };
  }

  function extractItemCodes(item) {
    if (!item || typeof item !== 'object' || item.digitalOnly) return [];
    const codes = new Set();
    if (item.regCatNo) {
      String(item.regCatNo).split(/[,/\s]+/).forEach(function (c) {
        const norm = c.trim().toUpperCase();
        if (SINGLE_CAT_CODE_REGEX.test(norm)) codes.add(norm);
      });
    }
    if (Array.isArray(item.mbEditions)) {
      item.mbEditions.forEach(function (ed) {
        const rawCode = ed && (ed.catno || ed.catNo);
        if (!rawCode) return;
        const norm = String(rawCode).trim().toUpperCase();
        if (SINGLE_CAT_CODE_REGEX.test(norm)) codes.add(norm);
      });
    }
    if (item.catalog) {
      let m;
      CAT_CODE_REGEX.lastIndex = 0;
      const str = String(item.catalog);
      while ((m = CAT_CODE_REGEX.exec(str)) !== null) {
        codes.add(m[1].toUpperCase());
      }
    }
    return Array.from(codes);
  }

  function buildNormalizedArtistTitleKey(item) {
    if (!item) return '';
    const artist = String(item.artist || '').toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '');
    const title = cleanDisplayTitleForQuery(item.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, '');
    if (!artist || !title) return '';
    return artist + '|' + title;
  }

  function indexItemIntoLookup(item, byId, byCode, byArtistTitle) {
    if (!item || typeof item !== 'object') return;
    if (byId && item.id && !byId.has(item.id)) {
      byId.set(item.id, item);
    }
    if (byCode) {
      extractItemCodes(item).forEach(function (code) {
        if (!byCode.has(code)) byCode.set(code, item);
      });
    }
    if (byArtistTitle) {
      const atKey = buildNormalizedArtistTitleKey(item);
      if (atKey && !byArtistTitle.has(atKey)) {
        byArtistTitle.set(atKey, item);
      }
    }
  }

  function findMatchingItem(item, byId, byCode, byArtistTitle) {
    if (!item || typeof item !== 'object') return null;
    if (byId && item.id && byId.has(item.id)) {
      return { existing: byId.get(item.id), reason: 'id', key: item.id };
    }
    const itemCodes = extractItemCodes(item);
    if (byCode) {
      for (let i = 0; i < itemCodes.length; i++) {
        if (byCode.has(itemCodes[i])) {
          return { existing: byCode.get(itemCodes[i]), reason: 'catalogNumber', key: itemCodes[i] };
        }
      }
    }
    if (byArtistTitle) {
      const atKey = buildNormalizedArtistTitleKey(item);
      if (atKey && byArtistTitle.has(atKey)) {
        const existing = byArtistTitle.get(atKey);
        if (Boolean(item.digitalOnly) === Boolean(existing.digitalOnly)) {
          const existingCodes = extractItemCodes(existing);
          const existingSet = new Set(existingCodes);
          const nonConflictingCodes =
            itemCodes.length === 0 ||
            existingCodes.length === 0 ||
            itemCodes.some(function (c) { return existingSet.has(c); });
          if (nonConflictingCodes) {
            return { existing: existing, reason: 'artistTitle', key: atKey };
          }
        }
      }
    }
    return null;
  }

  function mergeItemMetadata(target, source) {
    if (!target || !source) return;
    if (source.priority && !target.priority) target.priority = source.priority;
    if (source.recommendedShops && !target.recommendedShops) target.recommendedShops = source.recommendedShops;
    if (source.artistJa && !target.artistJa) target.artistJa = source.artistJa;
    if (source.titleJa && !target.titleJa) target.titleJa = source.titleJa;
    if (Array.isArray(source.mbEditions) && source.mbEditions.length > 0) {
      const existingEditions = Array.isArray(target.mbEditions) ? target.mbEditions : [];
      const seenEd = new Set(
        existingEditions.map(function (ed) { return String((ed && (ed.catno || ed.catNo)) || '').toUpperCase(); })
      );
      source.mbEditions.forEach(function (ed) {
        const norm = String((ed && (ed.catno || ed.catNo)) || '').toUpperCase();
        if (norm && !seenEd.has(norm)) {
          seenEd.add(norm);
          existingEditions.push({ catno: ed.catno || ed.catNo, label: ed.label || '通常盤 Regular' });
        }
      });
      if (existingEditions.length > 0) target.mbEditions = existingEditions;
    }
  }

  /**
   * Detect duplicate items within a catalog array by catalog number or normalized artist|title.
   * @param {Array<object>} items
   * @returns {Array<{ itemId: string, duplicateOfId: string, reason: 'catalogNumber' | 'artistTitle', key: string, artist: string, title: string }>}
   */
  function detectCatalogDuplicates(items) {
    const list = Array.isArray(items) ? items : [];
    const byCode = new Map();
    const byArtistTitle = new Map();
    const out = [];

    list.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const hit = findMatchingItem(item, null, byCode, byArtistTitle);
      if (hit) {
        out.push({
          itemId: String(item.id || ''),
          duplicateOfId: String(hit.existing.id || ''),
          reason: hit.reason,
          key: hit.key,
          artist: String(item.artist || ''),
          title: String(item.title || '')
        });
        return;
      }
      indexItemIntoLookup(item, null, byCode, byArtistTitle);
    });

    return out;
  }

  function cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Merge parsed Google Sheet releases onto a curated JSON base catalog:
   * - Backfills priority & recommendedShops onto matching curated items.
   * - Maps checked Sheet rows (`Got it? = TRUE`) onto matching base item IDs.
   * - Appends brand-new Sheet rows not yet present in the JSON catalog (deduplicating new rows too).
   *
   * @param {object} baseCatalog
   * @param {object} sheetParsed Output from parseGoogleSheetCsv (or a catalog object)
   * @returns {{ catalog: object, sheetChecklist: Record<string, boolean>, addedCount: number, matchedCount: number, duplicates: Array<object> }}
   */
  function mergeCatalogWithSheet(baseCatalog, sheetParsed) {
    const mergedCatalog = cloneJson(baseCatalog);
    const sheetObj =
      sheetParsed && sheetParsed.catalog
        ? sheetParsed
        : { catalog: sheetParsed, sheetChecklist: {}, duplicates: [] };
    const sheetItems = (sheetObj.catalog && Array.isArray(sheetObj.catalog.items)) ? sheetObj.catalog.items : [];
    const rawSheetChecklist = sheetObj.sheetChecklist || {};
    const mergedSheetChecklist = {};
    const duplicates = Array.isArray(sheetObj.duplicates) ? sheetObj.duplicates.slice() : [];

    const byId = new Map();
    const byCode = new Map();
    const byArtistTitle = new Map();
    const baseItemIds = new Set();
    const usedIds = new Set();

    mergedCatalog.items.forEach(function (item) {
      usedIds.add(item.id);
      baseItemIds.add(item.id);
      indexItemIntoLookup(item, byId, byCode, byArtistTitle);
    });

    const categorySet = new Set(
      Array.isArray(mergedCatalog.categories)
        ? mergedCatalog.categories.map(function (c) { return c.key; })
        : []
    );

    let matchedCount = 0;
    let addedCount = 0;

    sheetItems.forEach(function (sItem) {
      const hit = findMatchingItem(sItem, byId, byCode, byArtistTitle);
      const isCheckedInSheet = Boolean(rawSheetChecklist[sItem.id]);

      if (hit) {
        const matched = hit.existing;
        if (baseItemIds.has(matched.id)) {
          matchedCount++;
        } else {
          duplicates.push({
            matchedId: matched.id,
            reason: hit.reason,
            key: hit.key,
            artist: sItem.artist,
            title: sItem.title
          });
        }
        mergeItemMetadata(matched, sItem);
        if (isCheckedInSheet) {
          mergedSheetChecklist[matched.id] = true;
        }
        return;
      }

      const newItem = cloneJson(sItem);
      let candidateId = newItem.id;
      let suffix = 2;
      while (usedIds.has(candidateId)) {
        candidateId = newItem.id + '-' + suffix;
        suffix++;
      }
      newItem.id = candidateId;
      usedIds.add(candidateId);

      mergedCatalog.items.push(newItem);
      indexItemIntoLookup(newItem, byId, byCode, byArtistTitle);
      addedCount++;

      if (Array.isArray(mergedCatalog.categories) && newItem.category && !categorySet.has(newItem.category)) {
        categorySet.add(newItem.category);
        mergedCatalog.categories.push({
          key: newItem.category,
          label: newItem.category,
          dot: CATEGORY_PALETTE[mergedCatalog.categories.length % CATEGORY_PALETTE.length]
        });
      }

      if (isCheckedInSheet) {
        mergedSheetChecklist[newItem.id] = true;
      }
    });

    return {
      catalog: mergedCatalog,
      sheetChecklist: mergedSheetChecklist,
      addedCount: addedCount,
      matchedCount: matchedCount,
      duplicates: duplicates
    };
  }

  /**
   * Build a catalog-number -> boolean checklist map for Google Sheet Column A sync.
   * @param {Array<object>} items
   * @param {Record<string, boolean>} acquiredMap
   * @returns {Record<string, boolean>}
   */
  function buildChecklistByCatNo(items, acquiredMap) {
    const out = {};
    const list = Array.isArray(items) ? items : [];
    const acquired = acquiredMap && typeof acquiredMap === 'object' ? acquiredMap : {};

    list.forEach(function (item) {
      if (!item || item.digitalOnly) return;
      const isGot = Boolean(acquired[item.id]);
      const codes = extractItemCodes(item);
      codes.forEach(function (code) {
        out[code] = isGot;
      });
    });

    return out;
  }

  const sheetAdapterApi = {
    parseCsv: parseCsv,
    isGoogleSheetCsvUrl: isGoogleSheetCsvUrl,
    parseGoogleSheetCsv: parseGoogleSheetCsv,
    detectCatalogDuplicates: detectCatalogDuplicates,
    mergeCatalogWithSheet: mergeCatalogWithSheet,
    buildChecklistByCatNo: buildChecklistByCatNo
  };

  if (root) {
    root.CDHunt = root.CDHunt || {};
    root.CDHunt.sheetAdapter = sheetAdapterApi;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = sheetAdapterApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
