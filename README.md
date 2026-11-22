# CD Hunt — Cover Album & Checklist (`cd-hunt`)

A mobile-first, zero-dependency web application for hunting physical CDs/music releases across stores and tracking crate checklists, hosted as a static site on GitHub Pages (`https://dopingus-build.github.io/cd-hunt/`).

Catalog metadata lives externally (such as the companion flat repository [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata), which hosts `index.json` and `2026-japan.json`). Users can pick a built-in preset, paste a direct JSON file URL or bare GitHub metadata repository URL, or load a local `.json` file from their device.

## Key Features

- **Google-Sheet-Only Mode (Zero-JSON UX) + Hybrid Overlay:** Paste any public Google Sheet URL directly into CD Hunt (or upload a local `.csv` file) without creating a JSON file or GitHub metadata repository. `cd-hunt` parses the Sheet client-side via [`js/sheet-adapter.js`](./js/sheet-adapter.js), caches the CSV locally for offline shop visits, and preserves your local/D1 checkmarks and unchecks on subsequent reloads. You can also keep a durable JSON snapshot in `cd-metadata` paired with `meta.googleSheetUrl` for live overlay + new row merging.
- **Pluggable Metadata Loader (Google Sheets, JSON & GitHub):** Paste a public Google Sheet URL (auto-converted from `/edit` to `/export?format=csv`), pick presets from `cd-metadata/index.json`, paste a direct catalog JSON URL (GitHub `blob`/`raw` URLs auto-convert to `raw.githubusercontent.com`), paste a bare GitHub repository or `/tree/<branch>` URL to load its `index.json` presets, or load a local `.json`/`.csv` file. Once the Worker Service Account is configured, CD Hunt's Catalog Loader displays the bot email (`sheetSync.serviceAccountEmail`) with a **Copy Bot Email** button for one-click **Editor** sharing.
- **Deep Links, Agent Status Link & Auto-Restore:** URL-loaded catalogs sync to `?catalog=<url>`, persist in `localStorage` (`cd_hunt_catalog_url_v1`), and include **Copy Share Link**, **Backup** JSON export/import, plus **Agent Link** (when signed in) to copy a semi-private read-only `/api/share/<token>?format=markdown` URL for AI / LLM agents without sharing GitHub credentials.
- **Isolated Storage per Catalog:** Progress, cover caches, view mode, and banner dismissal are automatically namespaced (`deriveStoragePrefix`) so separate catalogs never collide in `localStorage`.
- **Schema Validation (`schemaVersion: 1`):** Loaded catalogs are validated client-side by `js/validate.js` against [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json).
- **通常盤-Priority Cover Art Resolution:** Instant offline SVG jewel-case + obi strip covers (`buildJewelCaseDataURI`), lazy two-stage resolution via MusicBrainz/Cover Art Archive (`mbEditions`) and Apple iTunes Search API (`itunesQuery` + `requiredGroups`), multi-edition carousel, and separation of `digitalOnly: true` tracks from the physical shelf-hunting counter.

## Project Structure

```text
cd-hunt/
├── .agents/skills/
│   └── cd-hunt-catalog/SKILL.md   # Vendor-neutral agent skill for catalog & sheet curation
├── .github/workflows/
│   ├── test.yml                   # CI running unit, integration, & system tests
│   ├── e2e-browser.yml            # CI running headless Chromium browser E2E suite
│   └── smoke-live.yml             # Post-deploy / scheduled smoke checks against live Pages + Worker
├── .gitignore
├── .nojekyll                      # Bypass Jekyll on GitHub Pages
├── AGENTS.md                      # Repository instructions & non-negotiables for coding agents
├── README.md
├── index.html                     # Main app HTML shell & Catalog Loader screen
├── css/
│   └── styles.css                 # Zero-CDN responsive dark UI styles
├── js/
│   ├── validate.js                # Versioned schema validator, GitHub & Google Sheets URL normalizer
│   ├── storage.js                 # Sandbox-safe localStorage wrapper & derived key prefixing
│   ├── cover-resolver.js          # Offline SVG obi generator + MusicBrainz/iTunes lookup
│   ├── config.js                  # Static frontend sync endpoint config (window.CDHunt.config)
│   ├── sync.js                    # GitHub session JWT handling, state merge, & cloud sync client
│   ├── sheet-adapter.js           # Canonical 9-column Google Sheet CSV parser & hybrid overlay merger
│   └── app.js                     # App state, catalog loader, rendering, modals, & sync wiring
├── schemas/
│   └── catalog.v1.schema.json     # JSON Schema (Draft 2020-12) for schemaVersion: 1 catalogs
├── docs/
│   ├── HANDOVER.md                # Project context & architectural rules
│   ├── METADATA.md                # Catalog & repository index specification
│   ├── AGENT_CATALOG_GUIDE.md     # Single-file AI / LLM agent guide for Google Sheets & JSON catalogs
│   ├── CLOUD_SYNC_ARCHITECTURE.md # Architecture design for Cloudflare Worker + D1 GitHub sync
│   ├── sample-catalog-sheet.csv   # Canonical 9-column, 1-release-per-row Google Sheet template
│   └── sample-catalog.json        # Sample schemaVersion: 1 catalog JSON template
├── scripts/
│   ├── smoke-live.mjs             # Live GitHub Pages + Cloudflare Worker HTTP/CORS/OAuth smoke tests
│   └── e2e-browser.mjs            # Headless Chromium E2E suite (desktop + mobile 375px + multi-device)
├── worker/
│   ├── README.md                  # Worker API reference, deployment runbook, & Pages config
│   ├── wrangler.toml              # Cloudflare Worker config, limits, & public [vars]
│   ├── schema.sql                 # Cloudflare D1 SQLite schema (user_state & daily_usage)
│   ├── index.mjs                  # ESM entrypoint re-exporting worker/index.js
│   └── index.js                   # Zero-scope GitHub OAuth, JWT auth, D1 API & circuit breaker
└── test/
    ├── catalog-validation.test.js # Unit tests for validator, storage, cover resolver, & sync
    ├── catalog-integration.test.js # Integration tests for index.html, presets, UI, & cloud sync
    ├── cloud-sync-system.test.js  # Full-stack system tests (Frontend VM <-> HTTP Worker <-> SQLite)
    ├── worker-sync.test.js        # Worker unit tests (JWT, CORS, OAuth, rate limits, pause guard)
    └── worker-integration.test.js # End-to-end HTTP + node:sqlite Worker integration tests
```

