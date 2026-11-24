# Phase 2 Design: Owned Releases Database, Incremental Sync & Hunt Cross-Referencing

> [!IMPORTANT]
> **Status: Planned Design Specification (Not Yet Implemented)**
> Builds directly on Phase 1's shared `tracks[]` schema, `js/db.js` IndexedDB foundation, and variant-aware track matcher to add a dedicated **Owned Collection** mode alongside **Hunt** mode.

---

## 1. Goals & Scale Profile

- **Target Scale:** Comfortable day-to-day performance at **1,000+ owned releases** (with headroom for 5,000–10,000+ releases).
- **Storage Footprint:** Metadata + bilingual fields + multi-disc tracklists average ~1.5–2 KB per release (binary cover images are **not** stored; covers resolve lazily or reference lightweight custom URLs). At 1,000 CDs, total dataset size is **~1.5–2 MB** — far too large for the existing 128 KB single-blob `user_state.state_json` in Cloudflare D1, yet very lightweight in IndexedDB and normalized D1 rows.
- **Primary Source of Truth + Portable Backups:**
  - **Live Store:** Browser `IndexedDB` + incremental Cloudflare D1 cloud sync (preserving **Zero-Scope GitHub OAuth**).
  - **Lossless JSON Backing:** Validated `owned-collection.json` export/import + optional collection support on `/api/share/<token>`.
  - **Tabular Google Sheet Backing:** Clean 11-column Owned Sheet sync-out mirror + sheet import/merge via the Worker's existing Google Service Account.

---

## 2. Owned Release Data Model (`schemas/collection.v1.schema.json`)

Each entry in the Owned Collection represents **one physical (or explicitly archived) copy/edition** owned by the user, allowing multiple editions of the same album (e.g., both Regular and Limited CD+BD) to coexist cleanly.

### 2.1 Owned Release Fields

| Group | Field | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| **Identity** | `id` | `string` | **Required** | Unique local/sync UUID or slug (`^[a-zA-Z0-9_-]+$`), independent of `catNo` so duplicate copies or multiple editions work cleanly. |
| **Core Metadata** | `artist`, `artistJa`, `title`, `titleJa`, `category` | `string` | `artist`, `title`, `category` required | Shared release display & search fields (`artistJa`/`titleJa` optional). |
| **Edition ID** | `catNo` | `string` | **Required** | Exact catalog number owned, normalized (`～`/`〜` → `~`, e.g., `"LACM-24156"`). |
| **Edition Info** | `editionLabel`, `barcode`, `mbid` | `string` | Optional | Edition descriptor (`"通常盤 Regular"`, `"初回限定盤 CD+BD"`), JAN-13 barcode digits, MusicBrainz release UUID. |
| **Tracks** | `tracks`, `trackSource` | `Array` / `string` | Optional | Reuses exact Phase 1 `TrackObject[]` and `'manual' \| 'catalog' \| 'musicbrainz' \| 'itunes'` provenance. |
| **Covers** | `customCovers`, `selectedVariant` | `Object` | Optional | Same compact custom-cover-only sync rule used by Hunt state (never stores binary blobs). |
| **Ownership** | `purchasePrice`, `purchaseShop`, `purchaseDate`, `notes` | `string` | Optional | All optional so fast camera cataloging stays frictionless (`"¥900"`, `"Book Off"`, `"2026-11-20"`, `"No obi; mint disc"`). |
| **Sync Meta** | `createdAt`, `clientUpdatedAt`, `syncSeq`, `deletedAt` | `integer \| null` | Managed | Epoch ms timestamps + server-assigned monotonic `sync_seq` (`null` until synced); `deletedAt !== null` indicates tombstone. |

---

## 3. Browser Storage Architecture (`js/db.js`)

Phase 2 extends `disk_crate_db_v1` in `js/db.js`:

1. **`owned_releases` store (keyPath `'id'`):**
   - Indexes: `by_catNo` (`catNo`), `by_barcode` (`barcode`), `by_category` (`category`), `by_dirty` (`dirty`), `by_deletedAt` (`deletedAt`).
   - Local-only `dirty: 1 | 0` flag tracks records added, edited, or soft-deleted while offline until acknowledged by `/api/collection/batch`.
