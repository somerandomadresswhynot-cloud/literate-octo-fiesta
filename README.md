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

`groups.csv`

```csv
group_id,name,icon,comment,group_type,created_at,updated_at,deleted_at
```

`group_members.csv`

```csv
membership_id,group_id,wb_sku,wb_url,created_at,updated_at,deleted_at
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
9. Verify compact overlay appears on cards with status marker, `A+`, and `⋯` menu.
10. Hover one card for at least 1.2 seconds and verify seen marker appears (`👁`).
11. Open `⋯` menu and click **Copy WB URL**. Verify toast `WB link copied` appears.
12. Open `⋯` menu and click **Reject**. Pick reason and verify marker changes to `×`.
13. Click **Undo** on the toast and verify reject is reverted.
14. Open `⋯` menu and click **Defer / check later**. Pick reason and verify marker changes to `?`.
15. Click `A+` on one card and verify status changes to `A`.
16. Open Options and click export button.
17. Verify downloads exist:
    - `wb_products.csv`
    - `asin_links.csv`
    - `events.csv`
    - `meta.json`
    - `debug_log.json`
18. Open `wb_products.csv` and confirm rejected/deferred/seen_status fields are updated.
19. Open `events.csv` and confirm events include hover/copy/reject/defer/undo actions.

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

## Manual test: all-in-one JSON restore safety

1. Import `amazon_products.csv`.
2. Select active ASIN.
3. Open Wildberries.
4. Click `A+` on 2 cards.
5. Download all-in-one JSON backup.
6. Clear local DB.
7. Restore all-in-one JSON backup.
8. Verify storage summary matches pre-clear counts.
9. Reopen Wildberries and verify linked cards still show linked status.
10. Click `A+` repeatedly on same card.
11. Validate local state.
12. Confirm no duplicate active link warning.
13. Download diagnostic snapshot.


## Manual diagnostics download test

1. Import data (`amazon_products.csv` minimum).
2. Open popup and set active ASIN.
3. Open Wildberries page and link one card with **A+**.
4. Open Options page.
5. Click **Download debug_log.json**.
6. Click **Download diagnostic_snapshot.json**.
7. Verify both files appear in browser Downloads and open as valid JSON.


## Manual stability test (duplicate + verbose logging)

1. Link a card once with **A+**.
2. Click **A+** repeatedly/quickly on the same card.
3. Export backup.
4. Verify only one active link exists for that `wb_sku + asin`.
5. Open Options and click **Validate local state**.
6. Confirm no duplicate active-link warning after repair/normal flow.
7. Toggle **Verbose scan logging** on/off and verify scan logs become more/less detailed.

## Notes

- SKU detection is strictly URL-based from visible Wildberries product links.
- The prototype does not parse WB title, price, brand, or image.
- Overlay is absolutely positioned to avoid grid layout shifts.


## Manual test: ASIN Search + Link Types + Conflict Handling v1

1. Select active ASIN `B000TEST01` in popup.
2. Link one WB SKU with `A+`.
3. Switch active ASIN to `B000TEST02`.
4. Click `A+` on the same SKU.
5. Confirm conflict prompt appears.
6. Choose add second link.
7. Export and verify two active links for the SKU.
8. Try another SKU and choose replace existing link.
9. Export and verify previous link is inactive (`is_active=false`, `deleted_at` filled).

## Manual test: UI Foundation PR (dialogs/popovers)

1. Open WB page.
2. Open ⋯ menu.
3. Copy WB URL.
4. Reject product using custom dialog.
5. Undo reject from toast.
6. Defer product using custom dialog.
7. Undo defer from toast.
8. Add product to non-active ASIN using custom ASIN search dialog.
9. Trigger conflict by linking same SKU to another ASIN.
10. Resolve conflict with Add second link.
11. Repeat conflict and use Replace existing links.
12. Show context dialog.
13. Export all-in-one backup and verify events/links changed.

## Manual test: Groups v1

1. Open WB.
2. Open `⋯` on a card.
3. Click **Add to group...**.
4. Create group `Проверить позже`.
5. Confirm card shows `≡`.
6. Open **Manage groups**.
7. Remove from group.
8. Click Undo (if shown).
9. Export all-in-one backup.
10. Restore backup and verify group state remains.
