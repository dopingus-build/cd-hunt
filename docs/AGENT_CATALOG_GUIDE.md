# LLM & Agent Guide: Creating and Modifying CD Hunt Catalogs

This guide gives coding agents and LLMs exact, repeatable instructions for creating new catalog JSON files and adding or updating entries in existing catalogs (such as [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata)) for the **CD Hunt** web application (`https://dopingus-build.github.io/cd-hunt/`).

Read this alongside:
- [`docs/METADATA.md`](./METADATA.md) — Schema overview, loading modes, and cover-resolution pipeline
- [`schemas/catalog.v1.schema.json`](../schemas/catalog.v1.schema.json) — JSON Schema (Draft 2020-12) for `schemaVersion: 1`
- [`docs/sample-catalog.json`](./sample-catalog.json) — Minimal valid catalog template
- [`js/validate.js`](../js/validate.js) — Runtime validator enforced on every loaded catalog
- [`js/cover-resolver.js`](../js/cover-resolver.js) — Live cover lookup and jewel-case SVG fallback logic

---

## 1. Non-Negotiable Rules

Before editing any existing catalog or creating a new one, follow every rule below:

1. **Never rename, renumber, or reuse existing `item.id` values.**
   - Users' browser progress (collected checkmarks, personal notes, active filters, and cached album art) is saved in `localStorage` under a derived catalog prefix (`cd_hunt_<slug>_<hash>_`) keyed directly by `item.id`.
   - Renaming `cd-12` to `cd-13` breaks saved progress for every existing user of that catalog.
   - IDs must match `/^[a-zA-Z0-9_-]+$/` and be strictly unique within `items`.
   - When inserting an item next to an existing themed run, use a letter suffix (e.g., `cd-11b`) or append the next unused sequential ID (e.g., `cd-53`, `dig-03`).

2. **Include `schemaVersion: 1` (and `$schema` URI).**
   - Every catalog JSON file MUST include `"schemaVersion": 1`, and should include `"$schema"`:
     ```json
     "$schema": "https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json",
     "schemaVersion": 1
     ```
   - `js/validate.js` rejects missing, non-integer, or unsupported `schemaVersion` values. If `$schema` is present, it must be a non-empty string.

3. **Never add `meta.storagePrefix`.**
   - Both `schemas/catalog.v1.schema.json` (`meta.additionalProperties: false`) and `js/validate.js` explicitly reject `meta.storagePrefix`.
   - Storage isolation is handled automatically at runtime by `deriveStoragePrefix()` in `js/storage.js` from the catalog URL, local filename, or inline metadata so separate catalogs never collide.

4. **Verify Physical CD vs. `digitalOnly: true`.**
   - Never assume a track received a retail CD pressing. Confirm whether a physical single, EP, album, or OST CD exists.
   - For streaming/download-only tracks, set `"digitalOnly": true`, `"catalog": "Digital Only"`, `"regCatNo": "DIGITAL"`, `"price": "¥0 (Digital / No physical CD)"`, and `"mbEditions": []`.
   - For physical CDs, `"digitalOnly"` is optional (omit or set `"digitalOnly": false`).

5. **Match `item.category` to `categories[].key`.**
   - If the catalog defines a `categories` array, `"All"` MUST be present (usually first: `{ "key": "All", "label": "All Items", "dot": "#94a3b8" }`).
   - Every item's `category` must match one of the declared category `key`s (assign specific sub-category keys such as `"anime"` or `"game"`, not `"All"`).

6. **Zero prohibited / hotlinked cover domains.**
   - `js/validate.js` recursively scans every string field in the catalog and rejects any URL or reference containing:
     - `vgmdb.net`
     - `wikia.nocookie.net`
     - `fandom.com`
     - `cdjapan.co.jp`
   - Never hardcode external cover image URLs. The app resolves covers dynamically in the browser from MusicBrainz / Cover Art Archive (`mbEditions`) and the Apple iTunes Search API (`itunesQuery` + `requiredGroups`), with an instant SVG jewel-case fallback.

7. **Prioritize Regular Editions (`通常盤`).**
   - Used Regular Editions (`通常盤`) are the target for in-person bargain hunting in Japan (usually ¥110–¥1,200 vs. ¥3,000+ OOP limited boxes).
   - Put the Regular Edition **first** in `mbEditions`, include `"通常"` in its `label` (for example `"通常盤 Regular"`), and set `regCatNo` to its exact catalog number. `js/cover-resolver.js` checks `ed.label.includes('通常') || ed.catno === item.regCatNo` when prioritizing cover art.