2. **`sync_meta` store (keyPath `'key'`):**
   - Holds `collectionSync` (`{ lastSyncSeq: 0, lastPulledAt, lastPushedAt, lastOwnedSheetUrl }`).
3. **Fast Startup Cross-Reference Index:**
   - Reading active owned summaries (`{ id, catNo, barcode, artist, artistJa, title, titleJa, tracks }`) into memory takes ~10 ms for 1,000 items, allowing **Hunt mode** to display live ownership and track-overlap badges without blocking first paint.

---

## 4. Incremental Cloud Sync Architecture (Cloudflare Worker + D1)

### 4.1 Why Server-Assigned `sync_seq` Beats Timestamps

1. **Exceeding the 128 KB Blob Cap:** Existing `user_state.state_json` caps full Hunt payloads at `131072` bytes (`MAX_PAYLOAD_BYTES`). Normalized per-release rows let a scan or edit upload ~1.5 KB instead of re-writing 1.5–2 MB every time.
2. **Immune to Offline Clock Skew & Backfill Misses:** If Device A syncs at `10:00:05` and Device B later pushes a CD scanned offline at `09:50:00`, querying by client timestamp `updated_at > 10:00:05` would **miss** Device B's item. Assigning a **per-user strictly increasing integer `sync_seq` (`1, 2, 3, ...`) on the Worker at write time** guarantees Device A picks up every delayed offline upload cleanly, with exact pagination and zero boundary skips.

### 4.2 Proposed D1 Schema Additions (`worker/schema.sql`)

```sql
-- Per-user monotonic sync sequence counter for collection rows
CREATE TABLE IF NOT EXISTS user_sync_state (
  github_id TEXT PRIMARY KEY,
  next_seq  INTEGER NOT NULL DEFAULT 0
);

-- Incremental, tombstone-aware owned release store (~1,000+ releases per user)
CREATE TABLE IF NOT EXISTS owned_releases (
  github_id         TEXT NOT NULL,
  release_id        TEXT NOT NULL,
  data_json         TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  deleted_at        INTEGER,
  sync_seq          INTEGER NOT NULL,
  PRIMARY KEY (github_id, release_id)
);

CREATE INDEX IF NOT EXISTS idx_owned_releases_sync
  ON owned_releases (github_id, sync_seq);
```

### 4.3 Worker API Contract (`worker/index.js`)

All new routes enforce existing Worker security and quota invariants: verified HMAC-SHA256 Bearer JWT (`github_id` strictly from JWT `sub`, never request body), `ALLOWED_ORIGINS` CORS validation, `PAUSE_SYNC` kill switch, global UTC `daily_usage` circuit breaker, and per-user hourly write limits (`USER_HOURLY_WRITE_LIMIT`).

| Endpoint | Method | Auth | Behavior |
| --- | --- | --- | --- |
| `/api/collection?since=<int>&limit=200` | `GET` | Bearer JWT | Queries `WHERE github_id = ? AND sync_seq > ? ORDER BY sync_seq ASC LIMIT limit+1`. Returns `{ ok: true, paused: false, items, nextCursor, hasMore, latestSeq, resetsAt }`. |
| `/api/collection/batch` | `POST` | Bearer JWT | Accepts up to `50`–`100` upserts/tombstone deletes per batch request (`<= MAX_PAYLOAD_BYTES`). Counts as **1 hourly write** against `hour_writes` so batch-scanning 30 CDs consumes 1 write unit (while incrementing `daily_usage.write_count` accurately by row writes). Assigns monotonic `sync_seq` per accepted item, enforces Last-Write-Wins (`clientUpdatedAt`) conflict handling, returns `{ ok: true, accepted, conflicts, latestSeq, resetsAt }`. |
| `/api/share/<token>` *(extended)* | `GET` | Capability JWT | Optionally supports `?include=collection` or collection share scope so coding agents can read the user's owned releases + tracks (custom covers stripped, JSON or `?format=markdown`) before recommending new Hunt CDs. |
| `/api/collection/sheet-sync` | `POST` | Bearer JWT | Explicit sync-out action using existing `GOOGLE_SERVICE_ACCOUNT_JSON` to write tabular Owned Collection rows to a target Google Sheet URL (`#gid=` aware). |

