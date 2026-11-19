# Osaka CD Shopping Checklist & Cover Album — Project Handover

## 1. Project Overview & Goal
This project is a mobile-first, offline-capable web application (`osaka_cd_cover_album.html`) and companion Google Sheet designed for hunting used Japanese CDs in person across Osaka (e.g., Mandarake, Suruga-ya, Book Off, Disk Union in Nipponbashi, Namba, and Umeda).

- **Primary Artifact:** `osaka_cd_cover_album.html` (Zero-dependency HTML shell linking `css/styles.css` and modular JS in `js/`; `index.html` redirects to it for GitHub Pages alongside `.nojekyll`).
- **Catalog Data & Metadata:** Stored externally in [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata) as flat root-level JSON files (Osaka list: `2026-japan.json`). On first load without `?catalog=` or a saved URL, the app shows the Catalog Loader screen where users can paste any public metadata URL (with auto `blob` → `raw` conversion) or click the `2026-japan.json` preset. See [`METADATA.md`](./METADATA.md), [`sample-catalog.json`](./sample-catalog.json), and [`js/validate.js`](../js/validate.js).
- **Master Google Sheet:** [Osaka CD Shopping Checklist](https://docs.google.com/spreadsheets/d/1fVOtXaNniW62Ze0iZcQxGXRLaCbDlUBHjGZNRkO9u6A/edit) (44 physical CD rows + 2 digital-only rows).
- **Catalog Size in Web App:** **55 total entries** (**53 physical CDs** across 4 aisles, plus **2 digital-only tracks** separated so they do not inflate the physical shelf-hunting progress counter).

---

## 2. Core Architecture & Constraints (CRITICAL)
When continuing development on `osaka_cd_cover_album.html` in Antigravity (`agy`), strictly maintain these architectural rules:

1. **Zero External Dependencies / Zero CDN Scripts:**
   - Do **not** add Tailwind CDN (`cdn.tailwindcss.com`) or external icon/font scripts. Sandboxed preview panes and offline mobile environments in Osaka shops will block or hang on external runtime scripts.
   - All styling uses embedded CSS custom properties (`:root`) and clean responsive CSS Grid/Flexbox.
2. **Sandbox-Safe Storage Layer (`safeGetItem` / `safeSetItem`):**
   - `window.localStorage` calls are wrapped in `try/catch` with a fallback `memoryStore` object so sandboxed iframes never throw `SecurityError`.
3. **Instant First Paint + Viewport Lazy Loading:**
   - All 55 cards render immediately on load using offline data-URI Japanese Jewel Case + Obi Strip SVGs (`buildJewelCaseDataURI`).
   - Official album jackets load asynchronously via `IntersectionObserver` (`rootMargin: '250px 0px'`) and a 3-worker concurrency queue (`MAX_WORKERS = 3`).
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
- `cd_hunt_catalog_url_v1`: Active normalized metadata JSON URL (restored automatically on next visit when `?catalog=` is not supplied).
- `osaka_cd_checklist_v2`: Object mapping `album.id` → `boolean` (e.g., `{ "cd-01": true }`) or compatible checklist array format. Tracks acquired physical CDs (`0 / 53`) and saved digital tracks.
- `osaka_cd_cover_cache_v6`: Object mapping `album.id` → `{ variants: Array, selectedIndex: number }`. (Older `v1`–`v5` keys are automatically purged on startup).
- `osaka_cd_view_mode_v1`: `'grid'` or `'single'` (toggles between responsive multi-column cover grid and 1-column detailed card view).
- `osaka_cd_note_dismissed_v1`: `'1'` if the top digital-only reminder banner has been dismissed.

---

## 5. Catalog Breakdown (53 Physical + 2 Digital-Only)
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

## 6. How to Resume in Antigravity (`agy`)
1. Open the repository root containing `osaka_cd_cover_album.html`, `css/`, `js/`, `docs/`, and `test/` (and the companion `cd-metadata` repository containing `2026-japan.json`).
2. If transferring existing progress from another browser, open the app, click **Backup** in the top bar, copy the JSON string, and paste it into **Backup → Import & Restore** in the new browser.
3. Prompt Antigravity with:
   > *"Read `docs/HANDOVER.md`, `docs/METADATA.md`, and `osaka_cd_cover_album.html`. Keep the zero-CDN modular architecture, external metadata loader, `通常盤`-first cover resolution, and `localStorage` keys intact, and help me with [next feature/edit]."*
