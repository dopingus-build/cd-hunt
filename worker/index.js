/**
 * @fileoverview Cloudflare Worker for CD Hunt user-specific cloud sync.
 * Provides Zero-Scope GitHub OAuth login, HMAC-SHA256 session JWTs, D1 state persistence,
 * per-user hourly write limits, and a daily free-tier self-pausing circuit breaker.
 */
'use strict';

const DEFAULT_ALLOWED_ORIGIN = 'https://dopingus-build.github.io';
const DEFAULT_APP_REDIRECT_URL = 'https://dopingus-build.github.io/cd-hunt/';
const DEFAULT_DAILY_REQ_LIMIT = 80000;
const DEFAULT_DAILY_WRITE_LIMIT = 80000;
const DEFAULT_USER_HOURLY_WRITE_LIMIT = 60;
const DEFAULT_MAX_PAYLOAD_BYTES = 131072;
const OAUTH_STATE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET_CAT_CODE_REGEX = /\b([A-Z]{2,6}-\d{3,6}(?:~\d+)?)\b/g;
const STORAGE_PREFIX_REGEX = /^cd_hunt_[a-z0-9_]+_[0-9a-f]{8}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getCrypto() {
  return typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
}

function getFetch() {
  return typeof fetch !== 'undefined' ? fetch : globalThis.fetch;
}