### 4.4 Sync, Tombstone & Conflict Flow

```mermaid
sequenceDiagram
    autonumber
    participant Phone as Phone (Offline Scan)
    participant Laptop as Laptop (Signed In)
    participant Worker as Cloudflare Worker
    participant D1 as Cloudflare D1

    Note over Phone: User scans 10 CDs offline (dirty=1, clientUpdatedAt=T1)
    Laptop->>Worker: GET /api/collection?since=40&limit=200
    Worker->>D1: SELECT WHERE github_id=? AND sync_seq > 40
    D1-->>Worker: rows up to sync_seq=42
    Worker-->>Laptop: 200 items, nextCursor=42, hasMore=false
    Laptop->>Laptop: Commit IDB & lastSyncSeq=42

    Note over Phone: Phone comes online
    Phone->>Worker: POST /api/collection/batch (10 dirty items + 1 tombstone)
    Worker->>D1: Increment user_sync_state & UPSERT owned_releases (sync_seq 43..53)
    D1-->>Worker: Committed latestSeq=53
    Worker-->>Phone: 200 accepted=11, conflicts=[], latestSeq=53
    Phone->>Phone: Clear dirty=0; pull any missed seq if gap > batch

    Note over Laptop: Next sync pull on Laptop
    Laptop->>Worker: GET /api/collection?since=42&limit=200
    Worker->>D1: SELECT WHERE github_id=? AND sync_seq > 42
    D1-->>Worker: rows 43..53 (including deleted_at tombstone)
    Worker-->>Laptop: 200 items (upserts + tombstones), nextCursor=53
    Laptop->>Laptop: Apply upserts, remove tombstoned IDs, set lastSyncSeq=53
```

- **Simultaneous Offline Edit Conflicts:** Resolved predictably with **Last-Write-Wins** using `clientUpdatedAt` (returning stale items in `conflicts[]` with server state so no silent data loss goes unreported if two offline devices edit the exact same release ID).

---

## 5. JSON & Google Sheet Backing (Avoiding Split-Brain)

- **Source-of-Truth Rule:** **IndexedDB + Cloudflare D1** is always the authoritative live store for CRUD edits, fast camera scanning, and structured multi-disc tracks. JSON and Google Sheets act as explicit **sync-out / import-merge** layers rather than competing live masters.
- **Lossless JSON Snapshot (`owned-collection.json`):**
  - Validated against `schemas/collection.v1.schema.json`.
  - Exports/imports 100% of active owned releases including multi-disc `tracks[]`, `notes`, purchase metadata, and `customCovers`.
  - Supports **Merge** (match on `id`, then exact `(catNo, editionLabel)` or `barcode`) or **Replace** (marks removed items as tombstones locally + pushes cleanly).
- **Tabular Google Sheet Backing (`js/sheet-adapter.js` + Worker Service Account):**
  - **11 Canonical Owned Columns:** `Catalog Number | Edition | Category | Artist | Title | Barcode | Purchase Price | Purchase Shop | Purchase Date | Track Count | Notes`.
  - **Push to Sheet:** Exports a clean snapshot into the linked Owned Sheet / `Owned` tab via `GOOGLE_SERVICE_ACCOUNT_JSON` (mirroring structured data cleanly without stuffing multi-disc JSON into spreadsheet cells).
  - **Import / Merge from Sheet:** Fetches public CSV export and merges new rows or updated personal fields (`Purchase Price`, `Purchase Shop`, `Purchase Date`, `Notes`, `Barcode`) onto matching `catNo`/`barcode` records in IndexedDB **without overwriting structured `tracks[]` or `customCovers`**.

---

## 6. UI & Hunt ↔ Collection Workflows

