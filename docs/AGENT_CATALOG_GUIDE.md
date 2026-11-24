# Agent & LLM Guide: Creating and Maintaining Disk Crate Lists

This is the **single self-contained reference file** for using any AI assistant or coding agent to research Japanese CDs, maintain a **Canonical Google Sheet**, edit **`schemaVersion: 1` JSON** catalogs (such as [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata)), and check secondhand store availability in Japan.

- **Single Canonical URL to Give an Agent:**
  `https://raw.githubusercontent.com/dopingus-build/disk-crate/main/docs/AGENT_CATALOG_GUIDE.md`

> **Architecture Context:** Your **Google Sheet** works both as a standalone zero-JSON catalog (`Google-Sheet-Only` mode: paste the Sheet URL straight into `disk-crate` / Disk Crate, cached locally for offline basements, or import a local `.csv`) and as a live overlay (`meta.googleSheetUrl`) paired with a durable JSON snapshot in `cd-metadata`. **Disk Crate** (`https://dopingus-build.github.io/disk-crate/`, formerly `cd-hunt`) + GitHub-authenticated Cloudflare D1 remain the authoritative store for your trip checklist (`Got it?`).

### Giving AI / LLM Agents Live Read Access Without GitHub Credentials

Because external AI assistants cannot sign in with your GitHub account, Disk Crate mints a **semi-private, read-only capability link** whenever you sign in:
1. Click **Sign in** in Disk Crate's top bar, then click **Agent Link** to copy your personal read-only status URL (`https://cd-hunt-sync.tndo.workers.dev/api/share/<token>?format=markdown`, or omit `?format=markdown` for JSON).
2. Paste that URL to your AI assistant alongside your Google Sheet or catalog URL so it can immediately inspect which CDs are already acquired (`Got it? = TRUE`) vs. still hunting.
3. **What is exposed:** Only non-sensitive public CD catalog IDs, checklists, view mode, and your public GitHub username (`login`). Zero GitHub access tokens, emails, or private repo data ever touch D1 or `/api/share/<token>`.
4. **Two-Way Google Sheet Sync (Service Account):** `GOOGLE_SERVICE_ACCOUNT_JSON` is live on the Worker (`cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com`, also surfaced inside **Catalog → Copy Bot Email** and at `https://cd-hunt-sync.tndo.workers.dev/api/status`). Share your Google Sheet with `cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com` as **Editor**, and toggling `Got it?` in Disk Crate will automatically write `TRUE`/`FALSE` back to Column A (including multi-tab sheets with `#gid=`).

---

## Quick-Start: Setting Up a Reusable Custom Assistant (Custom Instructions / Project / Gem / GPT)

In any AI web or mobile app that supports reusable custom instructions (Custom Instructions, Projects, Gems, or Custom GPTs), you can configure a dedicated curator assistant once and reuse it across any trip list or Google Sheet:

### Setup Steps
1. Create a new custom assistant/project named `Disk Crate Curator & Shop Scout`.
2. **Knowledge (Optional):** Upload or link your working Google Sheet and/or this raw guide file (`AGENT_CATALOG_GUIDE.md`).
3. **Instructions (Paste the block below verbatim):**

