/**
 * @fileoverview Multi-disc tracklist resolver (Catalog/Manual overrides > MusicBrainz WS/2 > Apple iTunes),
 * polite 1 req/s MusicBrainz throttler, smart text paste parser, and variant-aware track matcher
 * (attaches to window.DiskCrate.trackResolver / legacy alias window.CDHunt.trackResolver / CommonJS).
 */
(function (root) {
  'use strict';

  const coverMod =
    typeof module !== 'undefined' && typeof require === 'function'
      ? require('./cover-resolver.js')
      : (root && (root.DiskCrate || root.CDHunt) && (root.DiskCrate || root.CDHunt).coverResolver) || {};

  const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u9fff]/;
  const VALID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const VALID_BARCODE_REGEX = /^\d{8,14}$/;
  const PLACEHOLDER_CAT_REGEX = /^(?:n\/a|digital(?:\s*-?\s*only)?|—|-|none)$/i;
  const VALID_MEDIA_TYPES = new Set(['CD', 'BD', 'DVD', 'Digital']);
  const DEFAULT_MB_MIN_INTERVAL_MS = 1100;

  const normalizeForMatch =
    coverMod.normalizeForMatch ||
    function (str) {
      return String(str || '')
        .normalize('NFKC')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[〜～~'"“”‘’「」『』・･:：!！?？/／&＆\-–—_.,()（）\[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

  const classifyItunesEdition =
    coverMod.classifyItunesEdition ||
    function (collectionName, isDigital) {
      if (isDigital) return { label: '配信 Digital', isRegular: true, score: 100 };
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
    };

  function getConfiguredMbMinIntervalMs() {
    const ns = root && (root.DiskCrate || root.CDHunt);
    const cfg = ns && ns.config;
    if (cfg && typeof cfg.mbTrackMinIntervalMs === 'number' && cfg.mbTrackMinIntervalMs >= 0) {
      return cfg.mbTrackMinIntervalMs;
    }
    return DEFAULT_MB_MIN_INTERVAL_MS;
  }

  function cleanCatalogCode(raw) {
    const cleaned = String(raw || '')
      .trim()
      .replace(/[～〜]/g, '~')
      .split(/[(/,]/)[0]
      .trim()
      .toUpperCase();
    if (!cleaned || PLACEHOLDER_CAT_REGEX.test(cleaned) || /^DIGITAL/i.test(cleaned)) {
      return '';
    }
    return cleaned;
  }

  function cleanBarcodeDigits(raw) {
    const digits = String(raw || '').replace(/[\s-]+/g, '').trim();
    return VALID_BARCODE_REGEX.test(digits) ? digits : '';
  }

  /**
   * Deterministically derive a release key shared across catalogs & IndexedDB caches.
   * @param {object} item
   * @returns {string}
   */
  function deriveTrackReleaseKey(item) {
    const entry = item && typeof item === 'object' ? item : null;
    if (!entry) return '';

    const mbid = String(entry.mbid || '').trim();
    if (mbid && VALID_UUID_REGEX.test(mbid)) {
      return 'mbid:' + mbid.toLowerCase();
    }

    const editions = Array.isArray(entry.mbEditions) ? entry.mbEditions : [];
    const firstEdCat = editions[0] && editions[0].catno ? editions[0].catno : '';
    const regCat = !entry.digitalOnly ? (cleanCatalogCode(entry.regCatNo) || cleanCatalogCode(firstEdCat)) : '';
    if (regCat) {
      return 'catno:' + regCat;
    }

    const barcode = !entry.digitalOnly ? cleanBarcodeDigits(entry.barcode) : '';
    if (barcode) {
      return 'barcode:' + barcode;
    }

    const artistPart = normalizeForMatch(entry.artist || entry.artistJa || '');
    const titlePart = normalizeForMatch(entry.titleJa || entry.title || entry.id || '');
    if (!artistPart && !titlePart) return '';
    return 'item:' + artistPart + '|' + titlePart;
  }

  /**
   * Format track duration milliseconds into `m:ss` or `h:mm:ss`.
   * @param {number | undefined | null} durationMs
   * @returns {string}
   */
  function formatDurationMs(durationMs) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
      return '';
    }
    const totalSec = Math.round(durationMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) {
      return hours + ':' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    }
    return mins + ':' + String(secs).padStart(2, '0');
  }

  function normalizeMediaType(raw) {
    const val = String(raw || '').trim();
    if (VALID_MEDIA_TYPES.has(val)) return val;
    if (/blu-?ray|\bbd\b/i.test(val)) return 'BD';
    if (/dvd/i.test(val)) return 'DVD';
    if (/digital|web|stream/i.test(val)) return 'Digital';
    return 'CD';
  }

  /**
   * Sanitize and sort an array of track objects.
   * @param {unknown} rawTracks
   * @returns {Array<object>}
   */
  function normalizeTracksList(rawTracks) {
    if (!Array.isArray(rawTracks) || rawTracks.length === 0) return [];
    const out = [];
    for (let i = 0; i < rawTracks.length; i++) {
      const t = rawTracks[i];
      if (!t || typeof t !== 'object') continue;
      const title = String(t.title || '').trim();
      if (!title) continue;
      const discNum = Number(t.disc);
      const disc = Number.isInteger(discNum) && discNum >= 1 ? discNum : 1;
      const numVal = Number(t.number);
      const number = Number.isInteger(numVal) && numVal >= 1 ? numVal : (out.length + 1);
      const entry = {
        disc: disc,
        mediaType: normalizeMediaType(t.mediaType || 'CD'),
        number: number,
        title: title
      };
      if (t.titleJa && String(t.titleJa).trim()) {
        entry.titleJa = String(t.titleJa).trim();
      }
      if (t.artist && String(t.artist).trim()) {
        entry.artist = String(t.artist).trim();
      }
      if (typeof t.durationMs === 'number' && Number.isFinite(t.durationMs) && t.durationMs >= 0) {
        entry.durationMs = Math.round(t.durationMs);
      }
      if (t.notes && String(t.notes).trim()) {
        entry.notes = String(t.notes).trim();
      }
      out.push(entry);
    }
    out.sort(function (a, b) {
      return a.disc - b.disc || a.number - b.number;
    });
    return out;
  }

  /**
   * Resolve effective tracklist respecting strict 3-layer precedence:
   * 1. Manual override -> 2. Catalog embedded tracks -> 3. Auto-fetched cache.
   */
  function resolveEffectiveTracks(item, opts) {
    const options = opts || {};
    const catalogTracks = normalizeTracksList(item && item.tracks);
    const manualRecord = options.manualRecord || null;
    const cacheRecord = options.cacheRecord || null;
    const manualTracks = normalizeTracksList(manualRecord && manualRecord.tracks);
    const cachedTracks = normalizeTracksList(cacheRecord && cacheRecord.tracks);
    const itemMbid = item && item.mbid ? String(item.mbid).trim() : '';

    if (manualTracks.length > 0) {
      return {
        tracks: manualTracks,
        trackSource: 'manual',
        sourceDetail: (manualRecord && manualRecord.sourceDetail) || 'Custom',
        isOverride: true,
        hasCatalogTracks: catalogTracks.length > 0,
        mbid: (cacheRecord && cacheRecord.mbid) || itemMbid
      };
    }

    if (catalogTracks.length > 0) {
      return {
        tracks: catalogTracks,
        trackSource: (item && item.trackSource) || 'catalog',
        sourceDetail: cleanCatalogCode(item && item.regCatNo) || 'Catalog',
        isOverride: false,
        hasCatalogTracks: true,
        mbid: itemMbid
      };
    }

    if (cachedTracks.length > 0) {
      return {
        tracks: cachedTracks,
        trackSource: (cacheRecord && cacheRecord.trackSource) || 'musicbrainz',
        sourceDetail: (cacheRecord && cacheRecord.sourceDetail) || '',
        isOverride: false,
        hasCatalogTracks: false,
        mbid: (cacheRecord && cacheRecord.mbid) || itemMbid
      };
    }

    return {
      tracks: [],
      trackSource: null,
      sourceDetail: '',
      isOverride: false,
      hasCatalogTracks: false,
      mbid: itemMbid
    };
  }

  /**
   * Create a serialized rate-limited queue enforcing a minimum spacing between starts.
   * @param {{ minIntervalMs?: number | (() => number), nowFn?: () => number, sleepFn?: (ms: number) => Promise<void> }} [options]
   */
  function createRateLimitedQueue(options) {
    const opts = options || {};
    const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : function () { return Date.now(); };
    const sleepFn = typeof opts.sleepFn === 'function'
      ? opts.sleepFn
      : function (ms) {
          return new Promise(function (resolve) { setTimeout(resolve, ms); });
        };

    let tail = Promise.resolve();
    let nextAllowedAt = 0;

    function getInterval() {
      if (typeof opts.minIntervalMs === 'function') return Math.max(0, opts.minIntervalMs());
      if (typeof opts.minIntervalMs === 'number') return Math.max(0, opts.minIntervalMs);
      return getConfiguredMbMinIntervalMs();
    }

    return {
      schedule: function (fn) {
        const run = tail.then(async function () {
          const interval = getInterval();
          if (interval > 0) {
            const waitMs = nextAllowedAt - nowFn();
            if (waitMs > 0) {
              await sleepFn(waitMs);
            }
          }
          nextAllowedAt = nowFn() + interval;
          return fn();
        });
        tail = run.catch(function () {});
        return run;
      }
    };
  }

  const defaultMbQueue = createRateLimitedQueue();

  function formatArtistCredit(credits) {
    if (!Array.isArray(credits) || credits.length === 0) return '';
    let out = '';
    for (let i = 0; i < credits.length; i++) {
      const c = credits[i];
      if (!c) continue;
      const name = c.name || (c.artist && c.artist.name) || '';
      out += String(name) + String(c.joinphrase || '');
    }
    return out.trim();
  }

  function stripTrailingParens(str) {
    return String(str || '')
      .replace(/\s*(?:\([^()（）]*\)|（[^()（）]*）)(?![A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff])\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSameReleaseArtist(candidateArtist, item) {
    const normCand = normalizeForMatch(candidateArtist);
    if (!normCand) return true;
    const forms = [
      item && item.artist,
      item && item.artistJa,
      item && item.artist ? stripTrailingParens(item.artist) : '',
      item && item.artistJa ? stripTrailingParens(item.artistJa) : ''
    ];
    for (let i = 0; i < forms.length; i++) {
      const normForm = normalizeForMatch(forms[i]);
      if (normForm && (normForm === normCand || normForm.replace(/\s+/g, '') === normCand.replace(/\s+/g, ''))) {
        return true;
      }
    }
    return false;
  }

  function mapMbReleaseToTracks(rel, item) {
    const media = Array.isArray(rel && rel.media) ? rel.media : [];
    const tracks = [];
    for (let m = 0; m < media.length; m++) {
      const medium = media[m];
      if (!medium) continue;
      const disc = Number.isInteger(medium.position) && medium.position >= 1 ? medium.position : (m + 1);
      const mediaType = normalizeMediaType(medium.format || 'CD');
      const rawTracks = Array.isArray(medium.tracks) ? medium.tracks : [];
      for (let t = 0; t < rawTracks.length; t++) {
        const tr = rawTracks[t];
        if (!tr) continue;
        const rec = tr.recording || {};
        const title = String(tr.title || rec.title || '').trim();
        if (!title) continue;
        const pos = Number.isInteger(tr.position) && tr.position >= 1
          ? tr.position
          : (parseInt(String(tr.number || ''), 10) || (t + 1));
        const length = typeof tr.length === 'number' ? tr.length : rec.length;
        const creditStr = formatArtistCredit(tr['artist-credit'] || rec['artist-credit']);

        const mapped = {
          disc: disc,
          mediaType: mediaType,
          number: pos,
          title: title
        };
        if (creditStr && !isSameReleaseArtist(creditStr, item)) {
          mapped.artist = creditStr;
        }
        if (typeof length === 'number' && Number.isFinite(length) && length >= 0) {
          mapped.durationMs = Math.round(length);
        }
        tracks.push(mapped);
      }
    }
    return normalizeTracksList(tracks);
  }

  function extractMatchedMbCatNo(rel, targetCodes) {
    const labels = Array.isArray(rel && rel['label-info']) ? rel['label-info'] : [];
    for (let i = 0; i < labels.length; i++) {
      const cat = labels[i] && labels[i]['catalog-number'] ? cleanCatalogCode(labels[i]['catalog-number']) : '';
      if (cat && targetCodes.has(cat)) return cat;
    }
    for (let i = 0; i < labels.length; i++) {
      const cat = labels[i] && labels[i]['catalog-number'] ? String(labels[i]['catalog-number']).trim() : '';
      if (cat) return cat.replace(/[～〜]/g, '~');
    }
    return '';
  }

  function scoreMbCandidate(rel, targetCodes) {
    let score = 0;
    const labels = Array.isArray(rel && rel['label-info']) ? rel['label-info'] : [];
    for (let i = 0; i < labels.length; i++) {
      const cat = labels[i] && labels[i]['catalog-number'] ? cleanCatalogCode(labels[i]['catalog-number']) : '';
      if (cat && targetCodes.has(cat)) {
        score += 100;
        break;
      }
    }
    if (String(rel && rel.status || '').toLowerCase() === 'official') score += 10;
    if (rel && rel.country === 'JP') score += 5;
    if (Array.isArray(rel && rel.media) && rel.media.length > 0) score += 2;
    return score;
  }

  /**
   * Fetch multi-disc tracklist from MusicBrainz WS/2 by MBID, barcode, or catalog number.
   * @param {object} item
   * @param {{ fetchImpl?: typeof fetch, queue?: { schedule: Function } }} [opts]
   */
  async function tryMusicBrainzTracks(item, opts) {
    const options = opts || {};
    const fetchFn = options.fetchImpl || (root && root.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn || !item) {
      return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
    }
    const queue = options.queue || defaultMbQueue;

    async function fetchMbJson(url) {
      return queue.schedule(async function () {
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return res.json();
      });
    }

    const targetCodes = new Set();
    const rawCodes = [];
    if (item.regCatNo) rawCodes.push(item.regCatNo);
    const editions = Array.isArray(item.mbEditions) ? item.mbEditions : [];
    for (let i = 0; i < editions.length; i++) {
      if (editions[i] && editions[i].catno) rawCodes.push(editions[i].catno);
    }

    const queries = [];
    const seenQueries = new Set();
    function addQuery(q, hint) {
      if (!q || seenQueries.has(q)) return;
      seenQueries.add(q);
      queries.push({ query: q, hint: hint || '' });
    }

    const barcode = cleanBarcodeDigits(item.barcode);
    if (barcode) {
      addQuery('barcode:' + barcode, '');
    }

    for (let i = 0; i < rawCodes.length; i++) {
      const code = cleanCatalogCode(rawCodes[i]);
      if (!code) continue;
      targetCodes.add(code);
      addQuery('catno:' + code, code);
      if (code.indexOf('~') !== -1) {
        const base = code.split('~')[0].trim();
        if (base) {
          targetCodes.add(base);
          addQuery('catno:' + base, base);
        }
      }
    }

    const directMbid = String(item.mbid || '').trim();
    if (directMbid && VALID_UUID_REGEX.test(directMbid)) {
      try {
        const rel = await fetchMbJson(
          'https://musicbrainz.org/ws/2/release/' + encodeURIComponent(directMbid) + '?inc=recordings+artist-credits+media&fmt=json'
        );
        if (rel) {
          const tracks = mapMbReleaseToTracks(rel, item);
          if (tracks.length > 0) {
            return {
              tracks: tracks,
              trackSource: 'musicbrainz',
              sourceDetail: extractMatchedMbCatNo(rel, targetCodes) || rel.title || 'MusicBrainz',
              mbid: rel.id || directMbid
            };
          }
        }
      } catch (e) {}
    }

    for (let q = 0; q < queries.length; q++) {
      try {
        const data = await fetchMbJson(
          'https://musicbrainz.org/ws/2/release/?query=' + encodeURIComponent(queries[q].query) + '&fmt=json&limit=4'
        );
        const releases = Array.isArray(data && data.releases) ? data.releases.slice() : [];
        if (releases.length === 0) continue;

        releases.sort(function (a, b) {
          return scoreMbCandidate(b, targetCodes) - scoreMbCandidate(a, targetCodes);
        });

        const limit = Math.min(releases.length, 2);
        for (let r = 0; r < limit; r++) {
          const relSummary = releases[r];
          if (!relSummary || !relSummary.id) continue;
          const fullRel = await fetchMbJson(
            'https://musicbrainz.org/ws/2/release/' + encodeURIComponent(relSummary.id) + '?inc=recordings+artist-credits+media&fmt=json'
          );
          if (!fullRel) continue;
          const tracks = mapMbReleaseToTracks(fullRel, item);
          if (tracks.length > 0) {
            const detail = extractMatchedMbCatNo(fullRel, targetCodes) || queries[q].hint || fullRel.title || 'MusicBrainz';
            return {
              tracks: tracks,
              trackSource: 'musicbrainz',
              sourceDetail: detail,
              mbid: fullRel.id || relSummary.id
            };
          }
        }
      } catch (e) {
        // Continue trying remaining queries
      }
    }

    return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
  }

  function matchesGroupsOrFallback(hay, item) {
    const groups = Array.isArray(item && item.requiredGroups) ? item.requiredGroups : [];
    const normHay = normalizeForMatch(hay);
    const compactHay = normHay.replace(/\s+/g, '');

    if (groups.length > 0) {
      return groups.every(function (grp) {
        if (!Array.isArray(grp) || grp.length === 0) return true;
        return grp.some(function (kw) {
          const normKw = normalizeForMatch(kw);
          if (!normKw) return false;
          if (normHay.indexOf(normKw) !== -1) return true;
          if (CJK_CHAR_REGEX.test(normKw) && compactHay.indexOf(normKw.replace(/\s+/g, '')) !== -1) return true;
          return false;
        });
      });
    }

    const titleTok = normalizeForMatch((item && (item.titleJa || item.title)) || '');
    const artistTok = normalizeForMatch((item && (item.artistJa || item.artist)) || '');
    const titleOk = !titleTok || normHay.indexOf(titleTok) !== -1 || (CJK_CHAR_REGEX.test(titleTok) && compactHay.indexOf(titleTok.replace(/\s+/g, '')) !== -1);
    const artistOk = !artistTok || normHay.indexOf(artistTok) !== -1 || (CJK_CHAR_REGEX.test(artistTok) && compactHay.indexOf(artistTok.replace(/\s+/g, '')) !== -1);
    return titleOk && artistOk;
  }

  /**
   * Fallback tracklist lookup via Apple iTunes Search & Lookup API (country=jp primary).
   * @param {object} item
   * @param {{ fetchImpl?: typeof fetch }} [opts]
   */
  async function tryItunesTracks(item, opts) {
    const options = opts || {};
    const fetchFn = options.fetchImpl || (root && root.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn || !item) {
      return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
    }

    const baseTerm = String(item.itunesQuery || '').trim() ||
      [String(item.artistJa || item.artist || '').replace(/\([^)]*\)/g, '').trim(),
       String(item.titleJa || item.title || '').replace(/\([^)]*\)/g, '').trim()].filter(Boolean).join(' ').trim();
    if (!baseTerm) {
      return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
    }

    const terms = [baseTerm];
    if (item.artistJa && item.titleJa) {
      const jaTerm = String(item.artistJa).trim() + ' ' + String(item.titleJa).replace(/\([^)]*\)/g, '').trim();
      if (jaTerm && terms.indexOf(jaTerm) === -1) terms.push(jaTerm);
    }

    let bestAlbum = null;
    let bestScore = -1;
    let bestSongMatch = null;
    let bestCountry = 'jp';
    const countries = ['jp', 'us'];

    for (let c = 0; c < countries.length && !bestAlbum; c++) {
      const country = countries[c];
      for (let t = 0; t < terms.length && !bestAlbum; t++) {
        const entities = item.digitalOnly ? ['song', 'album'] : ['album'];
        for (let e = 0; e < entities.length; e++) {
          const entity = entities[e];
          try {
            const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(terms[t]) +
              '&country=' + country + '&entity=' + entity + '&limit=8';
            const res = await fetchFn(url);
            if (!res.ok) continue;
            const data = await res.json();
            const results = Array.isArray(data && data.results) ? data.results : [];
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              if (!r) continue;
              const hay = (r.trackName || '') + ' ' + (r.collectionName || '') + ' ' + (r.artistName || '');
              if (!matchesGroupsOrFallback(hay, item)) continue;
              if (r.collectionId) {
                const ed = classifyItunesEdition(r.collectionName, !!item.digitalOnly);
                const score = ed.score + (country === 'jp' ? 10 : 0);
                if (score > bestScore) {
                  bestScore = score;
                  bestAlbum = r;
                  bestCountry = country;
                }
              } else if (!bestSongMatch && r.trackName) {
                bestSongMatch = r;
              }
            }
          } catch (err) {}
        }
      }
    }

    if (bestAlbum && bestAlbum.collectionId) {
      try {
        const lookupUrl = 'https://itunes.apple.com/lookup?id=' + encodeURIComponent(String(bestAlbum.collectionId)) +
          '&entity=song&country=' + bestCountry;
        const res = await fetchFn(lookupUrl);
        if (res.ok) {
          const data = await res.json();
          const results = Array.isArray(data && data.results) ? data.results : [];
          const songRows = results.filter(function (r) {
            return r && (r.wrapperType === 'track' || r.kind === 'song') && r.trackName;
          });
          if (songRows.length > 0) {
            const mapped = songRows.map(function (r, idx) {
              const entry = {
                disc: Number.isInteger(r.discNumber) && r.discNumber >= 1 ? r.discNumber : 1,
                mediaType: item.digitalOnly ? 'Digital' : 'CD',
                number: Number.isInteger(r.trackNumber) && r.trackNumber >= 1 ? r.trackNumber : (idx + 1),
                title: String(r.trackName).trim()
              };
              if (r.artistName && !isSameReleaseArtist(r.artistName, item)) {
                entry.artist = String(r.artistName).trim();
              }
              if (typeof r.trackTimeMillis === 'number' && Number.isFinite(r.trackTimeMillis) && r.trackTimeMillis >= 0) {
                entry.durationMs = Math.round(r.trackTimeMillis);
              }
              return entry;
            });
            return {
              tracks: normalizeTracksList(mapped),
              trackSource: 'itunes',
              sourceDetail: String(bestAlbum.collectionName || ('iTunes ' + bestCountry.toUpperCase())).trim(),
              mbid: ''
            };
          }
        }
      } catch (err) {}
    }

    if (item.digitalOnly && (bestSongMatch || bestAlbum)) {
      const song = bestSongMatch || bestAlbum;
      if (song && song.trackName) {
        const single = {
          disc: 1,
          mediaType: 'Digital',
          number: 1,
          title: String(song.trackName).trim()
        };
        if (typeof song.trackTimeMillis === 'number' && Number.isFinite(song.trackTimeMillis) && song.trackTimeMillis >= 0) {
          single.durationMs = Math.round(song.trackTimeMillis);
        }
        return {
          tracks: [single],
          trackSource: 'itunes',
          sourceDetail: String(song.collectionName || ('iTunes ' + bestCountry.toUpperCase())).trim(),
          mbid: ''
        };
      }
    }

    return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
  }

  /**
   * Fetch tracks for an item using explicit source ('musicbrainz' | 'itunes') or auto precedence.
   * @param {object} item
   * @param {{ source?: 'auto' | 'musicbrainz' | 'itunes', fetchImpl?: typeof fetch, queue?: object }} [opts]
   */
  async function fetchTracksForItem(item, opts) {
    const options = opts || {};
    const mode = options.source || 'auto';
    if (!item) {
      return { tracks: [], trackSource: null, sourceDetail: '', mbid: '' };
    }

    if (mode === 'musicbrainz') {
      return tryMusicBrainzTracks(item, options);
    }
    if (mode === 'itunes') {
      return tryItunesTracks(item, options);
    }

    if (item.digitalOnly) {
      return tryItunesTracks(item, options);
    }

    const mbRes = await tryMusicBrainzTracks(item, options);
    if (mbRes.tracks.length > 0) return mbRes;
    return tryItunesTracks(item, options);
  }

  function parseDurationToken(token) {
    const m = String(token || '').trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)$/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const mins = parseInt(m[2], 10);
    const secs = parseInt(m[3], 10);
    return ((h * 3600) + (mins * 60) + secs) * 1000;
  }

  function detectDiscHeader(line) {
    const trimmed = String(line || '').trim().replace(/^[-=*\s]+|[-=*\s]+$/g, '').trim();
    if (!trimmed) return null;

    let m = trimmed.match(/^\[?(?:disc|cd)\s*#?(\d+)(?:\s*[-–—:·•/]?\s*[\(\[]?([^()\[\]]+?)[\)\]]?)?\]?:?$/i);
    if (m) {
      return {
        disc: Math.max(1, parseInt(m[1], 10) || 1),
        mediaType: normalizeMediaType(m[2] || 'CD')
      };
    }

    m = trimmed.match(/^\[?(CD|BD|DVD|Blu-?ray|Digital)\]?:$/i);
    if (m) {
      return { disc: null, mediaType: normalizeMediaType(m[1]) };
    }

    m = trimmed.match(/^\[(CD|BD|DVD|Blu-?ray|Digital)\]$/i);
    if (m) {
      return { disc: null, mediaType: normalizeMediaType(m[1]) };
    }

    return null;
  }

  /**
   * Parse raw pasted multi-disc tracklist lines (numbered, tabbed, or plain) into TrackObjects.
   * @param {string} rawText
   * @returns {Array<object>}
   */
  function parseTracklistText(rawText) {
    const lines = String(rawText || '').split(/\r?\n/);
    const out = [];
    let currentDisc = 1;
    let currentMedia = 'CD';
    let nextNum = 1;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i].trim();
      if (!rawLine) continue;

      const discHeader = detectDiscHeader(rawLine);
      if (discHeader) {
        currentDisc = discHeader.disc !== null
          ? discHeader.disc
          : (out.length === 0 ? 1 : currentDisc + 1);
        currentMedia = discHeader.mediaType || 'CD';
        nextNum = 1;
        continue;
      }

      if (rawLine.indexOf('\t') !== -1) {
        const cols = rawLine.split('\t').map(function (c) { return c.trim(); });
        let num = nextNum;
        let idx = 0;
        if (/^\d{1,3}[.)]?$/.test(cols[0])) {
          num = parseInt(cols[0], 10);
          idx = 1;
        }
        const title = cols[idx] || '';
        if (!title) continue;
        const entry = { disc: currentDisc, mediaType: currentMedia, number: num, title: title };
        const rest = cols.slice(idx + 1).filter(Boolean);
        for (let r = 0; r < rest.length; r++) {
          const maybeDur = parseDurationToken(rest[r].replace(/^[\(\[]|[\)\]]$/g, ''));
          if (maybeDur !== null && entry.durationMs === undefined) {
            entry.durationMs = maybeDur;
          } else if (!entry.artist) {
            entry.artist = rest[r];
          }
        }
        out.push(entry);
        nextNum = num + 1;
        continue;
      }

      let work = rawLine;
      let num = nextNum;
      const numMatch = work.match(/^(\d{1,3})\s*(?:[.)]|[-–—])\s+(.+)$/);
      if (numMatch) {
        num = parseInt(numMatch[1], 10);
        work = numMatch[2].trim();
      }

      let durationMs = null;
      const parenDur = work.match(/^(.*?)\s*[\(\[]\s*((?:\d{1,2}:)?\d{1,2}:[0-5]\d)\s*[\)\]]\s*$/);
      if (parenDur) {
        const ms = parseDurationToken(parenDur[2]);
        if (ms !== null && parenDur[1].trim()) {
          work = parenDur[1].trim();
          durationMs = ms;
        }
      } else {
        const bareDur = work.match(/^(.*?)(?:\s*[-–—]\s*|\s+)((?:\d{1,2}:)?\d{1,2}:[0-5]\d)\s*$/);
        if (bareDur) {
          const ms = parseDurationToken(bareDur[2]);
          if (ms !== null && bareDur[1].trim()) {
            work = bareDur[1].trim();
            durationMs = ms;
          }
        }
      }

      if (!work) continue;
      const track = {
        disc: currentDisc,
        mediaType: currentMedia,
        number: num,
        title: work
      };
      if (durationMs !== null) {
        track.durationMs = durationMs;
      }
      out.push(track);
      nextNum = num + 1;
    }

    return normalizeTracksList(out);
  }

  /**
   * Serialize structured tracks[] into clean editable text that round-trips through parseTracklistText.
   * @param {Array<object>} tracks
   * @returns {string}
   */
  function formatTracklistForEdit(tracks) {
    const clean = normalizeTracksList(tracks);
    if (clean.length === 0) return '';

    const needsDiscHeader = clean.some(function (t) {
      return t.disc > 1 || (t.mediaType && t.mediaType !== 'CD');
    });

    const lines = [];
    let activeDisc = null;
    for (let i = 0; i < clean.length; i++) {
      const t = clean[i];
      if (needsDiscHeader && t.disc !== activeDisc) {
        if (lines.length > 0) lines.push('');
        lines.push('Disc ' + t.disc + ' (' + (t.mediaType || 'CD') + ')');
        activeDisc = t.disc;
      }
      const numStr = String(t.number).padStart(2, '0');
      const durStr = formatDurationMs(t.durationMs);
      if (t.artist) {
        lines.push([numStr, t.title, t.artist, durStr].filter(Boolean).join('\t'));
      } else {
        lines.push(numStr + '. ' + t.title + (durStr ? ' (' + durStr + ')' : ''));
      }
    }
    return lines.join('\n');
  }

  const VARIANT_INSTRUMENTAL_REGEX = /(?:\b(?:instrumental|inst\.?|off[\s-]*vocal|less[\s-]*vocal|karaoke|minus[\s-]*one|backing\s*track)\b|インスト(?:ゥルメンタル)?|オフボーカル|オフヴォーカル|カラオケ|歌なし)/i;
  const VARIANT_SHORT_REGEX = /(?:\b(?:tv[\s-]*(?:size|ver\.?|version|edit|length)|anime[\s-]*(?:size|ver\.?|version)|game[\s-]*(?:size|ver\.?|version)|short[\s-]*(?:size|ver\.?|version)|movie[\s-]*(?:size|ver\.?|version))\b|tvサイズ|テレビサイズ|ゲームサイズ|ショートバージョン)/i;
  const VARIANT_ALT_REGEX = /(?:\b(?:acoustic|piano\s*(?:ver\.?|version|arr\.?|arrangement)|remix|live(?:\s+ver\.?)?|orchestra(?:l)?|unplugged|rearrange(?:d)?)\b|アコースティック|ピアノバージョン|リミックス|ライブ)/i;

  function hasVariantKeyword(text) {
    return VARIANT_INSTRUMENTAL_REGEX.test(text) || VARIANT_SHORT_REGEX.test(text) || VARIANT_ALT_REGEX.test(text);
  }

  /**
   * Classify a track into vocal (default full track), instrumental, short (TV/Game Size), or alternate.
   * @param {string} title
   * @param {string} [notes]
   * @returns {'vocal' | 'instrumental' | 'short' | 'alternate'}
   */
  function classifyTrackVariant(title, notes) {
    const combined = String(title || '') + ' ' + String(notes || '');
    if (VARIANT_INSTRUMENTAL_REGEX.test(combined)) return 'instrumental';
    if (VARIANT_SHORT_REGEX.test(combined)) return 'short';
    if (VARIANT_ALT_REGEX.test(combined)) return 'alternate';
    return 'vocal';
  }

  /**
   * Strip variant qualifiers and normalize a track title for overlap comparison.
   * @param {string} rawTitle
   * @param {string} [notes]
   * @returns {{ base: string, compact: string, variant: string }}
   */
  function normalizeTrackTitle(rawTitle, notes) {
    const variant = classifyTrackVariant(rawTitle, notes);
    let stripped = String(rawTitle || '').trim();

    let prev;
    do {
      prev = stripped;
      stripped = stripped.replace(/\s*(?:\(([^()（）]*)\)|（([^()（）]*)）|\[([^\[\]]*)\])\s*$/g, function (full, a, b, c) {
        const inner = (a || b || c || '');
        return hasVariantKeyword(inner) ? ' ' : full;
      });
      stripped = stripped.replace(/\s*[-–—~～〜/]\s*([^/\-–—~～〜]+?)\s*[-–—~～〜]?\s*$/g, function (full, tail) {
        return hasVariantKeyword(tail) ? ' ' : full;
      });
    } while (stripped !== prev);

    const base = normalizeForMatch(stripped);
    return {
      base: base,
      compact: base.replace(/\s+/g, ''),
      variant: variant
    };
  }

  function trackFormsMatch(formA, formB) {
    if (!formA || !formB || !formA.base || !formB.base) return false;
    if (formA.base === formB.base) return true;
    if ((CJK_CHAR_REGEX.test(formA.base) || CJK_CHAR_REGEX.test(formB.base)) && formA.compact === formB.compact) {
      return true;
    }
    return false;
  }

  /**
   * Compare target tracks against owned tracks, distinguishing exact version matches from variant-only matches.
   * @param {Array<object>} targetTracks
   * @param {Array<object>} ownedTracks
   */
  function compareTrackLists(targetTracks, ownedTracks) {
    const targets = normalizeTracksList(targetTracks);
    const owned = normalizeTracksList(ownedTracks);

    const ownedIndexed = owned.map(function (tr) {
      const forms = [normalizeTrackTitle(tr.title, tr.notes)];
      if (tr.titleJa) forms.push(normalizeTrackTitle(tr.titleJa, tr.notes));
      return { track: tr, forms: forms.filter(function (f) { return !!f.base; }) };
    });

    let exactCount = 0;
    let variantCount = 0;
    const matches = targets.map(function (tr) {
      const tForms = [normalizeTrackTitle(tr.title, tr.notes)];
      if (tr.titleJa) tForms.push(normalizeTrackTitle(tr.titleJa, tr.notes));

      let bestMatchType = 'none';
      let bestOwned = null;

      for (let i = 0; i < ownedIndexed.length; i++) {
        const ow = ownedIndexed[i];
        for (let a = 0; a < tForms.length; a++) {
          for (let b = 0; b < ow.forms.length; b++) {
            if (!trackFormsMatch(tForms[a], ow.forms[b])) continue;
            if (tForms[a].variant === ow.forms[b].variant) {
              bestMatchType = 'exact';
              bestOwned = ow.track;
              break;
            } else if (bestMatchType === 'none') {
              bestMatchType = 'variant';
              bestOwned = ow.track;
            }
          }
          if (bestMatchType === 'exact') break;
        }
        if (bestMatchType === 'exact') break;
      }

      if (bestMatchType === 'exact') exactCount++;
      else if (bestMatchType === 'variant') variantCount++;

      return {
        targetTrack: tr,
        matchType: bestMatchType,
        matchedTrack: bestOwned
      };
    });

    return {
      total: targets.length,
      exactCount: exactCount,
      variantCount: variantCount,
      matches: matches
    };
  }

  const trackResolverApi = {
    DEFAULT_MB_MIN_INTERVAL_MS: DEFAULT_MB_MIN_INTERVAL_MS,
    deriveTrackReleaseKey: deriveTrackReleaseKey,
    formatDurationMs: formatDurationMs,
    normalizeTracksList: normalizeTracksList,
    resolveEffectiveTracks: resolveEffectiveTracks,
    createRateLimitedQueue: createRateLimitedQueue,
    tryMusicBrainzTracks: tryMusicBrainzTracks,
    tryItunesTracks: tryItunesTracks,
    fetchTracksForItem: fetchTracksForItem,
    parseTracklistText: parseTracklistText,
    formatTracklistForEdit: formatTracklistForEdit,
    classifyTrackVariant: classifyTrackVariant,
    normalizeTrackTitle: normalizeTrackTitle,
    compareTrackLists: compareTrackLists
  };

  if (root) {
    root.DiskCrate = root.DiskCrate || root.CDHunt || {};
    root.DiskCrate.trackResolver = trackResolverApi;
    root.CDHunt = root.DiskCrate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = trackResolverApi;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
