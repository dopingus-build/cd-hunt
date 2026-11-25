# Phase 1 Design: Shared Track Lists & Release Metadata Foundation

> [!IMPORTANT]
> **Status: Completed (`Phase 1` Shipped)**
> Implemented across `schemas/catalog.v1.schema.json`, `js/validate.js`, `js/db.js`, `js/track-resolver.js`, `index.html`, `css/styles.css`, and `js/app.js`. Its `tracks[]` schema, IndexedDB foundation, and `compareTrackLists` helper serve as the shared base for Phase 2.

---

## 1. Goals & Collector Decision-Making

In physical Japanese CD collecting, track lists directly determine whether a release is worth buying or already redundant:

- **Single vs. Album Overlap:** Knowing whether an album includes a single's A-side *and* coupling tracks (`c/w`), or whether a rare B-side only exists on the physical single.
- **Edition & Version Differences:** Distinguishing full-length vocal tracks from `TV Size`, `Game Size`, `Instrumental`, `Off Vocal`, or `Acoustic` versions, and inspecting bonus discs (`Disc 2 · BD` / `DVD` / bonus CD).
- **Pre-Collection Search:** Letting users search `#searchInput` by song title (e.g., finding which release contains a tie-in OP/ED or character song) even when the album title differs completely.

---

## 2. Additive Schema Extension (`schemaVersion: 1` Compatible)

[`schemas/catalog.v1.schema.json`](../../schemas/catalog.v1.schema.json) sets `additionalProperties: true` on `items[]`, allowing Phase 1 to extend release items additively without breaking any existing `schemaVersion: 1` catalog or requiring a schema version bump.

### 2.1 New Optional Fields on `items[]`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `barcode` | `string` | `undefined` | Physical retail JAN-13 / EAN-13 barcode digits (e.g., `"4540774241569"`), preparing items for Phase 3 barcode scanning and MusicBrainz `barcode:` lookups. |
| `mbid` | `string` | `undefined` | Exact MusicBrainz Release UUID (when pinned for cover/track disambiguation). |
| `trackSource` | `string` | `undefined` | Provenance marker: `'catalog' \| 'manual' \| 'musicbrainz' \| 'itunes'`. |
| `tracks` | `Array<TrackObject>` | `undefined` | Flat, ordered, multi-disc-aware array of tracks. |

### 2.2 `TrackObject` Shape

