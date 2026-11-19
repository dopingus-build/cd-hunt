# CD Hunt — Cover Album & Checklist (`cd-hunt`)

A mobile-first, zero-dependency web application for hunting physical CDs/vinyl and tracking checklists across stores, hosted as a static site on GitHub Pages (`https://dopingus-build.github.io/cd-hunt/`).

Catalog metadata lives separately in the flat public repository [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata) (with `index.json` listing available preset catalogs such as `2026-japan.json`). Any user can load a preset, paste a public metadata JSON URL (GitHub `blob` URLs are auto-converted to `raw.githubusercontent.com`), or upload a local `.json` file from their device.

## Project Structure

```text
cd-hunt/
├── .github/workflows/test.yml # CI running unit & integration tests
├── .gitignore
├── .nojekyll                  # Bypass Jekyll on GitHub Pages
├── README.md
├── index.html                 # Main app HTML shell & Catalog Loader screen
├── css/
│   └── styles.css             # Zero-CDN responsive dark UI styles
├── js/
│   ├── validate.js            # Versioned schema validator & GitHub URL normalizer
│   ├── storage.js             # Sandbox-safe localStorage wrapper & derived key prefixing
│   ├── cover-resolver.js      # Offline SVG obi generator + MusicBrainz/iTunes lookup
│   └── app.js                 # App state, catalog loader, rendering, modals
├── schemas/
│   └── catalog.v1.schema.json # JSON Schema (Draft 2020-12) for schemaVersion: 1 catalogs
├── docs/
│   ├── HANDOVER.md            # Project context & architectural rules
│   ├── METADATA.md            # Catalog schema & validation specification
│   ├── AGENT_CATALOG_GUIDE.md # Guide for LLMs/agents creating & editing catalogs
│   └── sample-catalog.json    # Sample schemaVersion: 1 catalog JSON template
└── test/
    ├── catalog-validation.test.js   # Unit tests for validator, schema, & storage prefixing
    └── catalog-integration.test.js  # Integration tests for index.html, presets, & loader
```

## Using Your Own Metadata

1. Create a JSON file with `"schemaVersion": 1` following [`docs/METADATA.md`](./docs/METADATA.md) and [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json) (see [`docs/sample-catalog.json`](./docs/sample-catalog.json) as a template; if using an LLM or coding agent, point it to [`docs/AGENT_CATALOG_GUIDE.md`](./docs/AGENT_CATALOG_GUIDE.md)).
2. Open the app (`index.html`), paste your URL (`https://github.com/<owner>/<repo>/blob/...` or `raw.githubusercontent.com`) or load a local `.json` file directly.
3. For URL-loaded catalogs, your active URL is saved in `localStorage` (`cd_hunt_catalog_url_v1`), synced to `?catalog=`, and shareable via **Copy Share Link**. Progress keys are automatically derived per catalog so separate lists never collide.

## Running Tests

Requires Node.js (uses built-in `node:test`, zero npm dependencies):

```sh
node --test test/*.test.js
```
