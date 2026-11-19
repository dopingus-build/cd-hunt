# Osaka CD Cover Album & Checklist (`cd-hunt`)

A mobile-first, zero-dependency web application for hunting used Japanese CDs in person across Osaka (Nipponbashi, Namba, Umeda), hosted as a static site on GitHub Pages (`https://dopingus-build.github.io/cd-hunt/`).

Catalog metadata lives in a separate flat public repository: [`dopingus-build/cd-metadata`](https://github.com/dopingus-build/cd-metadata) (default catalog: [`2026-japan.json`](https://raw.githubusercontent.com/dopingus-build/cd-metadata/main/2026-japan.json)). Anyone can paste a URL to their own public metadata JSON file in the Catalog Loader screen (GitHub `blob` URLs are automatically converted to `raw.githubusercontent.com`).

## Project Structure

```text
cd-hunt/
├── .gitignore
├── .nojekyll                  # Bypass Jekyll on GitHub Pages
├── README.md
├── index.html                 # Root entry redirect to osaka_cd_cover_album.html
├── osaka_cd_cover_album.html  # Main HTML shell & Catalog Loader screen
├── css/
│   └── styles.css             # Zero-CDN responsive dark UI styles
├── js/
│   ├── validate.js            # Catalog validator & GitHub URL normalizer (browser + Node)
│   ├── storage.js             # Sandbox-safe localStorage wrapper & key namespacing
│   ├── cover-resolver.js      # Offline SVG obi generator + MusicBrainz/iTunes lookup
│   └── app.js                 # App state, catalog URL loading, rendering, modals
├── docs/
│   ├── HANDOVER.md            # Project context & architectural rules
│   ├── METADATA.md            # Catalog schema & validation specification
│   └── sample-catalog.json    # Sample metadata JSON template
└── test/
    ├── catalog-validation.test.js   # Unit tests for js/validate.js & metadata JSONs
    └── catalog-integration.test.js  # Integration tests for HTML, loader, & ?catalog=
```

## Using Your Own Metadata

1. Create a public JSON file following [`docs/METADATA.md`](./docs/METADATA.md) (see [`docs/sample-catalog.json`](./docs/sample-catalog.json) as a starting point).
2. Open the app and paste the URL (either `https://github.com/<owner>/<repo>/blob/...` or `https://raw.githubusercontent.com/...`) into the Catalog Loader, or open `?catalog=<url>` directly.
3. Your active catalog URL is saved in `localStorage` (`cd_hunt_catalog_url_v1`) and synced to the `?catalog=` query parameter for bookmarking/sharing.

## Running Tests

Requires Node.js (uses built-in `node:test`, zero npm dependencies):

```sh
node --test test/*.test.js
```
