# Catalog Metadata Structure & Requirements

This document specifies the versioned schema, loading rules, and cover-resolution requirements for creating or customizing a CD/music hunt catalog for `index.html`.

---

## Loading Modes

`index.html` (via `js/app.js`) separates UI logic from catalog data and resolves the catalog in the following order:

1. **Custom JSON or Repository URL (`?catalog=<url>`):** Fetches and loads the JSON file or repository `index.json` from the URL query parameter. Standard GitHub `https://github.com/<owner>/<repo>/blob/<ref>/<path>` URLs are automatically converted to `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, and bare repository URLs (`https://github.com/<owner>/<repo>` or `/tree/<branch>`) resolve to that repository's `index.json` so its presets can be picked directly.
2. **Saved Catalog URL (`localStorage` key `cd_hunt_catalog_url_v1`):** If no `?catalog=` parameter is present, reloads the previously selected URL catalog automatically.
3. **Catalog Loader Screen:** On first visit (with no `?catalog=` or saved URL), displays the interactive Catalog Loader where users can:
   - Pick a dynamic preset fetched from [`dopingus-build/cd-metadata/index.json`](https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/index.json),
   - Paste any public metadata JSON URL or GitHub metadata repository URL (`https://github.com/<owner>/<repo>`, with a **Copy Share Link** button once a catalog is loaded to share `?catalog=<url>`), or
   - Load a local `.json` file directly from their device.

> **Note:** External catalog JSON files (such as `2026-japan.json` in `dopingus-build/cd-metadata` or [`docs/sample-catalog.json`](./sample-catalog.json)) conform to [`schemas/catalog.v1.schema.json`](../schemas/catalog.v1.schema.json) (`schemaVersion: 1`) and are validated at load time by `js/validate.js`.
>
> **For LLMs & Coding Agents:** See [`docs/AGENT_CATALOG_GUIDE.md`](./AGENT_CATALOG_GUIDE.md) for step-by-step instructions on researching catalog numbers, Gojūon shelf filing, used pricing, MusicBrainz/iTunes cover verification, and adding entries safely to existing catalogs.

---

## Top-Level Schema

```json
{
  "$schema": "https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json",
  "schemaVersion": 1,
  "meta": { },
  "categories": [ ],
  "items": [ ]
}
```

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | `string` | Optional (recommended) | URI pointing to [`https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json`](../schemas/catalog.v1.schema.json) for editor autocomplete & validation. |
| `schemaVersion` | `integer` | **Required** | Version marker for the catalog format. Must be `1`. |
| `meta` | `Object` | Optional (recommended) | App branding and UI labels. |
| `categories` | `Array<Object>` | Optional | Ordered list of filter pills shown in the header. Auto-derived from `items[].category` if omitted or empty. |
| `items` | `Array<Object>` | **Required** | Array of release objects (physical CDs and optional digital-only tracks). |

---

## 1. `meta` Object (Branding & Labels)

All `meta` fields are optional strings; if omitted, the HTML defaults apply. (`meta.storagePrefix` is disallowed — storage keys are always derived automatically to guarantee uniqueness.)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | `"CD Hunt"` | Main `<h1>` header title (`#brandTitle`). |
| `subtitle` | `string` | `"Cover Album & Crate Checklist (通常盤 Priority)"` | Subtitle displayed beneath the header title (`#brandSub`). |
| `documentTitle` | `string` | `"CD Hunt — Cover Album & Checklist"` | Browser tab `<title>`. |
| `searchPlaceholder` | `string` | HTML placeholder | Placeholder text for `#searchInput`. |
| `digitalSectionTitle` | `string` | `"Digital-Only Releases (Skip Physical Hunting)"` | Heading for `#digitalOnlySection`. |
| `digitalSectionSubtitle` | `string` | `"No physical CD exists in stores — excluded from the physical hunting counter."` | Subtitle for `#digitalOnlySection`. |

### `localStorage` Namespacing

`js/storage.js` (`deriveStoragePrefix`) automatically derives a unique, deterministic `<prefix>` (`cd_hunt_<slug>_<fnv1aHex>`) from the catalog's source URL, local file name, or title + item IDs so separate catalogs never collide:

- `<prefix>_checklist_v2` — Map of `{ [item.id]: boolean }` tracking acquired/saved items.
- `<prefix>_cover_cache_v6` — Map of `{ [item.id]: { variants, selectedIndex } }` storing resolved cover art variants.
- `<prefix>_view_mode_v1` — `'grid'` or `'single'`.
- `<prefix>_note_dismissed_v1` — `'1'` when the digital-only reminder banner is dismissed.

---

## 2. `categories` Array (Filter Pills)

Each element defines one category filter pill in the header (`#categoryPills`):