8. **Respect `js/app.js` and SVG rendering formatting rules.**
   - Grid cards render `item.price.split('(')[0].trim()`. Always place the yen price range **before** the first `(` (e.g., `"¥500–¥1,100 (Reg)"`).
   - The SVG jewel-case fallback (`buildJewelCaseDataURI`) displays:
     - Top obi right-side reading: `item.kana.split('/')[0].trim()` — keep the part before `/` short (1–6 characters, e.g., `"ヤ / Y"` or `"ア / A"`).
     - Spine/obi catalog code: `(item.regCatNo || item.catalog || 'N/A').split(/[(/,]/)[0].trim()`.
     - Artist/title text sliced at **22 chars** (`artistJa || artist`) and **24 chars** (`titleJa || title`).

---

## 2. Schema Field Reference (`schemaVersion: 1`)

### Top-Level Structure

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `$schema` | Recommended (Optional) | `string` (non-empty if set) | `"https://dopingus-build.github.io/cd-hunt/schemas/catalog.v1.schema.json"` |
| `schemaVersion` | Yes | `integer` (`1`) | Must equal `1` |
| `meta` | Optional (Recommended) | `object` | Allowed keys only: `title`, `subtitle`, `documentTitle`, `searchPlaceholder`, `digitalSectionTitle`, `digitalSectionSubtitle`. **Do NOT include `storagePrefix`.** |
| `categories` | Optional | `array` | Each entry: `{ "key": "...", "label": "...", "dot": "#hex" }`. When non-empty, `"key": "All"` is required. |
| `items` | Yes | `array` | Array of item objects (at least 1 item). |

### Item Fields

#### Required Item Fields
- **`id`** (`string`): Unique identifier matching `/^[a-zA-Z0-9_-]+$/` (e.g., `"cd-01"`, `"cd-11b"`, `"dig-01"`).
- **`category`** (`string`): Must match one of `categories[].key`. Inspect the target catalog's `categories` array first (e.g., `"Anime Themes & Chara"`, `"Games & OSTs"`, `"J-Pop / Rock"`).
- **`artist`** (`string`): English / romanized artist name as commonly billed.
- **`title`** (`string`): Track/album title with English tie-in context in parentheses, e.g., `"\"slash\" (Gundam: The Witch from Mercury S2 OP)"`.
- **`catalog`** (`string`): Primary catalog number(s) + edition breakdown, e.g., `"SRCL-12539 (通常盤) / SRCL-12540~41 (期間) / SRCL-12536~38 (初回)"` or `"Digital Only"`.
- **`price`** (`string`): Required string (recommended non-empty yen range **before** the first `(`, e.g., `"¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)"` or `"¥0 (Digital / No physical CD)"`).
- **`kana`** (`string`): Japanese Gojūon row/reading + alphabetical divider, with a short token before `/` (e.g., `"ヤ / Y"`).
- **`filing`** (`string`): Concise, practical in-store shelf lookup guide for Book Off, Suruga-ya, Mandarake, and Disk Union (e.g., `"ヤ (yama) / Y / ガンダム (Gundam)"`).

#### Optional / Conditionally Required Item Fields
- **`digitalOnly`** (`boolean`): Optional boolean; set `true` for streaming/digital-only releases, omit or set `false` for physical CDs.
- **`artistJa`** (`string`): Japanese artist billing (kana/kanji), used in detail view and fallback SVG.
- **`titleJa`** (`string`): Japanese title + `『作品名』` tie-in label, used in detail view and fallback SVG.
- **`regCatNo`** (`string`): Exact single-disc Regular Edition catalog number (e.g., `"SRCL-12539"`, or `"DIGITAL"` for `digitalOnly: true`).
- **`mbEditions`** (`array` of `{ "catno": string, "label": string }`): MusicBrainz catalog lookup list. Put Regular (`通常盤`) first! Keep `mbEditions: []` when `digitalOnly: true`.
- **`itunesQuery`** (`string`): Clean iTunes search string (`Title Artist`). Keep free of parenthetical edition labels like `(Anime OP)` or `(通常盤)`.
- **`requiredGroups`** (`string[][]`): **REQUIRED by `js/validate.js` whenever `itunesQuery` is non-empty!** AND-of-ORs substring match array checked case-insensitively against iTunes `trackName + ' ' + collectionName + ' ' + artistName`.
- **`accent`** (`string`): Hex color for the jewel-case fallback obi & subtle UI accents (e.g., `"#e11d48"`).