### 6.1 Top-Level Navigation Switcher
- Add a clean mode switcher in the header (`Hunt` | `Collection`, plus `Scan` entry point introduced in Phase 3), keeping the existing Grid view, 1-Column view, and Crate Flip lightbox shared across modes.
- **Collection Mode Header:** Shows total counts (`N releases · M tracks`), category pills (auto-derived from `owned_releases[].category`), search across release + track titles, quick filters (`Has Tracks`, `Missing Tracks`, `Has Notes`), **+ Add Release** (MusicBrainz `catno:`/`barcode:` search, iTunes lookup, or manual form), and Backup / Google Sheet Sync drawer.

### 6.2 Owned → Hunt ("Already Owned & Track Overlap Guard")
While browsing **Hunt** mode, cards and Crate Flip cross-reference the in-memory Owned summary index automatically:
- **Exact Edition Owned Badge:** Matches `regCatNo` or `mbEditions[].catno` against `owned.catNo` (normalized `～`/`〜` → `~`) or `barcode`.
- **Other Edition Owned Badge:** Matches normalized `artist` + `title` (or `titleJa`) when the user owns a different pressing.
- **Track Overlap Badge (`Tracks Owned: X/Y`):** Uses Phase 1's `compareTrackLists` helper when both releases have tracks, distinguishing full vocal matches from `TV Size`/`Instrumental` variants and displaying inside Crate Flip *which* owned CD already contains each overlapping track.

### 6.3 Hunt → Owned ("Graduate Found Release")
- Checking off an item in Hunt mode offers a non-blocking action pill/button (**"Add to Collection →"**) — plus a batch **"Move Found to Collection"** helper.
- Pre-populates `catNo` (from chosen cover variant or `regCatNo`), `editionLabel`, `artist`/`artistJa`, `title`/`titleJa`, `category`, `barcode`, `tracks[]`, `trackSource`, and `customCovers`, with quick optional inputs for `purchasePrice`, `purchaseShop`, `purchaseDate`, and `notes`.

---

## 7. Verification & Acceptance Criteria

### 7.1 Automated Tests (`node --test test/*.test.js`)
- **Unit tests:**
  - `collection.v1.schema.json` validation + JSON import duplicate detection.
  - `js/db.js` IndexedDB CRUD, index lookups (`catNo`, `barcode`), tombstone handling, and dirty queue tracking.
  - `sync.js` incremental pull loop (`hasMore` pagination), batch splitting, and LWW conflict reconciliation.
  - Hunt ↔ Owned matching (exact `catNo`, other-edition title/artist, and variant-aware track overlap counts).
  - Owned 11-column Sheet CSV parser & non-destructive merge preserving local `tracks[]`.
- **Worker SQLite Integration Tests:**
  - `GET /api/collection?since=`, paginated `hasMore`, strict `github_id` tenant isolation.
  - `POST /api/collection/batch` atomic `sync_seq` assignment, tombstone writes, 1-write-per-batch hourly cap accounting, `PAUSE_SYNC` & daily circuit breaker `503`.
  - Collection share output on `/api/share/<token>` & Owned Sheet sync-out via mock Sheets API.
- **Full-Stack System Tests:**
  - Two simulated offline devices adding/editing/deleting owned releases and converging cleanly via Worker + SQLite.
  - Hunt → Owned graduation workflow and lossless JSON backup/restore round-trip.
- **Headless Chromium E2E (`scripts/e2e-browser.mjs`):**
  - Switch `Hunt` ↔ `Collection`, add/edit/soft-delete release, reload page and confirm IndexedDB persistence, verify Owned/Track-Overlap badge appears on matching Hunt card, test mobile `375x812` layout without horizontal overflow.

### 7.2 Live Docs to Update When Phase 2 Ships
- [`docs/CLOUD_SYNC_ARCHITECTURE.md`](../CLOUD_SYNC_ARCHITECTURE.md) & [`worker/README.md`](../../worker/README.md)
- [`docs/METADATA.md`](../METADATA.md) & new `schemas/collection.v1.schema.json`
- [`docs/AGENT_CATALOG_GUIDE.md`](../AGENT_CATALOG_GUIDE.md) & [`.agents/skills/disk-crate-catalog/SKILL.md`](../../.agents/skills/disk-crate-catalog/SKILL.md)
- [`docs/HANDOVER.md`](../HANDOVER.md) & [`README.md`](../../README.md)
