# Disk Crate — Cover Album & Checklist (Project Handover)

## 1. Project Overview & Goal
`disk-crate` (**Disk Crate**, formerly `cd-hunt`) is a mobile-first, catalog-agnostic, zero-dependency web application (`index.html`) designed for hunting physical CDs and music releases in person across stores (such as Mandarake, Suruga-ya, Book Off, and Disk Union).

- **Primary Artifact:** `index.html` (Zero-dependency HTML shell linking `css/styles.css` and modular JS in `js/` exposing `window.DiskCrate` with legacy alias `window.CDHunt`; hosted directly on GitHub Pages alongside `.nojekyll`).
- **Agent Authoring Workflow:** [`docs/AGENT_CATALOG_GUIDE.md`](./AGENT_CATALOG_GUIDE.md) serves as the single self-contained guide (and reusable assistant instruction template) for curating 9-column, 1-release-per-row Google Sheets ([`docs/sample-catalog-sheet.csv`](./sample-catalog-sheet.csv)) and `schemaVersion: 1` JSON catalogs. Root [`AGENTS.md`](../AGENTS.md) and workspace skill [`.agents/skills/disk-crate-catalog/SKILL.md`](../.agents/skills/disk-crate-catalog/SKILL.md) wire this workflow into coding agents automatically.
- **Optional GitHub Cloud Sync:** Backed by Cloudflare Worker + D1 ([`worker/`](../worker/)), configured statically via [`js/config.js`](../js/config.js) (`https://cd-hunt-sync.tndo.workers.dev` — Worker hostname intentionally kept stable for now; see [`plans/OVERVIEW.md`](./plans/OVERVIEW.md)) and [`js/sync.js`](../js/sync.js). See [`CLOUD_SYNC_ARCHITECTURE.md`](./CLOUD_SYNC_ARCHITECTURE.md) for zero-scope GitHub OAuth flow, `<login>/cd-metadata` auto-discovery, custom-cover-only sync payloads, free-tier circuit breaker limits, and `visibilitychange`/`pagehide` `keepalive` flushes.
- **Catalog Data & Metadata:** Stored externally in [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata) as flat root-level JSON files (`index.json` + `2026-japan.json`) or in any user-provided public repository / `.json` file. On first load without `?catalog=` or a saved URL, the app shows the Catalog Loader screen where users can pick a dynamic preset from `cd-metadata/index.json`, paste a direct metadata JSON URL or bare GitHub repository URL (`https://github.com/<owner>/<repo>` or `/tree/<branch>` to load `index.json`), or load a local `.json` file. See [`METADATA.md`](./METADATA.md), [`AGENT_CATALOG_GUIDE.md`](./AGENT_CATALOG_GUIDE.md), [`schemas/catalog.v1.schema.json`](../schemas/catalog.v1.schema.json), [`sample-catalog.json`](./sample-catalog.json), and [`js/validate.js`](../js/validate.js).
- **Origin Master Google Sheet (Reference Catalog):** [Osaka CD Shopping Checklist](https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/edit) (initially 44 physical + 2 digital-only rows expanded into `2026-japan.json`, now 70 rows live).
- **Reference Preset Catalog (`2026-japan.json`):** **55 total entries** (**53 physical CDs** across 4 aisles, plus **2 digital-only tracks** separated so they do not inflate the physical shelf-hunting progress counter).

---

## 2. Core Architecture & Constraints (CRITICAL)
When continuing development on `disk-crate`, strictly maintain these architectural rules:

1. **Zero External Dependencies / Zero CDN Scripts:**
   - Do **not** add Tailwind CDN (`cdn.tailwindcss.com`) or external icon/font scripts. Sandboxed preview panes and offline mobile environments in shops will block or hang on external runtime scripts.
   - All styling uses embedded CSS custom properties (`:root`) in `css/styles.css` and responsive CSS Grid/Flexbox.
