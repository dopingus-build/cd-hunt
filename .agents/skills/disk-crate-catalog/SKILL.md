---
name: disk-crate-catalog
description: >-
  Use this skill whenever the user asks to research Japanese CDs/music releases,
  add or update rows in a Disk Crate (or legacy CD Hunt) Google Sheet or schemaVersion: 1 JSON catalog,
  check Japanese secondhand shop availability (Suruga-ya, Mandarake, Book Off,
  Lashinbang, Disk Union, Tower Records), or convert between Google Sheets and
  Disk Crate catalog JSON.
---

# Disk Crate Catalog & Sheet Curation Skill

Use [`docs/AGENT_CATALOG_GUIDE.md`](../../../docs/AGENT_CATALOG_GUIDE.md) as the single authoritative reference for both the **Canonical Google Sheet (`v1`)** format and **`schemaVersion: 1` JSON** catalogs.

## Core Workflows

### 1. Adding or Updating Rows in a Disk Crate Google Sheet
1. Enforce **strictly 1 release per row** across the 9 canonical columns:
   `Got it? | Aisle / Category | Artist / Franchise | Title / Release Details | Catalog Number | Filing Location & Shelf Search Advice | Target Used Price | Priority | Recommended Shops`
2. Refer to [`docs/sample-catalog-sheet.csv`](../../../docs/sample-catalog-sheet.csv) for exact formatting and summary KPI formulas.
3. Preserve existing rows verbatim—never overwrite `Got it?` unless explicitly instructed.
4. Check existing Catalog Numbers (Column E) and normalized Artist + Title (watch for single vs. album overlap) before inserting a new row so duplicates are not added.
5. Distinguish physical releases from digital-only tracks (`Aisle / Category = Digital-Only`, `Catalog Number = N/A (Digital Only)`, `Target Used Price = Digital Only`).
6. Put the **Regular Edition (`通常盤`)** catalog number first with `(通常盤 Regular)` or `(Reg CD)`, put the primary yen range before any `(`, and include concrete store recommendations (`Book Off`, `Suruga-ya`, `Mandarake`, `Lashinbang`, `Disk Union`, `Tower Records`) in `Recommended Shops`.

### 2. Editing or Adding Entries in `schemaVersion: 1` JSON (`cd-metadata`)
1. Read [`docs/AGENT_CATALOG_GUIDE.md`](../../../docs/AGENT_CATALOG_GUIDE.md) Part 2 & Part 3 plus [`schemas/catalog.v1.schema.json`](../../../schemas/catalog.v1.schema.json).
2. Never rename, renumber, or reuse existing `item.id` values; check existing `regCatNo`/`mbEditions`/titles before adding new entries to avoid duplicates; never add `meta.storagePrefix`.
3. Never include hotlinked URLs from `vgmdb.net`, `wikia.nocookie.net`, `fandom.com`, or `cdjapan.co.jp`.
4. Verify `mbEditions` against MusicBrainz / Cover Art Archive (`front-500`) and `itunesQuery` + `requiredGroups` against Apple iTunes Search API.
5. Validate JSON with `validateCatalog` in [`js/validate.js`](../../../js/validate.js) and run `node --test test/*.test.js` before committing.

### 3. Shop Availability & Stock Scouting
1. Filter targets to unacquired items (`Got it? = FALSE` or `!acquired`).
2. Search Japanese retailers (`suruga-ya.jp`, `order.mandarake.co.jp`, `shop.lashinbang.com`, `shopping.bookoff.co.jp`, `tower.jp`) by exact catalog numbers (`regCatNo` first, then alternate edition codes) and Japanese artist/title strings.
3. Report edition match (`通常盤` vs. `初回盤`), mail-order vs. physical branch availability, and current price vs. target used price.