---

## 3. Step-by-Step Research Playbook

Follow these six steps whenever researching a new entry from scratch (e.g., from a user prompt like *"Add Song X from Anime Y"*).

### Step 1: Confirm the Official Release & Format
1. Identify the exact official artist billing, Japanese title, English/romanized title, and tie-in (`OP`, `ED`, `Insert`, `Main Theme`, `OST`, `Character Song`).
2. Check whether the song actually received a standalone **CD single**, appears on an **album / mini-album**, appears only on an **OST**, or is **digital-only** (`digitalOnly: true`).
   - *Watch out for streaming-only singles!* Many recent anime/game insert songs and VTuber/indie tracks launch on Spotify/Apple Music without a single CD, or only gain a physical pressing months later on a full album.
3. Choose the matching `category` key from the catalog's `categories` list (e.g., `"anime"`, `"game"`, `"jpop"`, `"vocaloid"`).

### Step 2: Research Catalog Numbers & Editions (`regCatNo`, `catalog`, `mbEditions`)
1. Look up the physical release on MusicBrainz (via the API command below) and official label discographies.
2. Separate multi-edition singles/albums carefully:
   - **`通常盤` (Regular Edition):** Lowest cost used, standard jewel case, primary target. Put this **first** in `mbEditions` with `"通常"` in `label`, and set `regCatNo` to this exact catalog number.
   - **`期間生産限定盤` (Anime / Time-Limited Edition):** Often features anime key art on the cover; include it second in `mbEditions` as a fallback/alt cover for the cover carousel.
   - **`初回生産限定盤` (First Press Limited Edition):** Often comes in digipak/Blu-ray bundles; include after Regular/Anime editions.
3. Verify the **exact catalog string stored in MusicBrainz**:
   - Multi-disc limited sets often list a hyphen range externally (e.g., `SRCL-12537~8` or `SRCL-12537/8`), whereas MusicBrainz may index either `SRCL-12537~8`, `SRCL-12537`, or `SRCL-12537-8`. Always run the MusicBrainz `curl` check in Step 5 to verify the exact `catno` that returns hits!
4. Common Japanese record label prefixes (useful sanity check for authentic catalog numbers):
   - **Sony Music Labels:** `SRCL` (Sony Records), `VVCL` (SACRA MUSIC), `SECL` (SME Records), `AICL` (Sony Music Associated), `ESCL` (Epic), `KSCL` (Ki/oon)
   - **Bandai Namco Music Live / Lantis:** `LACM` (Singles), `LACA` (Albums/OSTs)
   - **Victor Entertainment / FlyingDog:** `VICL` / `VIZL`, `VTCL` / `VTZL`
   - **King Records:** `KICM` (Singles), `KICA` (Albums/Soundtracks)
   - **Aniplex:** `SVWC`
   - **Pony Canyon:** `PCCG` / `PCCA`
   - **TOHO animation RECORDS:** `THCS` (Singles), `THCA` (Albums)
   - **Capcom (Suleputer):** `CPCA`
   - **Universal Music Japan:** `TYCT` / `UPCH` / `UMCK`

### Step 3: Determine Japanese Store Shelf-Filing (`kana` & `filing`)
1. Compute the Japanese **Gojūon (五十音)** shelf row (`あ・か・さ・た・な・は・ま・や・ら・わ` / A-KA-SA-TA-NA-HA-MA-YA-RA-WA) based on reading:
   - Keep the prefix before `/` concise (`1–6` kana, e.g., `"やま / や行"`, `"あいみょん / あ行"`, `"のうねいむ / な行"`) so the SVG obi header stays legible.
2. Write practical, store-aware `filing` guidance covering where Japanese secondhand shops actually place the disc:
   - **Artist-credited J-Pop / Anisong OP & ED singles** (e.g., yama, LiSA, Aimer, YOASOBI):
     - *Book Off / Tsutaya:* Usually in **J-Pop Singles/Albums** OR **Anime** section under the **artist's Gojūon** (`や行` for yama). Mention both if stores split J-Pop artists with anime tie-ins.
     - *Suruga-ya / Mandarake:* Often cross-filed under **Anime Franchise (`『作品名』`)** OR **Artist (J-Pop/Anisong)**.
   - **Character Songs / Seiyuu / OSTs:**
     - *Book Off:* OSTs go under **Anime Soundtrack / Game Music** by **work title kana** (`す` for Suisei no Majo, `ふ` for Fairy gone); solo seiyuu releases go by **seiyuu family name** (`は` for Hanazawa).
     - *Mandarake / Suruga-ya:* Almost always filed by **Franchise / Work Title** first.
   - **Game Music / Doujin / Vocaloid:**
     - *Mandarake / Suruga-ya / Melonbooks / Disk Union:* Check **Game Music**, **Doujin/Vocaloid-P**, or **Electronic/Indie** racks; Disk Union often sorts English-script acts alphabetically (`K`, `Y`, `M`) alongside Gojūon dividers.