2. **Sandbox-Safe Storage Layer (`js/storage.js` & `js/db.js`):**
   - `window.localStorage` calls are wrapped in `try/catch` with a fallback `memoryStore` object so sandboxed iframes never throw `SecurityError`.
   - `js/db.js` wraps IndexedDB (`disk_crate_db_v1`: `track_cache` and `manual_tracks` stores keyed by `releaseKey`) with an automatic deep-cloned in-memory fallback when IndexedDB is unavailable or restricted.
3. **Instant First Paint + Viewport Lazy Loading:**
   - All loaded catalog cards render immediately on load using offline data-URI Japanese Jewel Case + Obi Strip SVGs (`buildJewelCaseDataURI`).
   - Official album jackets load asynchronously via `IntersectionObserver` (`rootMargin: '250px 0px'`) and a 3-worker concurrency queue (`MAX_WORKERS = 3`).
   - Multi-disc release track lists (`js/track-resolver.js`) resolve lazily on user request inside Crate Flip using strict 3-layer precedence (**Manual Override > Catalog JSON > Cached Auto-Fetch**: MusicBrainz `1 req/s` queue primary, Apple iTunes JP fallback with digital-edition disclaimer) without consuming cloud sync writes.
4. **No Hotlinked Third-Party Image URLs:**
   - Do **not** hardcode URLs from VGMdb, Wikia/Fandom, or CDJapan—they aggressively block hotlinking or return wrong promo art (e.g., Steam game art instead of soundtrack CD jackets). Rely on the two-stage verified resolver or user-added custom variants.

---

## 3. Cover Resolution & Edition Priority Rules
- **Non-Limited Regular Edition (`通常盤`) First:**
  - Every physical release defines `regCatNo` (its standard/regular edition catalog number) and an ordered `mbEditions` array placing `通常盤 Regular` first.
  - **Stage 1 (MusicBrainz + Cover Art Archive):** Queries `https://musicbrainz.org/ws/2/release/?query=catno:{catno}&fmt=json` by exact catalog number and verifies `https://coverartarchive.org/release/{mbid}/front-500` via an `Image()` load check (`naturalWidth > 40`).
  - **Stage 2 (Apple iTunes Search API):** Queries `country=jp` then `country=us` using `itunesQuery`, validates results against `requiredGroups` (AND-of-OR keyword groups to prevent false positives like *Breath of Fire* game art), upgrades `100x100bb` to `600x600bb`, and scores editions (`classifyItunesEdition`) so `通常盤` ranks above `アニメ盤` and `初回盤`.
- **Multi-Edition Variant Storage (`variants[]`):**
  - Instead of a single cover string, each release caches `{ variants: [{ url, label, catNo, source, isRegular }], selectedIndex }`.
  - Users can flip between editions inline on Grid cards (`< 1/N >`), via edition pills in 1-Column view, or manage/add/delete variants inside the **Crate Flip** lightbox modal.

---

## 4. `localStorage` Schema Keys
Storage keys use legacy `cd_hunt_*` identifiers intentionally preserved for zero-loss backwards compatibility across the `dopingus-build.github.io` origin and D1 backend (`CDHunt` / `DiskCrate.storage.deriveStoragePrefix(...)` derives per-catalog `<prefix>` = `cd_hunt_<slug>_<fnv1aHex>` from the catalog URL, local file name, or catalog title + item IDs so separate lists never collide):
- `cd_hunt_catalog_url_v1`: Active normalized metadata JSON file URL (restored automatically on next visit when `?catalog=` is not supplied).
- `cd_hunt_sync_token_v1`: Optional HMAC-SHA256 Disk Crate session JWT returned by the Cloudflare Worker (never stores any GitHub token).
- `cd_hunt_sync_api_url_v1`: Explicit loopback dev Worker override (`http://localhost:*` / `http://127.0.0.1:*`) set via `?syncApi=`.
- `cd_hunt_sync_meta_v1`: Cloud sync baseline timestamps (`{ updatedAt, activeCatalogUrl, catalogs }`).
- `<derivedPrefix>_checklist_v2`: Object mapping `album.id` → `boolean` (e.g., `{ "cd-01": true }`) or compatible checklist array format. Tracks acquired physical CDs (`0 / N`, e.g., `0 / 53` for `2026-japan.json`) and saved digital tracks.
- `<derivedPrefix>_cover_cache_v6`: Object mapping `album.id` → `{ variants: Array, selectedIndex: number }`. (Older `v1`–`v5` keys are automatically purged on startup).
- `<derivedPrefix>_view_mode_v1`: `'grid'` or `'single'` (toggles between responsive multi-column cover grid and 1-column detailed card view).
- `<derivedPrefix>_note_dismissed_v1`: `'1'` if the top digital-only reminder banner has been dismissed.
- `<derivedPrefix>_sheet_csv_v1`: Locally cached Google Sheet CSV payload for offline shop availability when no network connection is present.

