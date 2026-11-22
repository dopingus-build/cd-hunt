# AGENTS.md — CD Hunt Repository Instructions

**CD Hunt** (`cd-hunt`) is a zero-dependency, offline-first static web app for hunting physical music releases in stores, paired with external JSON catalogs (`cd-metadata`), canonical Google Sheets, and an optional Cloudflare Worker + D1 GitHub sync backend.

## Essential Documentation
- **Catalog & Google Sheet Authoring (Single Reference):** [`docs/AGENT_CATALOG_GUIDE.md`](./docs/AGENT_CATALOG_GUIDE.md) (also exposed as workspace skill [`.agents/skills/cd-hunt-catalog/SKILL.md`](./.agents/skills/cd-hunt-catalog/SKILL.md))
- **Canonical Google Sheet Template:** [`docs/sample-catalog-sheet.csv`](./docs/sample-catalog-sheet.csv)
- **Project Handover & Constraints:** [`docs/HANDOVER.md`](./docs/HANDOVER.md)
- **Catalog Schema & Validator Rules:** [`docs/METADATA.md`](./docs/METADATA.md) and [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json)
- **Cloud Sync Architecture:** [`docs/CLOUD_SYNC_ARCHITECTURE.md`](./docs/CLOUD_SYNC_ARCHITECTURE.md) and [`worker/README.md`](./worker/README.md)

## Architectural Non-Negotiables
1. Keep the frontend strictly zero-dependency (no npm runtime packages, no CDN scripts/CSS frameworks).
2. Preserve `schemaVersion: 1` catalog validation, derived per-catalog `localStorage` keys (`deriveStoragePrefix`), zero-scope GitHub OAuth, and offline-first behavior.
3. For Google Sheet authoring, always enforce **1 release per row** across the 9 canonical columns (`Got it?`, `Aisle / Category`, `Artist / Franchise`, `Title / Release Details`, `Catalog Number`, `Filing Location & Shelf Search Advice`, `Target Used Price`, `Priority`, `Recommended Shops`).
4. Run `node --test test/*.test.js` (Node `22.5+`) before committing changes.