### Step 4: Estimate Used Retail Price Range (`price`)
1. Set a realistic Japanese secondhand price range in yen (`¥...–¥...`) reflecting typical Book Off / Suruga-ya / Mandarake regular-edition pricing:
   - Older/common regular J-Pop or anime CD singles: `¥250–¥600` or `¥500–¥900`
   - Recent popular anime OP/ED regular singles: `¥500–¥1,100`
   - Full studio albums & major 2CD OSTs: `¥900–¥2,200`
   - OOP niche anime/game OSTs or doujin pressings: `¥1,800–¥4,500+`
2. Always keep the yen range **before** the first `(` (e.g., `"¥500–¥1,100 (Reg) / ¥1,200–¥2,200 (Anime Ltd)"`), because compact album cards strip everything from `(` onward (`item.price.split('(')[0].trim()`).

### Step 5: Build & Live-Verify `mbEditions`, `itunesQuery`, and `requiredGroups`

`js/cover-resolver.js` resolves covers in two stages in the browser:
1. **Stage 1 — MusicBrainz + Cover Art Archive (`mbEditions`):**
   - Calls `https://musicbrainz.org/ws/2/release/?query=catno:{catno}&fmt=json&limit=4` for each entry in `mbEditions`.
   - Fetches `https://coverartarchive.org/release/{mbid}/front-500`.
2. **Stage 2 — Apple iTunes Search API (`itunesQuery` + `requiredGroups`):**
   - Calls `https://itunes.apple.com/search?term={itunesQuery}&country={jp|us}&entity={song|album}&limit=8`.
   - Accepts a result **only if** EVERY inner group in `requiredGroups` has at least one substring match (case-insensitive) inside `trackName + ' ' + collectionName + ' ' + artistName`.
   - Prefers results containing `通常盤` / `Regular` in `collectionName`, and falls back below `アニメ盤` / `初回` when not present.

**Always verify both APIs live with `curl` before finalizing an entry:**

```bash
# 1. Look up MusicBrainz release MBIDs by exact catalog number
CATNO="SRCL-12539"
MBID=$(curl -fsSL -A "cd-hunt-catalog-verifier/1.0 (https://github.com/dopingus-build/cd-hunt)" \
  "https://musicbrainz.org/ws/2/release/?query=catno:${CATNO}&fmt=json&limit=4" \
  | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const r of (d.releases || [])) {
      console.error(r.id, "|", r.title, "|", (r["artist-credit"] || []).map(a => a.name).join(", "));
    }
    if (d.releases?.[0]?.id) process.stdout.write(d.releases[0].id);
  ')

# 2. Confirm Cover Art Archive returns an HTTP 200 after redirects for front-500 (404 means no cover uploaded)
[ -n "$MBID" ] && curl -sS -o /dev/null -w "CAA status: %{http_code}\n" -L "https://coverartarchive.org/release/${MBID}/front-500"

# 3. Test Apple iTunes Search API (country=jp and country=us) + requiredGroups logic
QUERY=$(node -e 'console.log(encodeURIComponent("slash yama"))')
curl -fsSL "https://itunes.apple.com/search?term=${QUERY}&country=jp&entity=song&limit=8" \
  | node -e '
    const groups = [["slash"], ["yama"]];
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const r of (d.results || [])) {
      const hay = `${r.trackName || ""} ${r.collectionName || ""} ${r.artistName || ""}`.toLowerCase();
      const ok = groups.every(g => g.some(tok => hay.includes(tok.toLowerCase())));
      console.log(ok ? "MATCH" : "SKIP ", "|", r.artistName, "|", r.trackName, "|", r.collectionName);
    }
  '
```

> **Tip for `requiredGroups`:** Put kanji/kana and romanized/English variants inside the same inner array (`["機動戦士ガンダム", "Gundam", "水星の魔女"]`) OR match the clean bilingual song + artist tokens (`[["slash"], ["yama"]]`). Avoid overly strict full-album subtitles in `requiredGroups` because singles and albums use different `collectionName` suffixes on Apple Music.