function parsePositiveInt(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Format a timestamp in milliseconds to UTC date string `YYYY-MM-DD`.
 * @param {number} [nowMs]
 * @returns {string}
 */
function getUtcDateString(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Compute ISO timestamp for the next UTC midnight reset (`00:00:00.000Z`).
 * @param {number} [nowMs]
 * @returns {string}
 */
function getNextUtcMidnightIso(nowMs) {
  const d = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
  const nextMidnightMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return new Date(nextMidnightMs).toISOString().replace('.000Z', 'Z');
}

/**
 * Compute integer UTC hour window index for per-user rate limiting.
 * @param {number} [nowMs]
 * @returns {number}
 */
function getHourWindow(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  return Math.floor(ms / 3600000);
}

function getRetryAfterSeconds(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  const nextHourMs = (getHourWindow(ms) + 1) * 3600000;
  return Math.max(1, Math.ceil((nextHourMs - ms) / 1000));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(str) {
  const s = String(str || '');
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncodeString(str) {
  return base64UrlEncodeBytes(textEncoder.encode(str));
}

function base64UrlDecodeToString(str) {
  return textDecoder.decode(base64UrlDecodeToBytes(str));
}

async function importHmacKey(secret) {
  return getCrypto().subtle.importKey(
    'raw',
    textEncoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Sign a compact HMAC-SHA256 JWT.
 * @param {object} payload
 * @param {string} secret
 * @param {number} [ttlSeconds=2592000]
 * @param {number} [nowMs]
 * @returns {Promise<string>}
 */
async function signToken(payload, secret, ttlSeconds, nowMs) {
  if (!secret) {
    throw new Error('JWT secret is required');
  }
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  const iat = Math.floor(ms / 1000);
  const ttl = typeof ttlSeconds === 'number' ? ttlSeconds : SESSION_TTL_SECONDS;
  const claims = Object.assign({ iat: iat, exp: iat + ttl }, payload || {});
  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = headerB64 + '.' + payloadB64;

  const key = await importHmacKey(secret);
  const sigBuf = await getCrypto().subtle.sign('HMAC', key, textEncoder.encode(signingInput));
  return signingInput + '.' + base64UrlEncodeBytes(new Uint8Array(sigBuf));
}

/**
 * Verify an HMAC-SHA256 JWT signature and expiration. Returns decoded claims or null.
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowMs]
 * @returns {Promise<object | null>}
 */
async function verifyToken(token, secret, nowMs) {
  if (!token || !secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(base64UrlDecodeToString(parts[0]));
    if (!header || header.alg !== 'HS256') return null;

    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecodeToBytes(parts[2]);
    const valid = await getCrypto().subtle.verify(
      'HMAC',
      key,
      sigBytes,
      textEncoder.encode(parts[0] + '.' + parts[1])
    );
    if (!valid) return null;

    const claims = JSON.parse(base64UrlDecodeToString(parts[1]));
    const ms = typeof nowMs === 'number' ? nowMs : Date.now();
    const nowSec = Math.floor(ms / 1000);
    if (!claims || typeof claims.exp !== 'number' || nowSec >= claims.exp) {
      return null;
    }
    return claims;
  } catch (err) {
    return null;
  }
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '');
}

/**
 * Parse allowed CORS & OAuth redirect origins from comma-separated ALLOWED_ORIGINS
 * (with fallback to legacy single ALLOWED_ORIGIN or DEFAULT_ALLOWED_ORIGIN).
 * @param {object} [env]
 * @returns {string[]}
 */
function getAllowedOrigins(env) {
  const raw = (env && (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN)) || DEFAULT_ALLOWED_ORIGIN;
  const list = String(raw)
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ALLOWED_ORIGIN];
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (getAllowedOrigins(env).includes(normalized)) return true;
  if (env && String(env.ALLOW_LOCALHOST).toLowerCase() === 'true') {
    return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(normalized);
  }
  return false;
}

function validateRedirectUrl(rawRedirect, env) {
  if (!rawRedirect || typeof rawRedirect !== 'string') return null;
  try {
    const parsed = new URL(rawRedirect.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!isOriginAllowed(parsed.origin, env)) {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch (err) {
    return null;
  }
}

function buildCorsHeaders(request, env) {
  const reqOrigin = request && request.headers ? request.headers.get('Origin') : null;
  const allowedDefault = getAllowedOrigins(env)[0];
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
  if (reqOrigin && isOriginAllowed(reqOrigin, env)) {
    headers['Access-Control-Allow-Origin'] = normalizeOrigin(reqOrigin);
    headers.Vary = 'Origin';
  } else {
    headers['Access-Control-Allow-Origin'] = allowedDefault;
  }
  return headers;
}

function jsonResponse(body, status, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {});
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

function validateCatalogEntry(prefix, entry) {
  if (!STORAGE_PREFIX_REGEX.test(prefix)) {
    return 'Invalid catalog storage prefix "' + prefix + '"';
  }
  if (!isPlainObject(entry)) {
    return 'catalogs["' + prefix + '"] must be an object';
  }
  if (entry.updatedAt !== undefined && (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0)) {
    return 'catalogs["' + prefix + '"].updatedAt must be a non-negative finite number';
  }
  if (entry.checklist !== undefined && !isPlainObject(entry.checklist) && !Array.isArray(entry.checklist)) {
    return 'catalogs["' + prefix + '"].checklist must be an object or array';
  }
  if (entry.customCovers !== undefined) {
    if (!isPlainObject(entry.customCovers)) {
      return 'catalogs["' + prefix + '"].customCovers must be an object';
    }
    for (const [itemId, coverEntry] of Object.entries(entry.customCovers)) {
      if (!isPlainObject(coverEntry) || !Array.isArray(coverEntry.variants)) {
        return 'customCovers["' + itemId + '"] must contain a variants array';
      }
      for (let i = 0; i < coverEntry.variants.length; i++) {
        const v = coverEntry.variants[i];
        if (!isPlainObject(v) || typeof v.url !== 'string' || v.url.trim().length === 0) {
          return 'customCovers["' + itemId + '"].variants[' + i + '].url must be a non-empty string';
        }
      }
    }
  }
  if (entry.selectedVariants !== undefined && !isPlainObject(entry.selectedVariants)) {
    return 'catalogs["' + prefix + '"].selectedVariants must be an object';
  }
  if (entry.viewMode !== undefined && entry.viewMode !== 'grid' && entry.viewMode !== 'single') {
    return 'catalogs["' + prefix + '"].viewMode must be "grid" or "single"';
  }
  if (entry.noteDismissed !== undefined && typeof entry.noteDismissed !== 'boolean') {
    return 'catalogs["' + prefix + '"].noteDismissed must be a boolean';
  }
  return null;
}

/**
 * Validate a client-submitted sync payload against the v1 cloud sync structure.
 * @param {unknown} payload
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyncPayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: 'Payload must be a plain JSON object' };
  }
  if (payload.schemaVersion !== 1) {
    return { valid: false, error: 'schemaVersion must equal 1' };
  }
  if (payload.updatedAt !== undefined && (typeof payload.updatedAt !== 'number' || !Number.isFinite(payload.updatedAt) || payload.updatedAt < 0)) {
    return { valid: false, error: 'updatedAt must be a non-negative finite number' };
  }
  if (payload.activeCatalogUrl !== undefined && payload.activeCatalogUrl !== null) {
    if (typeof payload.activeCatalogUrl !== 'string' || payload.activeCatalogUrl.length > 2048) {
      return { valid: false, error: 'activeCatalogUrl must be a string <= 2048 characters or null' };
    }
  }
  if (!isPlainObject(payload.catalogs)) {
    return { valid: false, error: 'catalogs must be a plain object keyed by storage prefix' };
  }
  for (const [prefix, entry] of Object.entries(payload.catalogs)) {
    const err = validateCatalogEntry(prefix, entry);
    if (err) {
      return { valid: false, error: err };
    }
  }
  if (payload.sheetSync !== undefined && payload.sheetSync !== null) {
    if (!isPlainObject(payload.sheetSync)) {
      return { valid: false, error: 'sheetSync must be a plain object' };
    }
    if (typeof payload.sheetSync.googleSheetUrl !== 'string' || payload.sheetSync.googleSheetUrl.length > 2048) {
      return { valid: false, error: 'sheetSync.googleSheetUrl must be a string <= 2048 characters' };
    }
    if (!isPlainObject(payload.sheetSync.checklistByCatNo)) {
      return { valid: false, error: 'sheetSync.checklistByCatNo must be a plain object' };
    }
  }
  return { valid: true };
}

function getLimits(env) {
  return {
    dailyReqLimit: parsePositiveInt(env && env.DAILY_REQ_LIMIT, DEFAULT_DAILY_REQ_LIMIT),
    dailyWriteLimit: parsePositiveInt(env && env.DAILY_WRITE_LIMIT, DEFAULT_DAILY_WRITE_LIMIT),
    userHourlyWriteLimit: parsePositiveInt(env && env.USER_HOURLY_WRITE_LIMIT, DEFAULT_USER_HOURLY_WRITE_LIMIT),
    maxPayloadBytes: parsePositiveInt(env && env.MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES)
  };
}

async function getDailyUsage(db, utcDate) {
  if (!db) {
    return { utc_date: utcDate, req_count: 0, write_count: 0 };
  }
  const row = await db
    .prepare('SELECT utc_date, req_count, write_count FROM daily_usage WHERE utc_date = ?')
    .bind(utcDate)
    .first();
  if (!row) {
    return { utc_date: utcDate, req_count: 0, write_count: 0 };
  }
  return {
    utc_date: utcDate,
    req_count: Number(row.req_count) || 0,
    write_count: Number(row.write_count) || 0
  };
}

async function incrementDailyUsage(db, utcDate, isWrite) {
  await db
    .prepare(
      'INSERT INTO daily_usage (utc_date, req_count, write_count) VALUES (?, 1, ?) ' +
      'ON CONFLICT(utc_date) DO UPDATE SET ' +
      'req_count = req_count + 1, ' +
      'write_count = write_count + excluded.write_count'
    )
    .bind(utcDate, isWrite ? 1 : 0)
    .run();
}

function checkCircuitBreaker(usage, env, isWrite) {
  if (env && String(env.PAUSE_SYNC).toLowerCase() === 'true') {
    return { paused: true, reason: 'manual_pause_enabled' };
  }
  const limits = getLimits(env);
  if (usage.req_count >= limits.dailyReqLimit) {
    return { paused: true, reason: 'daily_free_tier_limit_reached' };
  }
  if (isWrite && usage.write_count >= limits.dailyWriteLimit) {
    return { paused: true, reason: 'daily_free_tier_limit_reached' };
  }
  return { paused: false, reason: null };
}

async function authenticateRequest(request, env, nowMs) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !env || !env.JWT_SECRET) return null;
  const claims = await verifyToken(match[1].trim(), env.JWT_SECRET, nowMs);
  if (!claims || claims.purpose !== 'session' || !claims.sub || !claims.login) {
    return null;
  }
  return claims;
}

function parseGoogleServiceAccount(env) {
  const raw = env && env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      return null;
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      tokenUri: typeof parsed.token_uri === 'string' && parsed.token_uri
        ? parsed.token_uri
        : 'https://oauth2.googleapis.com/token'
    };
  } catch (err) {
    return null;
  }
}

function extractSheetIdFromUrl(sheetUrl) {
  const match = String(sheetUrl || '').trim().match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  return match ? match[1] : null;
}

function extractSheetGidFromUrl(sheetUrl) {
  const match = String(sheetUrl || '').trim().match(/(?:[?&#])gid=(\d+)/i);
  return match && match[1] !== '0' ? match[1] : null;
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPkcs8PrivateKey(pem) {
  const normalizedPem = String(pem || '').replace(/\\n/g, '\n');
  const b64Body = normalizedPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!b64Body) {
    throw new Error('Empty Google Service Account private key');
  }
  const derBuffer = base64ToArrayBuffer(b64Body);
  return getCrypto().subtle.importKey(
    'pkcs8',
    derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getGoogleServiceAccountToken(sa, env, nowMs) {
  const fetchFn = getFetch();
  const tokenUrl = (env && env.GOOGLE_OAUTH_TOKEN_URL) || sa.tokenUri;
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  const nowSec = Math.floor(ms / 1000);

  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeString(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: tokenUrl,
      iat: nowSec,
      exp: nowSec + 3600
    })
  );
  const signingInput = headerB64 + '.' + payloadB64;

  const key = await importPkcs8PrivateKey(sa.privateKey);
  const sigBuf = await getCrypto().subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(signingInput));
  const assertion = signingInput + '.' + base64UrlEncodeBytes(new Uint8Array(sigBuf));

  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      encodeURIComponent(assertion)
  });
  if (!res.ok) {
    throw new Error('Google OAuth token exchange failed (HTTP ' + res.status + ')');
  }
  const data = await res.json();
  if (!data || !data.access_token) {
    throw new Error('Google OAuth response missing access_token');
  }
  return data.access_token;
}

async function syncChecklistToGoogleSheet(sheetSyncReq, env, nowMs) {
  const sa = parseGoogleServiceAccount(env);
  if (!sa) {
    return { ok: false, skipped: true, reason: 'service_account_not_configured' };
  }
  const sheetId = extractSheetIdFromUrl(sheetSyncReq && sheetSyncReq.googleSheetUrl);
  if (!sheetId) {
    return { ok: false, skipped: true, reason: 'invalid_sheet_url' };
  }

  const checklistByCatNo = {};
  if (sheetSyncReq && isPlainObject(sheetSyncReq.checklistByCatNo)) {
    for (const [k, v] of Object.entries(sheetSyncReq.checklistByCatNo)) {
      const norm = String(k || '').trim().toUpperCase();
      if (norm) checklistByCatNo[norm] = Boolean(v);
    }
  }
  if (Object.keys(checklistByCatNo).length === 0) {
    return { ok: true, updatedRows: 0 };
  }

  try {
    const fetchFn = getFetch();
    const accessToken = await getGoogleServiceAccountToken(sa, env, nowMs);
    const sheetsBase = ((env && env.GOOGLE_SHEETS_API_BASE_URL) || 'https://sheets.googleapis.com').replace(/\/+$/, '');

    let rangePrefix = '';
    const gid = extractSheetGidFromUrl(sheetSyncReq && sheetSyncReq.googleSheetUrl);
    if (gid !== null) {
      const metaUrl =
        sheetsBase +
        '/v4/spreadsheets/' +
        encodeURIComponent(sheetId) +
        '?fields=sheets.properties(sheetId,title)';
      const metaRes = await fetchFn(metaUrl, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        const sheets = Array.isArray(metaData && metaData.sheets) ? metaData.sheets : [];
        const matchedSheet = sheets.find(function (s) {
          return s && s.properties && Number(s.properties.sheetId) === Number(gid);
        });
        if (matchedSheet && matchedSheet.properties && matchedSheet.properties.title) {
          rangePrefix = "'" + String(matchedSheet.properties.title).replace(/'/g, "''") + "'!";
        }
      }
    }

    const rangeA1 = rangePrefix + 'A1:I500';
    const encodedRange = rangePrefix ? encodeURIComponent(rangeA1) : rangeA1;
    const rangeUrl = sheetsBase + '/v4/spreadsheets/' + encodeURIComponent(sheetId) + '/values/' + encodedRange;
    const readRes = await fetchFn(rangeUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!readRes.ok) {
      throw new Error('Google Sheets read failed (HTTP ' + readRes.status + ')');
    }

    const readData = await readRes.json();
    const rows = Array.isArray(readData && readData.values) ? readData.values : [];
    const updates = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const colA = String(row[0] || '').trim().toUpperCase();
      const colC = String(row[2] || '').trim().toUpperCase();
      if (colA === 'GOT IT?' || colC === 'ARTIST / FRANCHISE') continue;

      const searchHay = [String(row[4] || ''), String(row[3] || '')].join(' ');
      let matchedCode = null;
      let match;
      SHEET_CAT_CODE_REGEX.lastIndex = 0;
      while ((match = SHEET_CAT_CODE_REGEX.exec(searchHay)) !== null) {
        const candidate = match[1].toUpperCase();
        if (Object.prototype.hasOwnProperty.call(checklistByCatNo, candidate)) {
          matchedCode = candidate;
          break;
        }
      }
      if (!matchedCode) continue;

      const targetVal = checklistByCatNo[matchedCode] ? 'TRUE' : 'FALSE';
      if (colA !== targetVal) {
        updates.push({
          range: rangePrefix + 'A' + (i + 1),
          values: [[targetVal]]
        });
      }
    }

    if (updates.length > 0) {
      const writeUrl = sheetsBase + '/v4/spreadsheets/' + encodeURIComponent(sheetId) + '/values:batchUpdate';
      const writeRes = await fetchFn(writeUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: updates
        })
      });
      if (!writeRes.ok) {
        throw new Error('Google Sheets batchUpdate failed (HTTP ' + writeRes.status + ')');
      }
    }

    return { ok: true, updatedRows: updates.length };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function buildShareInfo(request, claims, env, nowMs) {
  if (!env || !env.JWT_SECRET || !claims || !claims.sub || !request || !request.url) {
    return { shareToken: null, shareUrl: null };
  }
  const shareToken = await signToken(
    {
      purpose: 'read_share',
      sub: String(claims.sub),
      login: String(claims.login || '')
    },
    env.JWT_SECRET,
    SHARE_TOKEN_TTL_SECONDS,
    nowMs
  );
  const origin = new URL(request.url).origin;
  return {
    shareToken: shareToken,
    shareUrl: origin + '/api/share/' + shareToken
  };
}

function sanitizeShareState(parsedState, rowUpdatedAt) {
  const raw = isPlainObject(parsedState) ? parsedState : {};
  const rawCatalogs = isPlainObject(raw.catalogs) ? raw.catalogs : {};
  const cleanCatalogs = {};

  for (const [prefix, entry] of Object.entries(rawCatalogs)) {
    if (!STORAGE_PREFIX_REGEX.test(prefix) || !isPlainObject(entry)) continue;
    cleanCatalogs[prefix] = {
      updatedAt: Number(entry.updatedAt) || 0,
      checklist: isPlainObject(entry.checklist) ? entry.checklist : {},
      viewMode: entry.viewMode === 'single' ? 'single' : 'grid'
    };
  }

  const effectiveUpdatedAt =
    rowUpdatedAt !== null && rowUpdatedAt !== undefined
      ? Number(rowUpdatedAt)
      : Number(raw.updatedAt) || null;

  return {
    schemaVersion: 1,
    updatedAt: effectiveUpdatedAt,
    activeCatalogUrl: typeof raw.activeCatalogUrl === 'string' ? raw.activeCatalogUrl : null,
    catalogs: cleanCatalogs
  };
}

function formatShareMarkdown(login, updatedAt, sanitizedState) {
  const updatedStr = updatedAt ? new Date(updatedAt).toISOString() : 'Not yet synced';
  const lines = [
    '# CD Hunt Live Status (@' + String(login || 'user') + ')',
    '',
    '- Last Synced: `' + updatedStr + '`',
    '- Active Catalog URL: ' + (sanitizedState.activeCatalogUrl ? sanitizedState.activeCatalogUrl : '_None_'),
    '',
    '## Catalog Checklists'
  ];

  const entries = Object.entries(sanitizedState.catalogs || {});
  if (entries.length === 0) {
    lines.push('', '_No synced catalog checklists yet._');
  } else {
    entries.forEach(function ([prefix, entry]) {
      const checklist = entry.checklist || {};
      const acquiredIds = Object.keys(checklist).filter(function (id) {
        return checklist[id] === true;
      });
      lines.push('');
      lines.push('### `' + prefix + '`');
      lines.push('- Acquired Count: `' + acquiredIds.length + '`');
      lines.push('- Acquired IDs (`Got it? = TRUE`): ' + (acquiredIds.length > 0 ? acquiredIds.map(function (id) { return '`' + id + '`'; }).join(', ') : '_None_'));
    });
  }

  lines.push('');
  return lines.join('\n');
}

async function handleStatus(env, corsHeaders, nowMs) {
  const utcDate = getUtcDateString(nowMs);
  const resetsAt = getNextUtcMidnightIso(nowMs);
  const limits = getLimits(env);
  const usage = await getDailyUsage(env && env.DB, utcDate);
  const circuit = checkCircuitBreaker(usage, env, false);
  const sa = parseGoogleServiceAccount(env);

  return jsonResponse(
    {
      ok: true,
      paused: circuit.paused,
      reason: circuit.reason,
      utcDate: utcDate,
      resetsAt: resetsAt,
      usage: {
        reqCount: usage.req_count,
        writeCount: usage.write_count
      },
      limits: limits,
      sheetSync: {
        configured: Boolean(sa),
        serviceAccountEmail: sa ? sa.clientEmail : null
      }
    },
    200,
    corsHeaders
  );
}

async function handleAuthLogin(url, env, nowMs) {
  if (!env || !env.GITHUB_CLIENT_ID || !env.JWT_SECRET) {
    return jsonResponse({ ok: false, error: 'OAuth configuration is incomplete' }, 500);
  }
  const redirectParam = url.searchParams.get('redirect');
  let redirectUrl = null;
  if (redirectParam !== null && redirectParam !== '') {
    redirectUrl = validateRedirectUrl(redirectParam, env);
    if (!redirectUrl) {
      return jsonResponse({ ok: false, error: 'Redirect origin not allowed' }, 400);
    }
  }
  const nonceBytes = getCrypto().getRandomValues(new Uint8Array(16));
  const stateClaims = { purpose: 'oauth_state', nonce: base64UrlEncodeBytes(nonceBytes) };
  if (redirectUrl) {
    stateClaims.redirectUrl = redirectUrl;
  }
  const stateToken = await signToken(
    stateClaims,
    env.JWT_SECRET,
    OAUTH_STATE_TTL_SECONDS,
    nowMs
  );

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', url.origin + '/auth/callback');
  authUrl.searchParams.set('state', stateToken);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl.toString() }
  });
}

async function handleAuthCallback(url, env, nowMs) {
  if (!env || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.JWT_SECRET) {
    return jsonResponse({ ok: false, error: 'OAuth configuration is incomplete' }, 500);
  }

  const oauthErr = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  if (oauthErr || !code || !stateParam) {
    return jsonResponse({ ok: false, error: oauthErr || 'Missing OAuth code or state' }, 400);
  }

  const stateClaims = await verifyToken(stateParam, env.JWT_SECRET, nowMs);
  if (!stateClaims || stateClaims.purpose !== 'oauth_state') {
    return jsonResponse({ ok: false, error: 'Invalid or expired OAuth state' }, 400);
  }

  const fetchFn = getFetch();
  const tokenUrl = (env && env.GITHUB_OAUTH_TOKEN_URL) || 'https://github.com/login/oauth/access_token';
  const tokenRes = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: code,
      redirect_uri: url.origin + '/auth/callback'
    })
  });
  if (!tokenRes.ok) {
    return jsonResponse({ ok: false, error: 'GitHub token exchange failed' }, 502);
  }

  const tokenData = await tokenRes.json();
  const ghAccessToken = tokenData && tokenData.access_token;
  if (!ghAccessToken) {
    return jsonResponse({ ok: false, error: 'Missing GitHub access_token' }, 502);
  }

  const userApiUrl = (env && env.GITHUB_USER_API_URL) || 'https://api.github.com/user';
  const userRes = await fetchFn(userApiUrl, {
    headers: {
      Authorization: 'Bearer ' + ghAccessToken,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cd-hunt-sync-worker'
    }
  });
  if (!userRes.ok) {
    return jsonResponse({ ok: false, error: 'Failed to load GitHub user profile' }, 502);
  }

  const ghUser = await userRes.json();
  if (!ghUser || !ghUser.id || !ghUser.login) {
    return jsonResponse({ ok: false, error: 'Incomplete GitHub user profile' }, 502);
  }

  // Zero-scope design: ghAccessToken is intentionally never stored and is discarded here.
  const sessionToken = await signToken(
    {
      purpose: 'session',
      sub: String(ghUser.id),
      login: String(ghUser.login),
      avatarUrl: String(ghUser.avatar_url || '')
    },
    env.JWT_SECRET,
    SESSION_TTL_SECONDS,
    nowMs
  );

  let redirectBase = (env && env.APP_REDIRECT_URL) || DEFAULT_APP_REDIRECT_URL;
  if (stateClaims.redirectUrl) {
    const verifiedRedirect = validateRedirectUrl(stateClaims.redirectUrl, env);
    if (verifiedRedirect) {
      redirectBase = verifiedRedirect;
    }
  }
  return new Response(null, {
    status: 302,
    headers: { Location: redirectBase + '#auth_token=' + encodeURIComponent(sessionToken) }
  });
}

async function handleGetState(request, env, corsHeaders, nowMs) {
  const claims = await authenticateRequest(request, env, nowMs);
  if (!claims) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (!env || !env.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is missing' }, 500, corsHeaders);
  }

  const utcDate = getUtcDateString(nowMs);
  const resetsAt = getNextUtcMidnightIso(nowMs);
  const usage = await getDailyUsage(env.DB, utcDate);
  const circuit = checkCircuitBreaker(usage, env, false);
  if (circuit.paused) {
    return jsonResponse({ ok: false, paused: true, reason: circuit.reason, resetsAt: resetsAt }, 503, corsHeaders);
  }

  await incrementDailyUsage(env.DB, utcDate, false);
  const row = await env.DB
    .prepare('SELECT github_id, github_login, state_json, updated_at, hour_window, hour_writes FROM user_state WHERE github_id = ?')
    .bind(String(claims.sub))
    .first();

  let parsedState = null;
  if (row && typeof row.state_json === 'string') {
    try {
      parsedState = JSON.parse(row.state_json);
    } catch (err) {
      parsedState = null;
    }
  }

  const shareInfo = await buildShareInfo(request, claims, env, nowMs);

  return jsonResponse(
    {
      ok: true,
      paused: false,
      user: {
        id: String(claims.sub),
        login: String(claims.login),
        avatarUrl: String(claims.avatarUrl || '')
      },
      state: parsedState,
      updatedAt: row ? Number(row.updated_at) : null,
      resetsAt: resetsAt,
      shareToken: shareInfo.shareToken,
      shareUrl: shareInfo.shareUrl
    },
    200,
    corsHeaders
  );
}

async function handleGetShare(request, url, rawToken, env, nowMs) {
  const publicHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-store'
  };

  if (!rawToken || !env || !env.JWT_SECRET) {
    return jsonResponse({ ok: false, error: 'Invalid or expired share token' }, 401, publicHeaders);
  }
  const claims = await verifyToken(rawToken.trim(), env.JWT_SECRET, nowMs);
  if (!claims || claims.purpose !== 'read_share' || !claims.sub) {
    return jsonResponse({ ok: false, error: 'Invalid or expired share token' }, 401, publicHeaders);
  }
  if (!env.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is missing' }, 500, publicHeaders);
  }

  const utcDate = getUtcDateString(nowMs);
  const resetsAt = getNextUtcMidnightIso(nowMs);
  const usage = await getDailyUsage(env.DB, utcDate);
  const circuit = checkCircuitBreaker(usage, env, false);
  if (circuit.paused) {
    return jsonResponse({ ok: false, paused: true, reason: circuit.reason, resetsAt: resetsAt }, 503, publicHeaders);
  }

  await incrementDailyUsage(env.DB, utcDate, false);
  const row = await env.DB
    .prepare('SELECT github_login, state_json, updated_at FROM user_state WHERE github_id = ?')
    .bind(String(claims.sub))
    .first();

  let parsedState = null;
  if (row && typeof row.state_json === 'string') {
    try {
      parsedState = JSON.parse(row.state_json);
    } catch (err) {
      parsedState = null;
    }
  }

  const sanitized = sanitizeShareState(parsedState, row ? row.updated_at : null);
  const login = (row && row.github_login) || String(claims.login || '');
  const formatParam = String(url.searchParams.get('format') || '').toLowerCase();
  const acceptHeader = String(request.headers.get('Accept') || '').toLowerCase();
  const wantsMarkdown = formatParam === 'markdown' || formatParam === 'md' || acceptHeader.includes('text/markdown');

  if (wantsMarkdown) {
    return new Response(formatShareMarkdown(login, sanitized.updatedAt, sanitized), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'text/markdown; charset=utf-8' }, publicHeaders)
    });
  }

  return jsonResponse(
    {
      ok: true,
      user: {
        login: String(login)
      },
      updatedAt: sanitized.updatedAt,
      activeCatalogUrl: sanitized.activeCatalogUrl,
      catalogs: sanitized.catalogs
    },
    200,
    publicHeaders
  );
}

async function handlePutState(request, env, corsHeaders, nowMs) {
  const claims = await authenticateRequest(request, env, nowMs);
  if (!claims) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (!env || !env.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is missing' }, 500, corsHeaders);
  }

  const utcDate = getUtcDateString(nowMs);
  const resetsAt = getNextUtcMidnightIso(nowMs);
  const limits = getLimits(env);
  const usage = await getDailyUsage(env.DB, utcDate);
  const circuit = checkCircuitBreaker(usage, env, true);
  if (circuit.paused) {
    return jsonResponse({ ok: false, paused: true, reason: circuit.reason, resetsAt: resetsAt }, 503, corsHeaders);
  }

  const rawBody = await request.text();
  const payloadBytes = textEncoder.encode(rawBody).length;
  if (payloadBytes > limits.maxPayloadBytes) {
    return jsonResponse(
      { ok: false, error: 'Payload exceeds maximum allowed size', maxBytes: limits.maxPayloadBytes },
      413,
      corsHeaders
    );
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Request body must be valid JSON' }, 400, corsHeaders);
  }

  const validation = validateSyncPayload(parsedBody);
  if (!validation.valid) {
    return jsonResponse({ ok: false, error: validation.error }, 400, corsHeaders);
  }

  const hourWindow = getHourWindow(nowMs);
  const existingUser = await env.DB
    .prepare('SELECT updated_at, hour_window, hour_writes FROM user_state WHERE github_id = ?')
    .bind(String(claims.sub))
    .first();

  if (
    existingUser &&
    Number(existingUser.hour_window) === hourWindow &&
    Number(existingUser.hour_writes) >= limits.userHourlyWriteLimit
  ) {
    const retryAfter = getRetryAfterSeconds(nowMs);
    return jsonResponse(
      {
        ok: false,
        error: 'rate_limit_exceeded',
        retryAfterSeconds: retryAfter
      },
      429,
      Object.assign({ 'Retry-After': String(retryAfter) }, corsHeaders)
    );
  }

  const sheetSyncReq = parsedBody.sheetSync || null;
  if (Object.prototype.hasOwnProperty.call(parsedBody, 'sheetSync')) {
    delete parsedBody.sheetSync;
  }

  const canonicalJson = JSON.stringify(parsedBody);
  await incrementDailyUsage(env.DB, utcDate, true);
  await env.DB
    .prepare(
      'INSERT INTO user_state (github_id, github_login, state_json, updated_at, hour_window, hour_writes) ' +
      'VALUES (?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(github_id) DO UPDATE SET ' +
      'github_login = excluded.github_login, ' +
      'state_json = excluded.state_json, ' +
      'updated_at = excluded.updated_at, ' +
      'hour_window = excluded.hour_window, ' +
      'hour_writes = CASE ' +
      'WHEN user_state.hour_window = excluded.hour_window THEN user_state.hour_writes + 1 ' +
      'ELSE 1 END'
    )
    .bind(String(claims.sub), String(claims.login), canonicalJson, nowMs, hourWindow)
    .run();

  const shareInfo = await buildShareInfo(request, claims, env, nowMs);
  const resBody = {
    ok: true,
    paused: false,
    updatedAt: nowMs,
    resetsAt: resetsAt,
    shareToken: shareInfo.shareToken,
    shareUrl: shareInfo.shareUrl
  };
  if (sheetSyncReq) {
    resBody.sheetSync = await syncChecklistToGoogleSheet(sheetSyncReq, env, nowMs);
  }

  return jsonResponse(resBody, 200, corsHeaders);
}

/**
 * Cloudflare Worker fetch handler.
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleFetch(request, env) {
  const url = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const corsHeaders = buildCorsHeaders(request, env);
  const origin = request.headers.get('Origin');
  const nowMs = Date.now();

  if (url.pathname === '/api/share' || url.pathname.startsWith('/api/share/')) {
    const publicCorsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept'
    };
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: publicCorsHeaders });
    }
    if (method !== 'GET') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, publicCorsHeaders);
    }
    let rawToken = '';
    if (url.pathname.startsWith('/api/share/')) {
      try {
        rawToken = decodeURIComponent(url.pathname.slice('/api/share/'.length).replace(/\/+$/, ''));
      } catch (err) {
        rawToken = '';
      }
    } else {
      rawToken = url.searchParams.get('token') || '';
    }
    return handleGetShare(request, url, rawToken, env, nowMs);
  }

  if (method === 'OPTIONS') {
    if (!isOriginAllowed(origin, env)) {
      return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403);
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname.startsWith('/api/') && !isOriginAllowed(origin, env)) {
    return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403);
  }

  if (url.pathname === '/auth/login') {
    if (method !== 'GET') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
    return handleAuthLogin(url, env, nowMs);
  }

  if (url.pathname === '/auth/callback') {
    if (method !== 'GET') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
    return handleAuthCallback(url, env, nowMs);
  }

  if (url.pathname === '/api/status') {
    if (method !== 'GET') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
    return handleStatus(env, corsHeaders, nowMs);
  }

  if (url.pathname === '/api/state') {
    if (method === 'GET') return handleGetState(request, env, corsHeaders, nowMs);
    if (method === 'PUT') return handlePutState(request, env, corsHeaders, nowMs);
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404, corsHeaders);
}

module.exports = {
  fetch: handleFetch,
  signToken: signToken,
  verifyToken: verifyToken,
  validateSyncPayload: validateSyncPayload,
  getAllowedOrigins: getAllowedOrigins,
  getUtcDateString: getUtcDateString,
  getNextUtcMidnightIso: getNextUtcMidnightIso,
  getHourWindow: getHourWindow,
  extractSheetIdFromUrl: extractSheetIdFromUrl,
  extractSheetGidFromUrl: extractSheetGidFromUrl,
  parseGoogleServiceAccount: parseGoogleServiceAccount
};