```text
You are Disk Crate Curator & Shop Scout, an expert assistant for researching physical Japanese CD releases and secondhand store availability across Japan (Osaka Nipponbashi/Namba/Umeda, Akihabara, Nakano, Shinjuku, Shibuya) using the Disk Crate canonical schemas.

When working with the user's Google Sheet:
1. ALWAYS keep strictly ONE CD release per row (never combine multiple singles or albums into a comma-separated bundle row).
2. Always match the 9 canonical columns in exact order:
   Got it? | Aisle / Category | Artist / Franchise | Title / Release Details | Catalog Number | Filing Location & Shelf Search Advice | Target Used Price | Priority | Recommended Shops
3. Preserve existing rows verbatim—especially the value of "Got it?", existing Artist/Title wording, and Catalog Numbers—unless the user explicitly asks to update them.
4. Distinguish physical CDs vs. digital-only tracks:
   - Never assume a track has a CD pressing. Verify whether a standalone CD single, album/mini-album, or OST exists.
   - Put streaming/download-only tracks under Aisle / Category = "Digital-Only", Catalog Number = "N/A (Digital Only)", Target Used Price = "Digital Only", Recommended Shops = "Digital Storefronts (iTunes JP / Mora)".
5. Prioritize Regular Editions (通常盤): list the standard regular catalog number first with "(通常盤 Regular)" or "(Reg CD)", followed by Anime/Limited editions.
6. Format "Filing Location & Shelf Search Advice" starting with clear Gojuon kana cues (e.g. "Look under ヤ (Ya, for yama), Y, or Gundam (ガンダム)") so shelf dividers are easy to find in stores.
7. Format "Target Used Price" with the yen range FIRST before any parentheses (e.g. "¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)").
8. Set "Priority" to High, Medium, or Low, and fill "Recommended Shops" with the best concrete Japanese chains/stores for that release (e.g., Book Off, Suruga-ya, Mandarake Grandchaos, Lashinbang, Disk Union, Tower Records, Animate, GAMERS).
9. Never add duplicate releases: before inserting a new row, check existing Catalog Numbers (Column E) and normalized Artist + Title (watch for singles that also appear on albums you already listed).
10. Never cite or recommend direct image links from vgmdb.net, wikia.nocookie.net, fandom.com, or cdjapan.co.jp.

When checking shop availability (Suruga-ya, Mandarake, Lashinbang, Book Off, Tower Records):
- Filter to entries where "Got it?" is FALSE (unless the user asks otherwise).
- Search using exact catalog numbers (especially Regular Edition catno first) plus Japanese artist/title strings.
- Clearly distinguish in-stock mail-order vs. in-store/branch pickup, edition (通常盤 vs. 初回盤), and current price vs. target used price.
```

---

## Part 1: Canonical Google Sheet Schema (`v1`)

All Disk Crate Google Sheets follow a single **9-column, 1-release-per-row** schema so humans, AI assistants, and `disk-crate` importers parse every sheet deterministically. See [`docs/sample-catalog-sheet.csv`](./sample-catalog-sheet.csv) for a ready-to-import template (`File -> Import` in Google Sheets).

### Non-Negotiable Sheet Rules
1. **Strictly 1 Release Per Row:** Never group multiple singles or mini-albums into a single row. Each release gets its own row so it maps 1-to-1 to a cover card and `Got it?` checkbox.
2. **Never delete or renumber existing rows lightly:** Downstream sync identifies releases by primary catalog number (first `ABC-1234` token in Column E) or normalized artist + title for digital tracks. Keep catalog numbers accurate and stable.
3. **Avoid Duplicate Releases:** Always check existing Catalog Numbers (Column E) and normalized Artist + Title (including checking single vs. album overlap) before inserting a new row. (`disk-crate` automatically deduplicates matching catalog numbers/titles on load and shows a non-blocking warning toast; in Google Sheets you can also apply conditional formatting with `=COUNTIF($E$8:$E$500, E8)>1` on Column E to highlight duplicate catalog codes red.)
4. **Never embed hotlinked image URLs from `vgmdb.net`, `wikia.nocookie.net`, `fandom.com`, or `cdjapan.co.jp`.**

### Canonical Columns (A–I Required)

| Col | Canonical Header | Format & Convention | Example |
| --- | --- | --- | --- |
| **A** | `Got it?` | Spreadsheet boolean checkbox (`TRUE` / `FALSE`). Defaults to `FALSE` on new rows. | `FALSE` |
| **B** | `Aisle / Category` | Aisle/genre pill label. Use `Digital-Only` for non-physical tracks. | `Anime Themes & Character Songs` |
| **C** | `Artist / Franchise` | `English Name (日本語名)` when bilingual, or canonical billing. | `Capcom (カプコン)` or `yama` |
| **D** | `Title / Release Details` | `"Title" (Romaji / Tie-in & Notes)` (concise release/tie-in subtitle). | `"slash" (Gundam: The Witch from Mercury S2 OP)` |
| **E** | `Catalog Number` | Put Regular Edition (`通常盤` / `Reg CD`) **first** (`CODE (通常盤 Regular) / CODE2 (初回盤 Ltd)`), or `N/A (Digital Only)`. | `SRCL-12539 (通常盤 Regular) / SRCL-12540~41 (期間生産限定)` |
| **F** | `Filing Location & Shelf Search Advice` | Start with `"Look under <カナ> (<Romaji>), <Alpha>, or <Franchise>"` covering Book Off, Suruga-ya, Mandarake, Disk Union. | `Look under ヤ (Ya, for yama), Y, or Gundam (ガンダム)` |
| **G** | `Target Used Price` | Yen range **before** any `(` (`¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)`), or `Digital Only`. | `¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)` |
| **H** | `Priority` | `High`, `Medium`, or `Low` (hunting urgency / rarity / buy-on-sight flag). | `High` |
| **I** | `Recommended Shops` | Comma-separated chains/stores best suited for this release. | `Book Off, Suruga-ya (Anime/J-Pop aisle), Lashinbang` |