```json
{ "key": "Anime Themes & Chara", "label": "Anime Themes & Chara", "dot": "#f43f5e" }
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | **Required** | Must match `item.category` exactly. Use `"All"` for the catch-all pill. |
| `label` | `string` | **Required** | Visible pill label. |
| `dot` | `string` | **Required** | CSS color (e.g. `#f43f5e`) for the pill indicator dot. |

### Rules & Auto-Derivation
- If providing a custom `categories` array, **include `{ "key": "All", "label": "All Releases", "dot": "#a1a1aa" }` as the first entry** so users can return to all items.
- If `categories` is omitted or empty (`[]`), `deriveCategories(items)` automatically prepends the `"All"` pill and creates one pill per unique `item.category` in order of appearance, using `item.accent` (or a fallback palette) for `dot`.

---

## 3. `items` Array (Release Entries)

Each entry in `items` represents one release card:

| Field | Type | Required | Used In | Notes & Constraints |
| --- | --- | --- | --- | --- |
| `id` | `string` | **Required** | State, DOM IDs, cache, checklist | Must be **unique** and URL/DOM-safe (e.g. `"cd-01"`, `"dig-01"`). Never reuse IDs across different releases. |
| `category` | `string` | **Required** | Category filter pills, lightbox badge | Must match one of `categories[].key` (unless `categories` is auto-derived). |
| `digitalOnly` | `boolean` | Optional (`false`) | Physical counter, Digital-Only section | Set `true` for digital-only tracks so they are excluded from the physical shelf-hunting counter (`0 / N`) and grouped under `#digitalOnlySection`. |
| `artist` | `string` | **Required** | Card artist label, search, SVG fallback, digital banner | Primary/English/Romaji artist name. |
| `artistJa` | `string` | Optional (`""`) | 1-Col view, lightbox, search, SVG fallback | Japanese artist name and/or kana reading. |
| `title` | `string` | **Required** | Card title, search, SVG fallback, iTunes search link | Release title (in the digital banner, text before the first `(` is displayed). |
| `titleJa` | `string` | Optional (`""`) | 1-Col view, lightbox, search, SVG fallback | Japanese title / tie-in description. |
| `regCatNo` | `string` | Recommended | Compact grid footer, copy button, SVG spine, MusicBrainz priority | Standard/Regular Edition (`通常盤`) catalog number (e.g. `"CPCA-1004"`, `"DIGITAL-ONLY"`). |
| `catalog` | `string` | **Required** | 1-Col & lightbox catalog chip, search, SVG fallback | Full catalog number(s) and edition notes (e.g. `"SRCL-8093 (通常盤) / SRCL-8091~2 (初回限定)"`). |
| `mbEditions` | `Array<{ catno, label }>` | Recommended (`[]`) | Stage 1 cover lookup (MusicBrainz + Cover Art Archive) | Ordered list of editions to query by catalog number. Put `通常盤` / regular edition first. Use `[]` for digital-only items. |
| `kana` | `string` | **Required** | Top-left card badge, search, SVG obi header | Filing kana/initial badge (e.g. `"エ / E"`, `"配信限定"`). First segment before `/` is printed at the top of the SVG obi strip. |
| `filing` | `string` | **Required** | 1-Col & lightbox shelf guide (`どこで探す`), search | Where to find the CD in physical stores (shelf/kana/anime section) or skip instructions. |
| `price` | `string` | **Required** | Grid & 1-Col price badge, lightbox, SVG footer | Expected used-CD price range (e.g. `"¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)"` or `"Digital Only"`). Must be a string (use `""` if unknown); grid cards display the portion before the first `(`. |
| `itunesQuery` | `string` | Optional | Stage 2 cover lookup (Apple iTunes Search API) | Clean search terms for iTunes (`country=jp` then `country=us`). Keep concise (title + artist); omit edition clutter. |
| `requiredGroups` | `Array<Array<string>>` | Required if `itunesQuery` is set | Stage 2 cover verification | **AND-of-ORs** keyword filter preventing false-positive cover matches. See Section 4. |
| `accent` | `string` | Optional (`"#e11d48"`) | Offline SVG jewel-case obi & glow | Hex color for the generated placeholder cover art. |

---

## 4. Cover Art Resolution & Verification Rules

### Offline Instant Fallback (`buildJewelCaseDataURI`)
All cards render immediately using an offline SVG jewel-case + Japanese obi strip generated from:
- `accent` (obi strip background and disc ring tint)
- `kana` (first segment before `/`, obi top label)
- `regCatNo || catalog` (first segment before `(`, `/`, or `,`, obi spine & top-left chip)
- `artistJa || artist` (truncated to 22 chars)
- `titleJa || title` (truncated to 24 chars)
- `price` (bottom line)
- `digitalOnly` (`配信限定` if `true`, `通常盤` if `false`)

