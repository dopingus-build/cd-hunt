# AGENTS.md — Disk Crate Repository Instructions

**Disk Crate** (`disk-crate`, formerly `cd-hunt`) is a zero-dependency, offline-first static web app for hunting physical music releases in stores, paired with external JSON catalogs (`cd-metadata`), canonical Google Sheets, and an optional Cloudflare Worker + D1 GitHub sync backend.

## Essential Documentation
- **Catalog & Google Sheet Authoring (Single Reference):** [`docs/AGENT_CATALOG_GUIDE.md`](./docs/AGENT_CATALOG_GUIDE.md) (also exposed as workspace skill [`.agents/skills/disk-crate-catalog/SKILL.md`](./.agents/skills/disk-crate-catalog/SKILL.md))
- **Canonical Google Sheet Template:** [`docs/sample-catalog-sheet.csv`](./docs/sample-catalog-sheet.csv)
- **Project Handover & Constraints:** [`docs/HANDOVER.md`](./docs/HANDOVER.md)
- **Catalog Schema & Validator Rules:** [`docs/METADATA.md`](./docs/METADATA.md) and [`schemas/catalog.v1.schema.json`](./schemas/catalog.v1.schema.json)
- **Cloud Sync Architecture:** [`docs/CLOUD_SYNC_ARCHITECTURE.md`](./docs/CLOUD_SYNC_ARCHITECTURE.md) and [`worker/README.md`](./worker/README.md)
- **Architecture Roadmap:** [`docs/plans/OVERVIEW.md`](./docs/plans/OVERVIEW.md) (Phases 0–2 & Phase 3a completed; Phases 3b–3c planned)

## Architectural Non-Negotiables
1. Keep the frontend core strictly zero-dependency (no npm runtime packages, no CDN scripts/CSS frameworks). Normal page loads download **0 bytes** of camera scanner or WASM code; opt-in Stage 3a+ scanner packs load asynchronously only after user confirmation via `.github/workflows/deploy-pages.yml` (`scripts/fetch-scanner-assets.mjs` for local development) and must never be committed as binaries in Git.
2. Preserve `schemaVersion: 1` catalog validation, derived per-catalog `localStorage` keys (`deriveStoragePrefix`), zero-scope GitHub OAuth, and offline-first behavior.
3. For Google Sheet authoring, always enforce **1 release per row** across the 9 canonical columns (`Got it?`, `Aisle / Category`, `Artist / Franchise`, `Title / Release Details`, `Catalog Number`, `Filing Location & Shelf Search Advice`, `Target Used Price`, `Priority`, `Recommended Shops`).
4. Run `node --test test/*.test.js` (Node `22.5+`) before committing changes.
