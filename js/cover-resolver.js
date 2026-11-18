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
      try {
        const mbUrl = 'https://musicbrainz.org/ws/2/release/?query=catno:' + encodeURIComponent(ed.catno) + '&fmt=json&limit=4';
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
              catNo: ed.catno,
              source: 'musicbrainz',
              isRegular: (ed.label || '').indexOf('通常') !== -1 || ed.catno === item.regCatNo
            });
            break;
          }
        }
      } catch (e) {
        // Continue silently
      }
    }
    return variants;
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

    for (let c = 0; c < countries.length; c++) {
      const country = countries[c];
      for (let e = 0; e < entities.length; e++) {
        const entity = entities[e];
        try {
          const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(item.itunesQuery) + '&country=' + country + '&entity=' + entity + '&limit=8';
          const res = await fetchFn(url);
          if (!res.ok) continue;
          const data = await res.json();
          const results = Array.isArray(data.results) ? data.results : [];

          for (let i = 0; i < results.length; i++) {
            if (candidates.length >= 6) break;
            const r = results[i];
            const hay = ((r.trackName || '') + ' ' + (r.collectionName || '') + ' ' + (r.artistName || '')).toLowerCase();
            const isValid = groups.every(function (grp) {
              return grp.some(function (kw) {
                return hay.indexOf(kw.toLowerCase()) !== -1;
              });
            });
            if (isValid && r.artworkUrl100) {
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