## Optional Cloud Sync (Cloudflare Worker + D1)

Optional per-user cloud sync is deployed live using the architecture in [`docs/CLOUD_SYNC_ARCHITECTURE.md`](./docs/CLOUD_SYNC_ARCHITECTURE.md), backed by the Cloudflare Worker + D1 instance at `https://cd-hunt-sync.tndo.workers.dev` and wired via [`js/config.js`](./js/config.js) and [`js/sync.js`](./js/sync.js). Signing in uses zero-scope GitHub OAuth (`Sign in`), auto-discovers `<login>/cd-metadata/main/index.json` when no catalog is loaded, and syncs checklists plus compact custom-cover variants with debounced pushes and `visibilitychange`/`pagehide` `keepalive` flushes on mobile while keeping offline `localStorage` as the primary source of truth. See [`worker/README.md`](./worker/README.md) for endpoint details, zero-scope GitHub OAuth guarantees, D1 deployment steps, self-pausing free-tier limits, and Worker URL configuration.

## Using Your Own Metadata

1. **Curating via AI Assistants / Google Sheets:** Point any AI assistant (or configure a reusable custom assistant) at the single self-contained guide [`docs/AGENT_CATALOG_GUIDE.md`](./docs/AGENT_CATALOG_GUIDE.md) and start from the 9-column, 1-release-per-row template [`docs/sample-catalog-sheet.csv`](./docs/sample-catalog-sheet.csv) (or use the agent workspace skill [`.agents/skills/cd-hunt-catalog/SKILL.md`](./.agents/skills/cd-hunt-catalog/SKILL.md) + [`AGENTS.md`](./AGENTS.md)). For two-way Column A (`Got it?`) sync back to your Google Sheet, share your Sheet as **Editor** with `cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com` (also shown via **Copy Bot Email** inside the Catalog Loader). When sharing a public template Google Sheet with others, replacing `/edit` with `/copy?title=My+CD+Hunt+Checklist&userstoinvite=cd-hunt-sync@cd-hunt-sheets-0a54ba.iam.gserviceaccount.com` gives them a 1-click confirmation prompt that duplicates the sheet and invites the sync Service Account automatically.
2. **Creating JSON Catalogs (`schemaVersion: 1`):** Follow [`docs/METADATA.md`](./docs/METADATA.md) and [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json) (see [`docs/sample-catalog.json`](./docs/sample-catalog.json) as a template).
3. Open the app ([live site](https://dopingus-build.github.io/cd-hunt/) or `index.html`), and load metadata via any of:
   - **Public Google Sheet URL:** `https://docs.google.com/spreadsheets/d/<id>/edit` (auto-converted to `/export?format=csv` by [`js/sheet-adapter.js`](./js/sheet-adapter.js) and cached locally for offline use)
   - **Direct File URL:** `https://github.com/<owner>/<repo>/blob/main/<catalog>.json` or `https://raw.githubusercontent.com/...`
   - **GitHub Metadata Repository URL:** `https://github.com/<owner>/<repo>` (or `.../tree/<branch>`) containing a root `index.json`
   - **Local JSON / CSV File:** Upload directly from your device via **Load Local JSON / CSV**
4. For URL-loaded catalogs, your active catalog URL is saved in `localStorage` (`cd_hunt_catalog_url_v1`), synced to `?catalog=`, and shareable via **Copy Share Link**. When signed in with GitHub, click **Agent Link** to copy a semi-private read-only `/api/share/<token>?format=markdown` link so AI / LLM agents can read your live checklist without GitHub credentials.

## Running Tests

Requires Node.js `22.5+` (uses built-in `node:test` and `node:sqlite`, zero npm dependencies):

```sh
# Core unit, integration, and full-stack system tests
node --test test/*.test.js

# Live deployment HTTP/CORS/OAuth smoke checks (Pages + Worker)
node --test scripts/smoke-live.mjs
```

A headless Chromium browser E2E suite ([`scripts/e2e-browser.mjs`](./scripts/e2e-browser.mjs)) also runs in GitHub Actions via [`.github/workflows/e2e-browser.yml`](./.github/workflows/e2e-browser.yml) using an ephemeral Playwright install so the repository remains free of `package.json`/`node_modules`.
