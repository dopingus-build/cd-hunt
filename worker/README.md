# Disk Crate Sync Worker (`disk-crate/worker/`)

Cloudflare Worker + Cloudflare D1 backend for optional per-user cloud sync in [**Disk Crate**](https://dopingus-build.github.io/disk-crate/) ([`docs/CLOUD_SYNC_ARCHITECTURE.md`](../docs/CLOUD_SYNC_ARCHITECTURE.md)). *(Worker name `cd-hunt-sync` and hostname `cd-hunt-sync.tndo.workers.dev` are intentionally kept stable for now; see [`docs/plans/OVERVIEW.md`](../docs/plans/OVERVIEW.md) for the future rename runbook.)*

## 1. Overview & Zero-Scope Security Model

- **Zero-Scope GitHub OAuth (`scope=""`):** `/auth/login` omits `scope`, so GitHub only grants public profile identity (`{ id, login, avatar_url }`) with **zero access** to Gists, private repositories, or repository writes.
- **Immediate Token Discard:** `/auth/callback` reads `/user` once, discards GitHub's `access_token` without persisting it, and issues a Disk Crate-only HMAC-SHA256 session JWT (`30d` expiry) back via `#auth_token=<jwt>`.
- **D1 Persistence & Quota Protection:** User state JSON (`<= 128 KB`) is stored in Cloudflare D1 (`user_state` table) alongside per-user hourly write limits (`hour_window` / `hour_writes`) and global UTC daily free-tier counters (`daily_usage` table).

## 2. Endpoints & Status Codes

| Endpoint | Method | Auth | Purpose & Key Responses |
| --- | --- | --- | --- |
| `/auth/login` | `GET` | Public | Generates HMAC-signed `oauth_state` (`10m` TTL) and returns `302` redirect to GitHub OAuth (`scope` omitted). Optional `?redirect=<url>` must match `ALLOWED_ORIGINS` (`ALLOW_LOCALHOST`). `400` bad redirect, `500` if OAuth config missing. |
| `/auth/callback` | `GET` | `state` JWT | Exchanges `code`, reads GitHub `/user`, discards GitHub token, signs `session` JWT, and returns `302` to verified redirect target (or `APP_REDIRECT_URL`) `#auth_token=<jwt>`. `400` invalid params/state, `502` GitHub error, `500` missing config. |
| `/api/state` | `GET` | Bearer JWT | Checks origin & circuit breaker, increments daily `req_count`, and returns `{ ok, paused, user, state, updatedAt, resetsAt, shareToken, shareUrl }`. `401` invalid token, `403` bad origin, `503` paused. |
| `/api/state` | `PUT` | Bearer JWT | Validates payload (`schemaVersion: 1`, `cd_hunt_*` keys, `<= MAX_PAYLOAD_BYTES`), enforces per-user hourly write cap (`429`) and daily circuit breaker (`503`), strips transient `sheetSync`, increments counters, upserts `user_state`, optionally syncs Column A (`Got it?`) back to Google Sheets when `GOOGLE_SERVICE_ACCOUNT_JSON` is configured, and returns `{ ok, paused, updatedAt, resetsAt, shareToken, shareUrl, sheetSync? }`. `400` invalid JSON/schema, `401` unauthorized, `403` bad origin, `413` oversized. |
| `/api/collection` | `GET` | Session JWT | Incremental delta pull (`?since_seq=<n>&limit=<1..200>`). Returns `{ ok, seq, hasMore, nextSinceSeq, releases[] }` including active records and soft-delete tombstones (`deletedAt`). |
| `/api/collection/batch` | `POST` | Session JWT | Incremental upsert & tombstone sync (`upserts[]`, `deletes[]`). Assigns atomic monotonic `sync_seq`, enforces LWW timestamps (`conflicts[]`), counts as **1 write** per batch against hourly/daily caps, and enforces size/payload limits (`413`, `429`, `503`). |
| `/api/collection/sheet-sync` | `POST` | Session JWT + Service Account | Appends newly owned releases as 11-column rows to a shared Google Sheet tab (`#gid=` aware, deduplicated by `ID` or normalized `Catalog Number`). |
| `/api/share/<token>` | `GET` | Capability JWT (`90d` TTL) | Public read-only endpoint (`Access-Control-Allow-Origin: *`) for AI / LLM agents lacking GitHub credentials. Verifies `read_share` JWT (`401`), strips custom covers/internal fields, and returns Hunt state (`{ ok, user: { login }, updatedAt, activeCatalogUrl, catalogs }`, plus optional `collection[]` when `?include=collection` is passed) or Markdown via `?format=markdown`. Also accepts `/api/share?token=<token>`. |
| `/api/status` | `GET` | Public | Returns operational health, quota usage, and Google Sheet sync availability (`{ ok, paused, reason, utcDate, resetsAt, usage, limits, sheetSync }`). `403` bad origin. |
| `/*` | `OPTIONS` | Origin | CORS preflight supporting `GET, PUT, POST, OPTIONS` (`204` if origin allowed, `403` otherwise). Returns `404`/`405` for unknown routes/methods. |

### Owned Collection D1 Tables & Incremental Sync
- **`user_sync_state`** tracks each user's monotonic `next_seq`, `hour_window`, and `hour_writes` quota counter.
- **`owned_releases`** stores `(github_id, release_id)` JSON rows (`client_updated_at`, nullable `deleted_at` tombstone, `sync_seq`) indexed by `(github_id, sync_seq)` for paginated delta sync.
- Run `node --test test/collection.test.js test/worker-integration.test.js` (or `node --test test/*.test.js`) from the repository root to exercise the SQLite D1-backed worker tests locally.

## 3. Configuration & Secrets

### Public Variables (`wrangler.toml` `[vars]`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `"https://dopingus-build.github.io"` | Comma-separated list of allowed CORS & OAuth redirect origins (legacy single `ALLOWED_ORIGIN` also supported; override with `wrangler deploy --var ALLOWED_ORIGINS:...`) |
| `APP_REDIRECT_URL` | `"https://dopingus-build.github.io/disk-crate/"` | Default frontend redirect target receiving `#auth_token=<jwt>` when `?redirect=` is omitted |
| `GITHUB_CLIENT_ID` | `"Ov23liJMYOGioIFPGvzK"` (in `wrangler.toml`) | Public GitHub OAuth App Client ID (safe to commit) |
| `DAILY_REQ_LIMIT` | `"80000"` | Daily global UTC request circuit-breaker threshold (80% of 100k free tier) |
| `DAILY_WRITE_LIMIT` | `"80000"` | Daily global UTC write circuit-breaker threshold (80% of 100k D1 free tier) |
| `USER_HOURLY_WRITE_LIMIT` | `"60"` | Max writes per UTC hour per `github_id` (`HTTP 429` with `Retry-After`) |
| `MAX_PAYLOAD_BYTES` | `"131072"` | Maximum UTF-8 byte size for `PUT /api/state` (`128 KB`, `HTTP 413` if exceeded) |
| `PAUSE_SYNC` | `"false"` | Manual emergency kill switch; set `"true"` to pause `/api/state` immediately |
| `ALLOW_LOCALHOST` | *(unset)* | Optional `"true"` for local `localhost` / `127.0.0.1` testing (`wrangler dev`) |

*(For HTTP integration tests, the Worker also honors optional `GITHUB_OAUTH_TOKEN_URL`, `GITHUB_USER_API_URL`, `GOOGLE_OAUTH_TOKEN_URL`, and `GOOGLE_SHEETS_API_BASE_URL` env overrides.)*

### Encrypted Cloudflare Secrets (`wrangler secret put`)

Never commit secrets to Git or place them in `wrangler.toml`:

- **`GITHUB_CLIENT_SECRET`** — GitHub OAuth App client secret
- **`JWT_SECRET`** — Cryptographically random 32+ byte HMAC-SHA256 signing key (`openssl rand -hex 32`)
- **`GOOGLE_SERVICE_ACCOUNT_JSON`** *(optional)* — Google Cloud Service Account JSON key (`{ client_email, private_key, token_uri }`) for automatic two-way write-back of `Got it?` (`TRUE`/`FALSE`) into Column A of linked Google Sheets. On the live Worker, this is provisioned as `cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com`; to enable write-back on a Sheet, share it with that email as **Editor** (also visible via `GET /api/status` -> `sheetSync.serviceAccountEmail`). For self-hosted Workers, upload your own JSON via `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON` (or `.dev.vars` locally).

For local `wrangler dev` testing only, place these in `.dev.vars` (gitignored via `.gitignore`).

## 4. Deployment Runbook

```sh
cd worker

# 1. Create the D1 database and copy its database_id into worker/wrangler.toml [[d1_databases]]
wrangler d1 create cd-hunt-db

# 2. Apply schema.sql to the remote D1 database
wrangler d1 execute cd-hunt-db --remote --file=./schema.sql

# 3. Deploy the Worker to obtain your https://cd-hunt-sync.<subdomain>.workers.dev URL
wrangler deploy

# 4. Create the GitHub OAuth App (e.g. under dopingus-build -> Settings -> Developer settings -> OAuth Apps):
#    - Homepage URL:               https://dopingus-build.github.io/disk-crate/
#    - Authorization callback URL: https://cd-hunt-sync.<subdomain>.workers.dev/auth/callback
#    Set GITHUB_CLIENT_ID in worker/wrangler.toml and redeploy, then upload encrypted secrets:
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put JWT_SECRET
```

## 5. Configuring the Worker URL in GitHub Pages

Because Disk Crate is a zero-build static site hosted on GitHub Pages, the frontend's sync endpoint is configured via a small committed static module ([`js/config.js`](../js/config.js), loaded before `js/sync.js` / `js/app.js` and wired to `https://cd-hunt-sync.tndo.workers.dev` in production):

```js
window.DiskCrate = window.DiskCrate || window.CDHunt || {};
window.DiskCrate.config = {
  syncApiUrl: 'https://cd-hunt-sync.tndo.workers.dev'
};
window.CDHunt = window.DiskCrate;
```

- **Opt-In / Fork Safe Default (`""`):** Setting `syncApiUrl: ''` cleanly disables the cloud-sync / GitHub sign-in controls so forks or offline local bundles work purely with `localStorage` and show zero broken UI.
- **Local Dev Override (`?syncApi=` / `cd_hunt_sync_api_url_v1`):** For testing against `wrangler dev` (`http://127.0.0.1:8787`), a `?syncApi=` query param or `localStorage` override can redirect `syncApiUrl` only when pointing at explicit loopback URLs (otherwise pinned to `window.DiskCrate.config.syncApiUrl` to avoid untrusted token exfiltration).
- **Optional Multi-Environment CI Injection:** If separate staging/production deployments are ever needed, `.github/workflows/` (custom Pages deploy) can generate `js/config.js` at deploy time from a GitHub repository variable (`vars.SYNC_API_URL`) instead of committing a hardcoded URL.

## 6. Emergency Pause & Local Verification

- **Emergency Circuit Break:** Set `PAUSE_SYNC = "true"` under `[vars]` in `worker/wrangler.toml` and run `wrangler deploy` (or toggle it in the Cloudflare Dashboard). `/api/state` immediately returns `HTTP 503` (`{ ok: false, paused: true, reason: "manual_pause_enabled", resetsAt }`), leaving local `localStorage` unaffected.
- **Run Worker Unit, Integration, & Full-Stack System Tests:**
  ```sh
  node --test test/worker-sync.test.js test/worker-integration.test.js test/cloud-sync-system.test.js
  ```
- **Run Live Production Smoke Checks:**
  ```sh
  node --test scripts/smoke-live.mjs
  ```
- **Verify Cloudflare Bundle Compilation:**
  ```sh
  cd worker && wrangler deploy --dry-run
  ```