### Stage 1: MusicBrainz + Cover Art Archive (`mbEditions`)
- Queries `https://musicbrainz.org/ws/2/release/?query=catno:{catno}&fmt=json&limit=4` for each entry in `mbEditions` in order, then validates `https://coverartarchive.org/release/{mbid}/front-500` via an image load check (`naturalWidth > 40 && naturalHeight > 40`).
- Editions are marked `isRegular: true` when `label` includes `"通常"` or `catno === item.regCatNo`.
- **Convention:** Always list the `通常盤 Regular` edition first in `mbEditions` so standard jackets appear before limited/anime variants.

### Stage 2: Apple iTunes Search API (`itunesQuery` + `requiredGroups`)
- Queries `itunes.apple.com/search` (`country=jp`, then `country=us`; `entity=album`, or `['song', 'album']` when `digitalOnly: true`) and upgrades `100x100bb` artwork to `600x600bb`.
- **`requiredGroups` matching logic (AND of ORs):**
  - Outer array = **AND** (every inner group must match).
  - Inner array = **OR** (at least one keyword in the group must appear as a case-insensitive substring in `trackName + " " + collectionName + " " + artistName`).
  - Example: `[['fantôme', 'fantome'], ['宇多田ヒカル', 'hikaru utada']]` requires `(fantôme OR fantome) AND (宇多田ヒカル OR hikaru utada)`.
  - Avoid omitting `requiredGroups` when `itunesQuery` is set, otherwise unrelated albums may pass validation.
- **Edition scoring (`classifyItunesEdition`):** `通常盤 Regular` (120 / 100) outranks `アニメ盤 Anime` (50) and `初回盤 Limited` (40), with `+10` bonus for `country=jp`.

### Prohibited External URLs
- Do **not** hardcode hotlinked image URLs from VGMdb, Wikia/Fandom, or CDJapan inside metadata JSON files (they block hotlinking or serve wrong promo art). Users can still manually add custom cover URLs at runtime via **Crate Flip → + Add Cover Variant**, which saves to `localStorage`.

---

## 5. Digital-Only Releases Behavior

- Entries with `digitalOnly: true` are **excluded** from the header physical progress counter (`0 / N`).
- They render in a separate `#digitalOnlySection` below the main grid with sky-blue styling (`配信限定`) and `"Saved / Streamed"` toggle wording.
- `#digitalNoteBanner` automatically lists all `digitalOnly` items; if a catalog has **0** `digitalOnly` items, both `#digitalNoteBanner` and `#digitalOnlySection` are hidden automatically.

---

## 6. Templates

### Minimal Catalog JSON Template (`docs/sample-catalog.json`)

See [`sample-catalog.json`](./sample-catalog.json) for a ready-to-use JSON file, or use this structure:

```json
{
  "$schema": "https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json",
  "schemaVersion": 1,
  "meta": {
    "title": "Tokyo Vinyl & CD Hunt",
    "subtitle": "Disk Union & Recofan Checklist",
    "documentTitle": "Tokyo Hunt Checklist",
    "searchPlaceholder": "Search artist, title, or catalog #..."
  },
  "items": [
    {
      "id": "item-01",
      "category": "J-Rock",
      "artist": "Artist Name",
      "artistJa": "アーティスト名",
      "title": "Album Title",
      "titleJa": "アルバム名",
      "regCatNo": "ABCD-1234",
      "catalog": "ABCD-1234 (通常盤)",
      "mbEditions": [
        { "catno": "ABCD-1234", "label": "通常盤 Regular" }
      ],
      "kana": "ア / A",
      "filing": "ア (Artist) — J-Rock aisle",
      "price": "¥500–¥1,000",
      "itunesQuery": "Album Title Artist Name",
      "requiredGroups": [["album"], ["artist"]],
      "accent": "#e11d48"
    },
    {
      "id": "dig-01",
      "digitalOnly": true,
      "category": "Digital-Only",
      "artist": "Digital Artist",
      "artistJa": "デジタルアーティスト",
      "title": "\"Single Name\" (Digital-Only Release)",
      "titleJa": "シングル名 (配信限定)",
      "regCatNo": "DIGITAL-ONLY",
      "catalog": "DIGITAL-ONLY (No CD)",
      "mbEditions": [],
      "kana": "配信限定",
      "filing": "No physical CD exists — skip shelf hunting.",
      "price": "Digital Only",
      "itunesQuery": "Single Name Digital Artist",
      "requiredGroups": [["single"], ["digital artist"]],
      "accent": "#0ea5e9"
    }
  ]
}
```