*(Optional columns J+ if desired: `ID`, `Kana`, `iTunes Query`, `Cover URL` — omitted by default since `disk-crate` derives them automatically from Columns A–I.)*

### Supported Sheet Layouts
1. **Dashboard Layout** (recommended, shown in [`docs/sample-catalog-sheet.csv`](./sample-catalog-sheet.csv)):
   - Rows 1–2: Checklist Title & Subtitle.
   - Rows 3–5: KPI formulas (`TOTAL PHYSICAL TARGETS`, `ACQUIRED / BOUGHT`, `STILL HUNTING`, `PROGRESS`) and Digital-Only notice.
   - Row 7: 9-column header (`Got it?,Aisle / Category,...,Recommended Shops`).
   - Bottom section (optional): `Digital-Only Releases (Skip Physical Hunting)` banner row, repeated 9-column header, then `Digital-Only` rows (`digitalOnly: true`).
2. **Flat Table Layout** (produced by LLM *"Export to Sheets"* flows):
   - Row 1: 9-column header directly, followed by rows in Columns A–I (`Aisle / Category = "Digital-Only"` marks non-physical rows).

### 1-Click Template Copy + Auto-Invite URL (For Collaborators & Forkers)
When sharing a public template Google Sheet (for example, one imported from [`docs/sample-catalog-sheet.csv`](./sample-catalog-sheet.csv)), you can replace `/edit` with `/copy?title=...&userstoinvite=...` so clicking the link prompts the user to copy the template into their own Google Drive **and automatically invites the sync Service Account bot email** on confirmation:

```text
https://docs.google.com/spreadsheets/d/<TEMPLATE_SHEET_ID>/copy?title=My+Disk+Crate+Checklist&userstoinvite=cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com
```

*(Note: Google requires `/copy` links for `userstoinvite`; for already-existing sheets, use **Catalog -> Copy Bot Email** in Disk Crate or `GET /api/status` and add the bot as **Editor** under **Share**.)*

---

## Part 2: Canonical JSON Catalog Schema (`schemaVersion: 1`)

Static catalogs in `cd-metadata` (and imported/cached JSON files) conform to [`schemas/catalog.v1.schema.json`](../schemas/catalog.v1.schema.json) and are validated at runtime by [`js/validate.js`](../js/validate.js).

### Non-Negotiable JSON Rules
1. **Never rename, renumber, or reuse existing `item.id` values.**
   - Browser `localStorage` and D1 cloud sync key checkmarks and custom covers directly by `item.id`. Match `/^[a-zA-Z0-9_-]+$/`, append the next unused sequential ID (`cd-53`, `dig-03`) or a suffix (`cd-11b`), and ensure strict uniqueness.
2. **Include `schemaVersion: 1` (and `$schema` URI):**
   ```json
   "$schema": "https://dopingus-build.github.io/disk-crate/schemas/catalog.v1.schema.json",
   "schemaVersion": 1
   ```
3. **Never add `meta.storagePrefix`.**
   - Storage isolation is computed automatically by [`js/storage.js`](../js/storage.js) (`deriveStoragePrefix`). Allowed `meta` keys only: `title`, `subtitle`, `documentTitle`, `searchPlaceholder`, `digitalSectionTitle`, `digitalSectionSubtitle`, `googleSheetUrl`.
4. **Match `item.category` to `categories[].key`.**
   - When `categories` is non-empty, `"All"` MUST be present (e.g. `{ "key": "All", "label": "All Releases", "dot": "#a1a1aa" }`) and every item's `category` must match one declared `key`.
5. **No prohibited domains anywhere in any JSON string:**
   - Reject list: `vgmdb.net`, `wikia.nocookie.net`, `fandom.com`, `cdjapan.co.jp`. Cover art is resolved dynamically from MusicBrainz/Cover Art Archive and Apple iTunes Search API.
6. **Prioritize Regular Editions (`通常盤`) and keep UI string conventions clean:**
   - Put the Regular Edition **first** in `mbEditions` with `"通常"` in its `label`, and set `regCatNo` to that exact catalog number.
   - `price`: Keep the primary yen range **before** the first `(` (cards display `item.price.split('(')[0].trim()`).
   - `kana`: Keep the segment before `/` concise (`1–6` characters, e.g., `"ヤ / Y"`) for the fallback SVG obi header; `buildJewelCaseDataURI` slices artist/title at 22 / 24 characters.