### Step 6: Validate Before Committing
1. Run `validateCatalog()` from `js/validate.js` against your updated JSON file:
   ```bash
   node -e '
     const fs = require("fs");
     const { validateCatalog } = require("./js/validate.js");
     const catalog = JSON.parse(fs.readFileSync("/path/to/catalog.json", "utf8"));
     const res = validateCatalog(catalog);
     if (!res.valid) {
       console.error("INVALID:", res.errors);
       process.exit(1);
     }
     console.log("VALID:", catalog.items.length, "items");
   '
   ```
2. If you added a **new catalog file** in `cd-metadata/`:
   - Place the `.json` file at the **root** of `dopingus-build/cd-metadata` (keep the repo flat).
   - Register it in `cd-metadata/index.json` under `catalogs` (with `id`, `title`, `subtitle`, and `file`, plus optional `url`) so it appears automatically in the app's **Preset Catalogs** list and whenever someone pastes `https://github.com/<owner>/<repo>` into CD Hunt:
     ```json
     {
       "schemaVersion": 1,
       "catalogs": [
         {
           "id": "2026-japan",
           "title": "2026 Japan (Osaka) CD Hunt",
           "subtitle": "53 physical CDs + 2 digital-only releases",
           "file": "2026-japan.json"
         }
       ]
     }
     ```
3. Run the `cd-hunt` test suite (`node --test test/*.test.js`). Note that when `../cd-metadata` exists locally, `test/catalog-integration.test.js` automatically validates all metadata JSON files and `index.json`.

---

## 4. Annotated Walkthrough: Adding an Entry

**Prompt:** *"Add `'slash'` by `yama` (Gundam: The Witch from Mercury S2 OP) to `2026-japan.json`."*

### Step-by-Step Decisions
1. **Pick a safe `id`:** Inspect `2026-japan.json`'s existing items and categories first — never renumber existing IDs! Append the next unused sequential ID (in `2026-japan.json`, this live entry is `"id": "cd-39"`, `"category": "Anime Themes & Chara"`).
2. **Physical editions (`通常盤` first):**
   - Regular Edition (`通常盤`): `SRCL-12539` -> put in `regCatNo` and first in `mbEditions` (verified live on MusicBrainz -> CAA `front-500` HTTP `200`).
   - Anime Limited Edition (`期間生産限定`): `SRCL-12540~41` -> MusicBrainz indexes the primary disc catno `SRCL-12540` (CAA `front-500` HTTP `200`).
   - First Press Limited Edition (`初回盤`): `SRCL-12536~38` -> MusicBrainz indexes `SRCL-12536` (CAA `front-500` HTTP `404`, so having `SRCL-12539` and `SRCL-12540` ahead of it ensures instant cover fallback!).
3. **Gojūon & Filing:**
   - Keep `kana` concise before `/`: `"ヤ / Y"`.
   - Give clean store-divider clues in `filing`: `"ヤ (yama) / Y / ガンダム (Gundam)"`.
4. **Price:** Put the regular-edition used range first before `(`: `"¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)"`.
5. **Cover Verification:** `itunesQuery: "slash yama"`, `requiredGroups: [["slash"], ["yama"]]` — verified against iTunes `country=jp` (`yama | slash | slash - Single`).

### Resulting Validated Entry (`cd-39` in `2026-japan.json`)

```json
{
  "id": "cd-39",
  "category": "Anime Themes & Chara",
  "artist": "yama",
  "artistJa": "yama (ヤマ)",
  "title": "\"slash\" (Gundam: The Witch from Mercury S2 OP)",
  "titleJa": "slash (TVアニメ『機動戦士ガンダム 水星の魔女』Season2 OP)",
  "regCatNo": "SRCL-12539",
  "catalog": "SRCL-12539 (通常盤) / SRCL-12540~41 (期間) / SRCL-12536~38 (初回)",
  "mbEditions": [
    { "catno": "SRCL-12539", "label": "通常盤 Regular" },
    { "catno": "SRCL-12540", "label": "期間生産限定 Anime" },
    { "catno": "SRCL-12536", "label": "初回盤 Limited" }
  ],
  "kana": "ヤ / Y",
  "filing": "ヤ (yama) / Y / ガンダム (Gundam)",
  "price": "¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)",
  "itunesQuery": "slash yama",
  "requiredGroups": [
    ["slash"],
    ["yama"]
  ],
  "accent": "#3b82f6"
}
```
