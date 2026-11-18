# Osaka CD Cover Album & Checklist (`cd-hunt`)

A mobile-first, zero-dependency, offline-capable web application for hunting used Japanese CDs in person across Osaka (Nipponbashi, Namba, Umeda), designed to work both directly via `file://` and hosted as a static site on GitHub Pages.

## Project Structure

```text
cd-hunt/
├── .gitignore
├── .nojekyll                  # Bypass Jekyll on GitHub Pages
├── README.md
├── index.html                 # Root entry redirect to osaka_cd_cover_album.html
├── osaka_cd_cover_album.html  # Main HTML shell
├── css/
│   └── styles.css             # Zero-CDN responsive dark UI styles
├── data/
│   └── catalog.js             # Catalog metadata, categories, and entries
├── js/
│   ├── validate.js            # Catalog schema & domain validator (browser + Node)
│   ├── storage.js             # Sandbox-safe localStorage wrapper & key namespacing
│   ├── cover-resolver.js      # Offline SVG obi generator + MusicBrainz/iTunes lookup
│   └── app.js                 # App state, catalog loading, rendering, modals
├── docs/
│   ├── HANDOVER.md            # Project context & architectural rules
│   └── METADATA.md            # Catalog schema & validation specification
└── test/
    ├── catalog-validation.test.js   # Unit tests for js/validate.js & data/catalog.js
    └── catalog-integration.test.js  # Integration tests for HTML, modules, & ?catalog=
```

## Customization

Edit [`data/catalog.js`](./data/catalog.js) to customize the branding (`meta`), category pills (`categories`), and release entries (`items`), or pass `?catalog=path/to/custom.json` when hosted over HTTP(S). See [`docs/METADATA.md`](./docs/METADATA.md) for the complete schema and validation requirements.

## Running Tests

Requires Node.js (uses built-in `node:test`, zero npm dependencies):

```sh
node --test test/*.test.js
```
