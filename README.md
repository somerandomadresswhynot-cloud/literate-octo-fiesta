# WB ↔ Amazon ASIN Linker (MV3 prototype)

Local-first Chrome/Brave extension prototype for matching Wildberries SKUs to Amazon ASINs.

## What this prototype proves

1. Import `amazon_products.csv`.
2. Select an active ASIN in popup.
3. Open `wildberries.ru`.
4. Detect visible product links and extract only SKU from `/catalog/{sku}/detail.aspx`.
5. Show compact `A+` overlay on product cards.
6. Click `A+` to link WB SKU to active ASIN.
7. Save link to IndexedDB immediately.
8. Show linked status on card (`A`).
9. Export/backup full state files (`amazon_products.csv`, `wb_products.csv`, `asin_links.csv`, `groups.csv`, `group_members.csv`, `events.csv`, `meta.json`, `debug_log.json`).

## Tech

- Manifest V3
- TypeScript
- IndexedDB runtime storage
- CSV import/export as backup/state format
- No backend, no external APIs

## Project structure

- `public/manifest.json` – MV3 manifest.
- `src/background/index.ts` – central message handlers + domain actions.
- `src/content/index.ts` – Wildberries scanning + compact card overlay.
- `src/popup/index.ts` – active ASIN selection UI.
- `src/options/index.ts` – import/export/summary/clear DB UI.
- `src/domain/actions.ts` – domain actions:
  - `setActiveAsin(asin)`
  - `linkWbSkuToActiveAsin(wb_sku, wb_url)`
  - `getCardState(wb_sku)`
  - `exportCsvState()`

## Data model / stores (IndexedDB)

Object stores:

- `amazon_products`
- `wb_products`
- `asin_links`
- `groups`
- `group_members`
- `events`
- `meta`
- `debug_log`

## CSV schemas

`amazon_products.csv`

```csv
asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at
```

`wb_products.csv`

```csv
wb_sku,wb_url,seen_status,first_seen_at,last_seen_at,last_touched_at,rejected,rejected_reason,deferred,deferred_reason,created_at,updated_at,deleted_at
```

`asin_links.csv`

```csv
link_id,wb_sku,asin,link_type,is_active,comment,created_at,updated_at,deleted_at,created_by_action
```

`events.csv`

```csv
event_id,operation_id,event_type,wb_sku,asin,group_id,payload_json,created_at,client_id
```

`meta.json`

```json
{
  "schema_version": "1",
  "data_revision": "...",
  "active_asin": "...",
  "default_link_type": "candidate",
  "last_imported_at": "...",
  "last_exported_at": "..."
}
```

## Scripts

```bash
npm install
npm run build
npm run typecheck
npm run test
```

## Load unpacked in Brave/Chrome

1. Run `npm install`.
2. Run `npm run build`.
3. Open `brave://extensions` (or `chrome://extensions`).
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the `dist/` directory.

## Manual test checklist (exact flow)

1. Open extension **Options** page.
2. Prepare `amazon_products.csv` with required header and at least one ASIN row.
3. Click **Import amazon_products.csv**.
4. Confirm Storage summary shows Amazon count > 0.
5. Open extension **Popup**.
6. Search and click one ASIN to set active ASIN.
7. Open `https://www.wildberries.ru/catalog/0/search.aspx?...` (any listing page).
8. Scroll so product cards are visible.
9. Verify compact overlay appears on cards with `A+` and status dot.
10. Click `A+` on one card.
11. Verify status changes to `A`.
12. Open Options and click export button.
13. Verify downloads exist:
    - `wb_products.csv`
    - `asin_links.csv`
    - `events.csv`
    - `meta.json`
    - `debug_log.json`
14. Open `asin_links.csv` and confirm new row contains clicked `wb_sku` + active `asin`.
15. Open `debug_log.json` and confirm recent actions / counts / errors sections exist.

## Manual backup/restore test (CSV State v2)

1. Open **Options**.
2. Import `amazon_products.csv` only.
3. Open Popup and select one active ASIN.
4. Open Wildberries listing and click **A+** on one product card.
5. Return to Options and click **Create backup/export now**.
6. Confirm exported files include all of: `amazon_products.csv`, `wb_products.csv`, `asin_links.csv`, `groups.csv`, `group_members.csv`, `events.csv`, `meta.json`, `debug_log.json`.
7. Click **Clear local database** and confirm warning.
8. Use **Restore from exported files** and select the exported CSV/JSON files.
9. Verify storage summary repopulates, active ASIN is restored, and linked WB SKU exists again.

## Notes

- SKU detection is strictly URL-based from visible Wildberries product links.
- The prototype does not parse WB title, price, brand, or image.
- Overlay is absolutely positioned to avoid grid layout shifts.
