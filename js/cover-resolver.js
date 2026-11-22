/**
 * @fileoverview Offline SVG jewel-case + obi generator and two-stage cover art resolver
 * (MusicBrainz/Cover Art Archive followed by Apple iTunes Search API; attaches to window.CDHunt.coverResolver).
 */
(function (root) {
  'use strict';

  function escapeHTML(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Generate an offline data-URI SVG jewel case + Japanese obi strip cover art.
   * @param {object} item
   * @returns {string}
   */
  function buildJewelCaseDataURI(item) {
    const accent = item.accent || '#e11d48';
    const catShort = (item.regCatNo || item.catalog || 'N/A').split(/[(/,]/)[0].trim();
    const artistLine = (item.artistJa || item.artist || '').slice(0, 22);
    const titleLine = (item.titleJa || item.title || '').slice(0, 24);
    const kanaLabel = (item.kana || '').split('/')[0].trim();
    const obiFooter = item.digitalOnly ? '配信限定' : '通常盤';

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#18181b"/>' +
      '<stop offset="65%" stop-color="#09090b"/>' +
      '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0.5"/>' +
      '</linearGradient></defs>' +
      '<rect width="240" height="240" fill="url(#g)"/>' +
      '<circle cx="145" cy="116" r="70" fill="#27272a" stroke="' + accent + '" stroke-width="2" stroke-opacity="0.65"/>' +
      '<circle cx="145" cy="116" r="22" fill="#09090b" stroke="#52525b" stroke-width="2"/>' +
      '<circle cx="145" cy="116" r="8" fill="#e4e4e7"/>' +
      '<polygon points="34,0 135,0 65,240 34,240" fill="#ffffff" opacity="0.04"/>' +
      '<rect x="0" y="0" width="34" height="240" fill="' + accent + '"/>' +
      '<text x="17" y="22" fill="#ffffff" font-family="monospace" font-size="8" font-weight="bold" text-anchor="middle">' + escapeHTML(kanaLabel) + '</text>' +
      '<text x="17" y="130" fill="#ffffff" font-family="monospace" font-size="9" font-weight="bold" text-anchor="middle" transform="rotate(-90 17 130)">' + escapeHTML(catShort) + '</text>' +
      '<text x="17" y="224" fill="#ffffff" font-family="sans-serif" font-size="7.5" font-weight="bold" text-anchor="middle">' + obiFooter + '</text>' +
      '<rect x="46" y="14" width="180" height="22" rx="6" fill="#000000" fill-opacity="0.62"/>' +
      '<text x="54" y="28" fill="#f4f4f5" font-family="monospace" font-size="10" font-weight="bold">' + escapeHTML(catShort) + '</text>' +
      '<text x="48" y="172" fill="#ffffff" font-family="sans-serif" font-size="11.5" font-weight="800">' + escapeHTML(artistLine) + '</text>' +
      '<text x="48" y="192" fill="#d4d4d8" font-family="sans-serif" font-size="10" font-weight="600">' + escapeHTML(titleLine) + '</text>' +
      '<text x="48" y="216" fill="#a1a1aa" font-family="monospace" font-size="9">' + escapeHTML(item.price || '') + '</text>' +
      '</svg>';

    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function verifyImageLoad(url) {
    return new Promise(function (resolve) {
      const ImageCtor = (root && root.Image) || (typeof Image !== 'undefined' ? Image : null);
      if (!ImageCtor) {
        resolve(false);
        return;
      }
      const img = new ImageCtor();
      const timer = setTimeout(function () {
        img.onload = null;
        img.onerror = null;
        resolve(false);
      }, 7000);
      img.onload = function () {
        clearTimeout(timer);
        resolve(img.naturalWidth > 40 && img.naturalHeight > 40);
      };
      img.onerror = function () {
        clearTimeout(timer);
        resolve(false);
      };
      img.src = url;
    });
  }

  /**
   * Stage 1 cover lookup: MusicBrainz Cover Art Archive ordered by Regular Edition first.
   * @param {object} item
   * @returns {Promise<Array<object>>}
   */
  async function tryMusicBrainzCovers(item) {
    const fetchFn = (root && root.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return [];

    const variants = [];
    const seen = new Set();
    const editions = Array.isArray(item.mbEditions) ? item.mbEditions : [];

    for (let i = 0; i < editions.length; i++) {
      const ed = editions[i];
      if (!ed || !ed.catno) continue;
      const cleanCat = String(ed.catno).trim().replace(/[～〜]/g, '~');
      const catCandidates = [cleanCat];
      if (cleanCat.indexOf('~') !== -1) {
        const baseCat = cleanCat.split('~')[0].trim();
        if (baseCat && catCandidates.indexOf(baseCat) === -1) {
          catCandidates.push(baseCat);
        }
      }

      let foundForEdition = false;
      for (let c = 0; c < catCandidates.length && !foundForEdition; c++) {
        try {
          const mbUrl = 'https://musicbrainz.org/ws/2/release/?query=catno:' + encodeURIComponent(catCandidates[c]) + '&fmt=json&limit=4';
          const res = await fetchFn(mbUrl, { headers: { Accept: 'application/json' } });
          if (!res.ok) continue;
          const data = await res.json();
          const releases = Array.isArray(data.releases) ? data.releases : [];
          for (let r = 0; r < releases.length; r++) {
            const rel = releases[r];
            if (!rel || !rel.id) continue;
            const caaUrl = 'https://coverartarchive.org/release/' + rel.id + '/front-500';
            if (seen.has(caaUrl)) continue;
            const ok = await verifyImageLoad(caaUrl);
            if (ok) {
              seen.add(caaUrl);
              variants.push({
                url: caaUrl,
                label: ed.label || '通常盤 Regular',
                catNo: cleanCat,
                source: 'musicbrainz',
                isRegular: (ed.label || '').indexOf('通常') !== -1 || cleanCat === item.regCatNo
              });
              foundForEdition = true;
              break;
            }
          }
        } catch (e) {
          // Continue silently
        }
      }
    }
    return variants;
  }

  const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff]/;

  function stripNestedParens(str) {
    let cur = String(str || '');
    let prev;
    do {
      prev = cur;
      cur = cur.replace(/\s*(?:\([^()（）]*\)|（[^()（）]*）)(?![A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff])\s*/g, ' ');
    } while (cur !== prev);
    return cur.replace(/\s+/g, ' ').trim();
  }

  function normalizeForMatch(str) {
    return String(str || '')
      .normalize('NFKC')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[〜～~'"“”‘’「」『』・･:：!！?？/／&＆\-–—_.,()（）\[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchesRequiredGroups(rawHay, groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) return true;
    const normHay = normalizeForMatch(rawHay);
    const compactHay = normHay.replace(/\s+/g, '');

    return list.every(function (grp) {
      if (!Array.isArray(grp) || grp.length === 0) return true;
      return grp.some(function (kw) {
        const normKw = normalizeForMatch(kw);
        if (!normKw) return false;
        if (normHay.indexOf(normKw) !== -1) return true;
        if (CJK_CHAR_REGEX.test(normKw) && compactHay.indexOf(normKw.replace(/\s+/g, '')) !== -1) {
          return true;
        }
        return false;
      });
    });
  }

  /**
   * Build a concise Google Image Search query string for a catalog item's jacket.
   * @param {object} item
   * @returns {string}
   */
  function buildJacketSearchQuery(item) {
    const entry = item && typeof item === 'object' ? item : {};
    const cleanArtist = stripNestedParens(entry.artist || '')
      .replace(/\s+(?:feat\.?|ft\.?|featuring|with|w\/)\s+.*$/i, '')
      .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
      .replace(/["“”]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const rawTitle = entry.titleJa || entry.title || '';
    const cleanTitle = stripNestedParens(rawTitle)
      .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
      .replace(/["“”]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (entry.digitalOnly) {
      return [cleanArtist, cleanTitle, 'ジャケット'].filter(Boolean).join(' ').trim();
    }

    const rawCat = String(entry.regCatNo || '').trim().replace(/[～〜]/g, '~');
    const regCat = rawCat && !/^(?:n\/a|digital(?:-only)?|—|-)$/i.test(rawCat) ? rawCat : '';
    return [regCat, cleanArtist, cleanTitle, '通常盤', 'CD'].filter(Boolean).join(' ').trim();
  }

  function classifyItunesEdition(collectionName, isDigital) {
    if (isDigital) {
      return { label: '配信 Digital', isRegular: true, score: 100 };
    }
    const name = String(collectionName || '');
    const lower = name.toLowerCase();
    const isAnime = name.indexOf('期間生産') !== -1 || name.indexOf('アニメ盤') !== -1 || lower.indexOf('anime') !== -1;
    const isLimited = name.indexOf('初回') !== -1 || lower.indexOf('limited') !== -1 || lower.indexOf('deluxe') !== -1 || lower.indexOf('dvd') !== -1;
    const isRegularTag = name.indexOf('通常盤') !== -1 || lower.indexOf('regular') !== -1 || lower.indexOf('standard') !== -1;

    if (isRegularTag) return { label: '通常盤 Regular', isRegular: true, score: 120 };
    if (!isAnime && !isLimited && lower.indexOf('edition') === -1) return { label: '通常盤 Regular', isRegular: true, score: 100 };
    if (isAnime) return { label: 'アニメ盤 Anime', isRegular: false, score: 50 };
    if (isLimited) return { label: '初回盤 Limited', isRegular: false, score: 40 };
    return { label: '通常盤 Regular', isRegular: true, score: 80 };
  }

  /**
   * Stage 2 cover lookup: Apple iTunes Search API (JP primary, US fallback).
   * @param {object} item
   * @returns {Promise<Array<object>>}
   */
  async function tryItunesCovers(item) {
    const fetchFn = (root && root.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn || !item.itunesQuery) return [];

    const candidates = [];
    const countries = ['jp', 'us'];
    const groups = Array.isArray(item.requiredGroups) ? item.requiredGroups : [];
    const entities = item.digitalOnly ? ['song', 'album'] : ['album'];
    const seen = new Set();

    async function queryItunesPass(term, passCountries, passEntities) {
      const cleanTerm = String(term || '').trim();
      if (!cleanTerm) return;

      for (let c = 0; c < passCountries.length; c++) {
        const country = passCountries[c];
        for (let e = 0; e < passEntities.length; e++) {
          const entity = passEntities[e];
          try {
            const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(cleanTerm) + '&country=' + country + '&entity=' + entity + '&limit=8';
            const res = await fetchFn(url);
            if (!res.ok) continue;
            const data = await res.json();
            const results = Array.isArray(data.results) ? data.results : [];

            for (let i = 0; i < results.length; i++) {
              if (candidates.length >= 6) break;
              const r = results[i];
              const hay = (r.trackName || '') + ' ' + (r.collectionName || '') + ' ' + (r.artistName || '');
              if (matchesRequiredGroups(hay, groups) && r.artworkUrl100) {
                const hiRes = r.artworkUrl100.replace('100x100bb', '600x600bb');
                if (seen.has(hiRes)) continue;
                const ok = await verifyImageLoad(hiRes);
                if (ok) {
                  seen.add(hiRes);
                  const edInfo = classifyItunesEdition(r.collectionName, !!item.digitalOnly);
                  candidates.push({
                    url: hiRes,
                    label: edInfo.label,
                    catNo: edInfo.isRegular ? (item.regCatNo || '') : '',
                    source: 'itunes-' + country,
                    isRegular: edInfo.isRegular,
                    score: edInfo.score + (country === 'jp' ? 10 : 0)
                  });
                }
              }
            }
          } catch (err) {
            // Continue
          }
        }
      }
    }

    await queryItunesPass(item.itunesQuery, countries, entities);

    if (candidates.length === 0) {
      const primaryQuery = String(item.itunesQuery || '').trim();
      const fallbackTerms = [];
      const seenTerms = new Set([primaryQuery.toLowerCase()]);

      function addFallbackTerm(t) {
        const clean = String(t || '').trim();
        if (!clean || fallbackTerms.length >= 2) return;
        const lower = clean.toLowerCase();
        if (seenTerms.has(lower)) return;
        seenTerms.add(lower);
        fallbackTerms.push(clean);
      }

      if (item.artistJa && primaryQuery.indexOf(item.artistJa) === -1) {
        const cleanArtist = stripNestedParens(item.artist || '')
          .replace(/\s+(?:feat\.?|ft\.?|featuring|with|w\/)\s+.*$/i, '')
          .trim();
        const baseTitle = stripNestedParens(item.title || '')
          .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
          .replace(/["“”]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (item.artist && primaryQuery.indexOf(item.artist) !== -1) {
          addFallbackTerm(primaryQuery.replace(item.artist, item.artistJa));
        } else if (cleanArtist && primaryQuery.indexOf(cleanArtist) !== -1) {
          addFallbackTerm(primaryQuery.replace(cleanArtist, item.artistJa));
        } else if (baseTitle) {
          addFallbackTerm(item.artistJa + ' ' + baseTitle);
        }
      }

      if (item.titleJa && String(item.titleJa).trim()) {
        addFallbackTerm(item.titleJa);
      }

      for (let f = 0; f < fallbackTerms.length && candidates.length === 0; f++) {
        await queryItunesPass(fallbackTerms[f], ['jp'], ['album', 'song']);
      }

      if (candidates.length === 0 && !item.digitalOnly) {
        await queryItunesPass(primaryQuery, ['jp'], ['song']);
      }
    }

    candidates.sort(function (a, b) {
      return b.score - a.score;
    });
    return candidates.map(function (c) {
      return {
        url: c.url,
        label: c.label,
        catNo: c.catNo,
        source: c.source,
        isRegular: c.isRegular
      };
    });
  }

  const coverResolverApi = {
    escapeHTML: escapeHTML,
    escapeAttr: escapeAttr,
    buildJewelCaseDataURI: buildJewelCaseDataURI,
    verifyImageLoad: verifyImageLoad,
    normalizeForMatch: normalizeForMatch,
    buildJacketSearchQuery: buildJacketSearchQuery,
    tryMusicBrainzCovers: tryMusicBrainzCovers,
    classifyItunesEdition: classifyItunesEdition,
    tryItunesCovers: tryItunesCovers
  };

  if (root) {
    root.CDHunt = root.CDHunt || {};
    root.CDHunt.coverResolver = coverResolverApi;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = coverResolverApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