---

## 5. Reference Catalog Breakdown (`cd-metadata/2026-japan.json`: 53 Physical + 2 Digital-Only)
1. **Video Game Soundtracks (`cd-01` to `cd-02`):**
   - *Breath of Fire III OST* (`CPCA-1004`), *Breath of Fire IV OST* (`CPCA-1043~4` / `CPCA-1044`).
2. **Anime Themes & Chara (`cd-03` to `cd-44`, including `cd-11b`):**
   - *(K)NoW_NAME* (*Fairy gone* OP/ED & *Rodeo* album), *sekai* (*Spira*), *Shiyui* (*Hollow*), *ChouCho* (*Harmonia*, *transient blue*), *Who-ya Extended*, *FictionJunction YUUKA* (*romanesque*), *SawanoHiroyuki[nZk]* (*2V-ALK* & *narrative / NOISEofRAIN* feat. LiSA), *EGOIST* (3 albums/EPs + 11 individual singles), *Princession Orchestra* (4 entries), *You and Idol Precure♪* (*Awakening Harmony*), *Mia REGINA*, *Void_Chords*, *10年黒組*, *Aqours*, *Parabola*, *Ceui*, *NOMELON NOLEMON*, *Aooo*, *yama* (*slash*), *Lapis Re:LiGHTs* (4 entries), *SukaSuka OST* (*青い記憶*).
3. **Seiyuu & Idol (`cd-45` to `cd-46`):**
   - *Rico Sasaki* (*スタート!* — Artist editions `AKCY-58074/B` or `AKCY-58075` only), *Yuki Tanaka* (*Treasure Chest*).
4. **J-Rock & J-Pop (`cd-47` to `cd-52`):**
   - *L'Arc~en~Ciel* (*DAYBREAK'S BELL*), *Hikaru Utada* (*Fantôme*), *school food punishment* (2 major albums, indie mini-albums, major singles).
5. **Digital-Only (`dig-01` to `dig-02` — Excluded from physical count):**
   - *Hanatan (花たん) — "gradation"* (no physical CD exists).
   - *Rokudenashi (ロクデナシ) — "ホウキボシ" (Houkiboshi)* (Digital single released July 15, 2026; written by Eve; no physical CD yet; latest physical album is *六花* `VICL-66106`).

---

## 6. How to Resume with a Coding Agent
1. Open the repository root containing `index.html`, `css/`, `js/`, `schemas/`, `docs/`, and `test/` (and the companion `cd-metadata` repository containing `index.json` and `2026-japan.json`).
2. If transferring existing progress from another browser, open the app, click **Backup** in the top bar, copy the JSON string, and paste it into **Backup → Import & Restore** in the new browser.
3. Prompt your coding agent with:
   > *"Read `docs/HANDOVER.md`, `docs/CLOUD_SYNC_ARCHITECTURE.md`, `docs/METADATA.md`, `docs/AGENT_CATALOG_GUIDE.md`, and `index.html`. Keep the zero-CDN modular architecture, `schemaVersion: 1` validation, external metadata loader, `通常盤`-first cover resolution, derived `localStorage` keys, and zero-scope Cloudflare cloud sync intact, and help me with [next feature/edit]."*