### Field Reference (`schemaVersion: 1`)

#### Required Item Fields
- **`id`** (`string`): Unique `/^[a-zA-Z0-9_-]+$/` identifier (`"cd-01"`, `"dig-01"`).
- **`category`** (`string`): Category matching `categories[].key`.
- **`artist`** (`string`): Primary/English artist billing.
- **`title`** (`string`): Track/album title with concise tie-in context.
- **`catalog`** (`string`): Human-readable edition/catalog summary (`"SRCL-12539 (通常盤) / SRCL-12540~41 (期間)"` or `"Digital Only"`).
- **`price`** (`string`): Yen price range before `(` (e.g. `"¥300–¥700 (Reg) / ¥800–¥1,400 (Ltd)"`).
- **`kana`** (`string`): Concise shelf reading prefix before `/` (e.g. `"ヤ / Y"`).
- **`filing`** (`string`): In-store shelf search guide across Japanese secondhand shops.

#### Optional / Conditionally Required Item Fields
- **`digitalOnly`** (`boolean`): Set `true` for streaming/download-only tracks (`mbEditions: []`, `regCatNo: "DIGITAL"`).
- **`artistJa`** (`string`): Japanese artist billing (kana/kanji).
- **`titleJa`** (`string`): Japanese title + `『作品名』` tie-in.
- **`regCatNo`** (`string`): Exact Regular Edition catalog number (e.g. `"SRCL-12539"`).
- **`mbEditions`** (`Array<{ catno: string, label?: string }>`): MusicBrainz catalog lookup order (Regular first).
- **`itunesQuery`** (`string`): Clean query (`Title Artist`) free of `(Anime OP)` / `(通常盤)` tags.
- **`requiredGroups`** (`string[][]`): **REQUIRED whenever `itunesQuery` is non-empty.** AND-of-ORs case-insensitive token groups checked against `trackName + ' ' + collectionName + ' ' + artistName`.
- **`priority`** (`string`): Hunting urgency (e.g., `"High"`, `"Medium"`, `"Low"`).
- **`recommendedShops`** (`string`): Best shops to check for this release (e.g., `"Book Off, Suruga-ya, Lashinbang"`).
- **`accent`** (`string`): Hex accent color for SVG obi fallback (`"#3b82f6"`).

### Repository Index Format (`index.json`)
Place catalogs flat at repository root (`dopingus-build/cd-metadata` or `<your-login>/cd-metadata`) and register presets in `index.json`:

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

---

## Part 3: Step-by-Step Research Playbook & Shop Scouting

Follow these steps whenever researching new entries (for either Google Sheets or JSON):

### Step 1: Confirm Official Release & Format
1. Confirm exact artist billing, Japanese title, English/romanized title, and tie-in (`OP`, `ED`, `Insert`, `Main Theme`, `OST`, `Character Song`).
2. Confirm whether the track actually has a standalone **CD single**, lives on an **album/EP/OST**, or is strictly **digital-only**. (Never conflate digital singles with physical pressings.)

### Step 2: Research Catalog Numbers & Editions (`regCatNo`, `mbEditions`)
1. Look up the physical pressing on MusicBrainz and official label discographies.
2. Put **`通常盤` (Regular Edition)** first (`"通常盤 Regular"`), followed by `期間生産限定盤` (Anime Edition) and `初回生産限定盤` (First Press Limited).
3. Sanity-check label prefixes (`SRCL` Sony Records, `VVCL` SACRA MUSIC, `SECL` SME, `AICL` Sony Associated, `ESCL` Epic, `KSCL` Ki/oon, `LACM`/`LACA` Lantis, `VICL`/`VTCL` Victor/FlyingDog, `KICM`/`KICA` King Records, `SVWC` Aniplex, `PCCG`/`PCCA` Pony Canyon, `THCS`/`THCA` TOHO animation, `CPCA` Capcom, `TYCT`/`UPCH`/`UMCK` Universal).
4. Note whether MusicBrainz indexes multi-disc sets as `CAT-1~2`, `CAT-1`, or `CAT-1-2` when running Step 6 verification.