Using a flat array with `disc` numbers (instead of nested disc objects) keeps validation, search indexing, diffing, and Phase 2 track-overlap matching simple while preserving multi-disc sets (`CPCA-1043~4`, `AICL-4670~4671`, `LACM-34155`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `disc` | `integer >= 1` | Optional (`1`) | Disc/medium index (`1`, `2`, ...). |
| `mediaType` | `string` | Optional (`"CD"`) | One of `'CD' \| 'BD' \| 'DVD' \| 'Digital'`. |
| `number` | `integer >= 1` | **Required** | Track number within the disc. |
| `title` | `string` | **Required** | Primary track title (English, Romaji, or canonical release title). |
| `titleJa` | `string` | Optional | Japanese track title for bilingual matching/search. |
| `artist` | `string` | Optional | Per-track credited artist when distinct from release `artist` (critical for OSTs, character song albums, and VA compilations). |
| `durationMs` | `integer >= 0` | Optional | Track duration in milliseconds (rendered as `m:ss`). |
| `notes` | `string` | Optional | Track qualifier or edition note (e.g., `"TV Size"`, `"Instrumental"`, `"Off Vocal"`, `"Bonus Track"`). |

### 2.3 Concrete Multi-Disc Example

```json
{
  "id": "cd-sample-single",
  "category": "Anime Themes & Chara",
  "artist": "Example Artist",
  "artistJa": "サンプルアーティスト",
  "title": "Sample OP Single (CD+BD)",
  "titleJa": "サンプルOPシングル",
  "regCatNo": "LACM-24156",
  "catalog": "LACM-24156 (通常盤) / LACM-34156 (初回 CD+BD)",
  "barcode": "4540774241569",
  "mbEditions": [
    { "catno": "LACM-24156", "label": "通常盤 Regular" },
    { "catno": "LACM-34156", "label": "初回限定盤 CD+BD" }
  ],
  "kana": "サ / S",
  "filing": "サ — Anime Singles aisle",
  "price": "¥500–¥900",
  "trackSource": "catalog",
  "tracks": [
    { "disc": 1, "mediaType": "CD", "number": 1, "title": "Opening Theme", "titleJa": "オープニングテーマ", "durationMs": 252000 },
    { "disc": 1, "mediaType": "CD", "number": 2, "title": "Coupling Track", "titleJa": "カップリング曲", "durationMs": 238000 },
    { "disc": 1, "mediaType": "CD", "number": 3, "title": "Opening Theme (Instrumental)", "titleJa": "オープニングテーマ (Instrumental)", "durationMs": 252000, "notes": "Instrumental" },
    { "disc": 2, "mediaType": "BD", "number": 1, "title": "Opening Theme (Music Video)", "notes": "Bonus Blu-ray" }
  ]
}
```

### 2.4 Validation Rules (`js/validate.js`)

Add additive `validateTracks(tracks, prefix, errors)` and optional string checks in [`js/validate.js`](../../js/validate.js):
- `barcode`: if present, must be a string matching `/^\d{8,14}$/` (accepts empty `""` or valid EAN-8/UPC-12/JAN-13/ITF-14 after stripping hyphens/spaces, or reject non-digit noise).
- `mbid`: if present, must be a UUID-formatted string (or empty `""`).
- `trackSource`: if present, must be one of `'catalog' | 'manual' | 'musicbrainz' | 'itunes'`.
- `tracks`: if present, must be an Array; each entry must be a plain object with positive integer `number`, non-empty string `title`, optional positive integer `disc`, optional valid `mediaType`, optional non-negative integer `durationMs`, and optional strings `titleJa`, `artist`, `notes`.
- Prohibited-domain URL check (`collectProhibitedDomainErrors`) continues covering all new fields automatically.

---

## 3. Three-Layer Provenance & Track Resolution Pipeline

Track metadata quality varies sharply between physical databases and digital storefronts. New module `js/track-resolver.js` enforces a clear, non-destructive precedence order:

```text
Layer 1: Explicit Catalog JSON (item.tracks[]) or User Manual Override (IndexedDB manual_tracks)
   └── Always wins; never overwritten by automatic MusicBrainz or iTunes fetches.
Layer 2: MusicBrainz WS/2 (Primary auto-fetch for physical CDs)
   └── Physical-edition accurate: preserves multi-disc mediaType, bonus tracks, Instrumental/Off Vocal, per-track artists.
Layer 3: Apple iTunes Search / Lookup (Fallback & digitalOnly releases)
   └── Good day-1 J-pop/anime coverage, but digital tracklists often omit physical bonus tracks or Disc 2.
```

### 3.1 MusicBrainz Resolution (`catno:` / `barcode:`)
- **Lookup priority:**
  1. If `item.mbid` is present, query `https://musicbrainz.org/ws/2/release/<mbid>?inc=recordings+artist-credits+media&fmt=json` directly.
  2. Otherwise search using `item.barcode` (when set), then `item.regCatNo` and `item.mbEditions[].catno` (normalizing fullwidth tildes `～`/`〜` → `~` and falling back to base-disc prefix before `~`, matching the pattern already proved in [`js/cover-resolver.js`](../../js/cover-resolver.js)).
  3. Pick the best matching release (preferring exact `catno` match and matching medium count) and fetch `?inc=recordings+artist-credits&fmt=json`.
- **Rate-Limit Hygiene:** Enforce a single module-level FIFO queue guaranteeing **>= 1,100 ms spacing** between MusicBrainz requests (`~1 req/sec` API courtesy rule).
- **Trigger Policy:** **Lazy on-demand only** — resolved when opening **Crate Flip** (`#lbModal`) or clicking **Fetch Tracks**, never auto-fetching an entire 70-row catalog at page load.

### 3.2 Apple iTunes Fallback (`country=jp` → `country=us`)
- Invoked only when MusicBrainz returns no release or an empty medium list (or first for `digitalOnly: true` items).
- Searches `itunes.apple.com/search` (`entity=album`, validated via `requiredGroups` / normalized match helpers shared with [`js/cover-resolver.js`](../../js/cover-resolver.js)), then queries `https://itunes.apple.com/lookup?id=<collectionId>&entity=song&country=jp`.
- Always stamps `trackSource: 'itunes'` so the UI clearly surfaces the disclaimer: **`iTunes · Digital (may differ from physical CD)`**.

---

## 4. Local Persistence Foundation (`js/db.js`)

Rather than storing potentially thousands of track objects inside `localStorage`'s ~5 MB budget, Phase 1 introduces `js/db.js` — a zero-dependency IndexedDB wrapper (`disk_crate_db_v1`) with an in-memory `Map` fallback for sandboxed iframes or Node tests.

- **`track_cache` object store (keyPath `releaseKey`):** Caches fetched MusicBrainz / iTunes tracklists (`{ releaseKey, catNo, mbid, trackSource, sourceDetail, fetchedAt, tracks }`), keyed deterministically by normalized `regCatNo` / `mbid` / catalog item ID so shared releases across Hunt catalogs reuse cached tracks automatically.
- **`manual_tracks` object store (keyPath `releaseKey`):** Stores user-edited or pasted override tracklists (`{ releaseKey, trackSource: 'manual', updatedAt, tracks }`), synced cleanly alongside Phase 2 collection/state sync later.
- **Google Sheets Benefit:** Standalone Google Sheets catalogs remain strictly 9 columns ([`docs/sample-catalog-sheet.csv`](../sample-catalog-sheet.csv)); rows automatically gain tracklists in the UI through `js/track-resolver.js` + `js/db.js` without cluttering spreadsheet cells.

---

## 5. UI & UX Specification

### 5.1 Crate Flip Lightbox (`#lbModal`)
Add a collapsible **Track List** panel inside Crate Flip (`index.html` / `js/app.js` / `css/styles.css`):
- **Header:** `"Track List (N tracks · M discs)"`, active **Provenance Pill** (`Catalog`, `MusicBrainz · LACM-24156`, `iTunes · Digital`, or `Custom`), and compact actions (`Fetch Tracks` / `Refetch`, `Switch Source`, `Edit / Paste`).
- **Body:** Grouped by disc (`Disc 1 · CD`, `Disc 2 · BD`), displaying track number (`01`), `title` (+ `titleJa` sub-line when distinct), `artist` (when different from release artist), variant badge (`Instrumental`, `TV Size`, etc.), and right-aligned duration (`m:ss`).
- **Empty / Offline States:** Clean prompt with one-click **Fetch Tracks** (online) or **Paste / Add Tracks** (always available offline).

### 5.2 Smart Tracklist Paste & Edit Override
Provide a lightweight modal/drawer inside Crate Flip for quick overrides without manual row-by-row typing:
- Clicking **Edit / Paste Tracks** reveals a textarea + simple parser preview accepting common copy-paste formats from liner notes, Wikipedia, or track listings:
  - Numbered lines: `1. Song Title`, `01 - Song Title (4:12)`, `01. 曲名 [3:58]`
  - Disc headers: `Disc 1`, `Disc 2 (Blu-ray)`, `[CD]`, `[BD]`
  - Tab-delimited lines: `01\tTitle\tArtist\t4:12`
- Saving writes to `manual_tracks` (`trackSource: 'manual'`) and immediately overrides any cached auto-fetched data. A **Reset to Auto-Fetch** action removes the manual override cleanly.

### 5.3 Search Integration (`#searchInput`)
Extend card filtering in `js/app.js` to index release track titles (`tracks[].title`, `tracks[].titleJa`, `tracks[].artist`) from both `item.tracks` and loaded `track_cache` / `manual_tracks`:
- When a release matches the search query via a track rather than its album/artist metadata, show a compact hint chip on the card (e.g., `Track match: "Track Name"`).

---

## 6. Track Normalization & Variant-Aware Matching (Reusable Helper)

To power Phase 2's **"Already owned on another CD?"** indicator without false positives, expose shared pure functions (`normalizeTrackTitle`, `classifyTrackVariant`, `compareTrackLists`) in `js/track-resolver.js` (or dedicated helper `js/track-match.js`):

1. **String Normalization:** Reuse NFKC normalization, NFD diacritic folding, fullwidth tilde (`～`/`〜` → `~`), bracket/quote stripping, and CJK space-insensitive comparison patterns established in [`js/cover-resolver.js`](../../js/cover-resolver.js).
2. **Dual-Script Comparison:** Compare across both `title` and `titleJa` tokens so English/Romaji Hunt entries still match Japanese MusicBrainz/Owned tracks.
3. **Variant Qualifier Extraction:** Separate parenthetical or suffix tags before comparing base titles, classifying variant types:
   - `vocal` (default full vocal track)
   - `instrumental` (`Instrumental`, `Off Vocal`, `off vocal ver.`, `Karaoke`, `Less Vocal`, `マイナスワン`)
   - `short` (`TV Size`, `TV Ver.`, `Anime Size`, `Game Size`, `Short Ver.`)
   - `alternate` (`Acoustic`, `Piano Ver.`, `Remix`, `Live`, `Orchestra`)
4. **Match Tiers:**
   - **Exact Version Match:** Normalized base title matches AND variant class matches (`vocal` ↔ `vocal`).
   - **Variant Match Only:** Normalized base title matches BUT variant differs (`TV Size` vs. full `vocal`, or `Instrumental` vs. `vocal`) — surfaced distinctly (e.g., `"TV Size owned"` rather than falsely flagging full version owned).

---

## 7. Verification & Acceptance Criteria

### 7.1 Automated Tests (`node --test test/*.test.js`)
- **Unit tests:**
  - `validateCatalog` acceptance & error reporting for `tracks[]`, `trackSource`, `barcode`, `mbid`, and prohibited-domain detection inside track objects.
  - Raw tracklist paste parser across numbered, disc-header, duration, and tab-separated inputs.
  - MusicBrainz + iTunes tracklist payload normalization, fullwidth-tilde fallback, and polite >=1s rate-limit queue timing (mocked clock/fetch).
  - Variant-aware track matcher distinguishing full vocal vs. `Instrumental` / `TV Size` and bilingual `title`/`titleJa` matches.
  - `js/db.js` IndexedDB mock + in-memory fallback tests verifying Layer 1 (`manual` / `catalog`) precedence over cached auto-fetches.
- **DOM integration tests:**
  - Crate Flip renders multi-disc sections, provenance badge, and digital-vs-physical disclaimer on `trackSource: 'itunes'`.
  - `#searchInput` finds releases matching track titles and shows track-match hint chips.
- **Headless Chromium E2E (`scripts/e2e-browser.mjs`):**
  - Open Crate Flip → trigger mocked MusicBrainz tracklist fetch → reload page → assert tracks restore offline from IndexedDB → test paste override + track search.

### 7.2 Live Docs to Update When Phase 1 Ships
- [`schemas/catalog.v1.schema.json`](../../schemas/catalog.v1.schema.json)
- [`docs/METADATA.md`](../METADATA.md)
- [`docs/AGENT_CATALOG_GUIDE.md`](../AGENT_CATALOG_GUIDE.md) & [`.agents/skills/disk-crate-catalog/SKILL.md`](../../.agents/skills/disk-crate-catalog/SKILL.md)
- [`docs/HANDOVER.md`](../HANDOVER.md)
- [`README.md`](../../README.md)
