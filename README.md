# CD Hunt — Cover Album & Checklist (`cd-hunt`)

A mobile-first, zero-dependency web application for hunting physical CDs/music releases across stores and tracking crate checklists, hosted as a static site on GitHub Pages (`https://dopingus-build.github.io/cd-hunt/`).

Catalog metadata lives externally (such as the companion flat repository [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata), which hosts `index.json` and `2026-japan.json`). Users can pick a built-in preset, paste a direct JSON file URL or bare GitHub metadata repository URL, or load a local `.json` file from their device.

## Key Features

- **Pluggable Metadata Loader:** Pick presets from `cd-metadata/index.json`, paste a direct catalog JSON URL (GitHub `blob`/`raw` URLs auto-convert to `raw.githubusercontent.com`), paste a bare GitHub repository or `/tree/<branch>` URL to load its `index.json` presets, or load a local `.json` file.
- **Deep Links & Auto-Restore:** URL-loaded catalogs sync to `?catalog=<url>`, persist in `localStorage` (`cd_hunt_catalog_url_v1`) for automatic reload on revisit, and include **Copy Share Link** plus **Backup** JSON export/import.
- **Isolated Storage per Catalog:** Progress, cover caches, view mode, and banner dismissal are automatically namespaced (`deriveStoragePrefix`) so separate catalogs never collide in `localStorage`.
- **Schema Validation (`schemaVersion: 1`):** Loaded catalogs are validated client-side by `js/validate.js` against [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json).
- **通常盤-Priority Cover Art Resolution:** Instant offline SVG jewel-case + obi strip covers (`buildJewelCaseDataURI`), lazy two-stage resolution via MusicBrainz/Cover Art Archive (`mbEditions`) and Apple iTunes Search API (`itunesQuery` + `requiredGroups`), multi-edition carousel, and separation of `digitalOnly: true` tracks from the physical shelf-hunting counter.

## Project Structure

```text
cd-hunt/
├── .github/workflows/test.yml     # CI running unit & integration tests
├── .gitignore
├── .nojekyll                      # Bypass Jekyll on GitHub Pages
├── README.md
├── index.html                     # Main app HTML shell & Catalog Loader screen
├── css/
│   └── styles.css                 # Zero-CDN responsive dark UI styles
├── js/
│   ├── validate.js                # Versioned schema validator & GitHub URL normalizer
│   ├── storage.js                 # Sandbox-safe localStorage wrapper & derived key prefixing
│   ├── cover-resolver.js          # Offline SVG obi generator + MusicBrainz/iTunes lookup
│   └── app.js                     # App state, catalog loader, rendering, modals
├── schemas/
│   └── catalog.v1.schema.json     # JSON Schema (Draft 2020-12) for schemaVersion: 1 catalogs
├── docs/
│   ├── HANDOVER.md                # Project context & architectural rules
│   ├── METADATA.md                # Catalog & repository index specification
│   ├── AGENT_CATALOG_GUIDE.md     # Guide for LLMs/agents creating & editing catalogs
│   ├── CLOUD_SYNC_PLAN.md         # Concept & plan for Cloudflare Worker + D1 GitHub user sync
│   └── sample-catalog.json        # Sample schemaVersion: 1 catalog JSON template
├── worker/
│   ├── README.md                  # Worker API reference, deployment runbook, & Pages config
│   ├── wrangler.toml              # Cloudflare Worker config, limits, & public [vars]
│   ├── schema.sql                 # Cloudflare D1 SQLite schema (user_state & daily_usage)
│   ├── index.mjs                  # ESM entrypoint re-exporting worker/index.js
│   └── index.js                   # Zero-scope GitHub OAuth, JWT auth, D1 API & circuit breaker
└── test/
    ├── catalog-validation.test.js # Unit tests for validator, storage, & cover resolver
    ├── catalog-integration.test.js # Integration tests for index.html, presets, loader, & UI
    ├── worker-sync.test.js        # Worker unit tests (JWT, CORS, OAuth, rate limits, pause guard)
    └── worker-integration.test.js # End-to-end HTTP + node:sqlite Worker integration tests
```

## Optional Cloud Sync (Cloudflare Worker + D1)

A Cloudflare Worker backend lives in [`worker/`](./worker/) (Phase 1 implemented; provisioning and frontend integration planned in [`docs/CLOUD_SYNC_PLAN.md`](./docs/CLOUD_SYNC_PLAN.md)). See [`worker/README.md`](./worker/README.md) for endpoint details, zero-scope GitHub OAuth security guarantees, D1 deployment steps, self-pausing free-tier limits, and configuring the Worker URL on GitHub Pages.

## Using Your Own Metadata

1. Create a catalog JSON file with `"schemaVersion": 1` following [`docs/METADATA.md`](./docs/METADATA.md) and [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json) (see [`docs/sample-catalog.json`](./docs/sample-catalog.json) as a template; if using an LLM or coding agent, point it to [`docs/AGENT_CATALOG_GUIDE.md`](./docs/AGENT_CATALOG_GUIDE.md)).
2. Open the app ([live site](https://dopingus-build.github.io/cd-hunt/) or `index.html`), and load metadata via any of:
   - **Direct File URL:** `https://github.com/<owner>/<repo>/blob/main/<catalog>.json` or `https://raw.githubusercontent.com/...`
   - **GitHub Metadata Repository URL:** `https://github.com/<owner>/<repo>` (or `.../tree/<branch>`) containing a root `index.json`
   - **Local JSON File:** Upload directly from your device via **Load Local JSON File**
3. For URL-loaded catalogs, your active catalog URL is saved in `localStorage` (`cd_hunt_catalog_url_v1`), synced to `?catalog=`, and shareable via **Copy Share Link**.

## Running Tests

Requires Node.js `22.5+` (uses built-in `node:test` and `node:sqlite`, zero npm dependencies):

```sh
node --test test/*.test.js
```