### Step 3: Gojūon Shelf-Filing & Used Price Ranges
1. Determine Japanese **Gojūon (`あ・か・さ・た・な・は・ま・や・ら・わ`)** filing row:
   - Keep `kana` before `/` short (`"ヤ / Y"`, `"ア / A"`, `"ノ / No"`).
   - **J-Pop / Anisong artists** (*yama*, *LiSA*, *EGOIST*, *ChouCho*): Book Off files by artist Gojūon under J-Pop or Anime; Suruga-ya / Mandarake also cross-file under Anime Franchise (`『作品名』`).
   - **OSTs / Character Songs:** Book Off & Mandarake usually file under Anime Soundtrack / Game Music by **work title kana**.
   - **Indie / Game / Doujin / Vocaloid-P:** Check Mandarake, Suruga-ya, Melonbooks, and Disk Union (Disk Union often files Latin names alphabetically alongside Gojūon dividers).
2. Set realistic secondhand yen ranges (`¥250–¥600` common singles, `¥500–¥1,100` recent popular anime OP/EDs, `¥900–¥2,200` albums/2CD OSTs, `¥1,800–¥4,500+` OOP retro game OSTs/indie CDs).

### Step 4: Set `Priority` & `Recommended Shops`
Use this guide when filling Priority & Recommended Shops (helpful both in stores and for AI stock checks):

| Release Profile | Typical `Priority` | Typical `Recommended Shops` |
| --- | --- | --- |
| Rare / OOP 1990s–2000s Game OSTs, venue-only CDs, small-run indies | `High` (buy on sight) | `Mandarake (Grandchaos / Complex), Suruga-ya (Game OST / Doujin floor), Disk Union` |
| Current/recent Anime OP/ED & Character singles (`通常盤` easy/cheap to find) | `Medium` (or `High` if trip centerpiece) | `Book Off (¥250–¥500 bins), Suruga-ya Anime aisle, Lashinbang, Tower Records / Animate (if new)` |
| Major J-Pop / J-Rock studio albums & common singles | `Medium` / `Low` | `Book Off, Disk Union (J-Rock/Indie), Suruga-ya` |
| Digital-only singles | `Low` | `Digital Storefronts (iTunes JP / Mora / OTOTOY)` |

### Step 5: Store Stock & Price Scouting Prompts (Web / Search)
When checking shop availability before or during a trip:
- **Search Targets:** `suruga-ya.jp` (supports exact catno search and store stock filters such as Nipponbashi / Akihabara), `order.mandarake.co.jp` (filter by shop location like Grandchaos), `shop.lashinbang.com`, `shopping.bookoff.co.jp`, and `tower.jp` (new/back-catalog retail availability).
- Always query **both** the Regular Edition `regCatNo` and the Limited/Anime edition catalog numbers so you see price differences before walking into a store.

### Step 6: Live API & JSON Schema Verification (For Git Commits)
When updating a JSON catalog file directly (CLI/agent workflow), verify covers and validation before committing:

```bash
# 1. Verify MusicBrainz release MBID + Cover Art Archive front-500 status
CATNO="SRCL-12539"
MBID=$(curl -fsSL -A "disk-crate-catalog-verifier/1.0 (https://github.com/dopingus-build/disk-crate)" \
  "https://musicbrainz.org/ws/2/release/?query=catno:${CATNO}&fmt=json&limit=4" \
  | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const r of (d.releases || [])) {
      console.error(r.id, "|", r.title, "|", (r["artist-credit"] || []).map(a => a.name).join(", "));
    }
    if (d.releases?.[0]?.id) process.stdout.write(d.releases[0].id);
  ')
[ -n "$MBID" ] && curl -sS -o /dev/null -w "CAA status: %{http_code}\n" -L "https://coverartarchive.org/release/${MBID}/front-500"

# 2. Verify Apple iTunes Search API + requiredGroups logic
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

# 3. Validate JSON catalog against js/validate.js and run full test suite
node -e '
  const fs = require("fs");
  const { validateCatalog } = require("./js/validate.js");
  const catalog = JSON.parse(fs.readFileSync("/path/to/catalog.json", "utf8"));
  const res = validateCatalog(catalog);
  if (!res.valid) { console.error("INVALID:", res.errors); process.exit(1); }
  console.log("VALID:", catalog.items.length, "items");
'
node --test test/*.test.js
```

### Annotated JSON Example (`cd-39` with `priority` & `recommendedShops`)

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
  "accent": "#3b82f6",
  "priority": "High",
  "recommendedShops": "Book Off, Suruga-ya (Anime/J-Pop aisle), Lashinbang"
}
```
