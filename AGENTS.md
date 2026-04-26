# AGENTS.md

## Project

This repository contains a local-first Chrome/Brave extension for matching Wildberries product SKUs to Amazon ASINs.

The product goal is fast manual matching directly on Wildberries pages:

1. User imports Amazon ASIN data from CSV.
2. User selects an active ASIN in the extension popup.
3. User opens wildberries.ru.
4. The extension detects visible WB product SKUs from product links.
5. The extension shows compact overlay controls on WB product cards.
6. User clicks `A+` on a WB card.
7. The extension links that WB SKU to the active ASIN.
8. The extension stores the result locally and exports CSV state files for later work.

## Hard architecture constraints

Do not implement or suggest:

- Google Sheets integration
- Google Sheets API
- Apps Script
- backend server
- cloud database
- external API calls
- user account authentication
- OAuth
- remote logging
- analytics services

This project is local-first.

CSV files are the import/export, backup, and human-readable state format.

IndexedDB is the runtime database used by the extension for speed.

In-memory indexes are used for instant UI updates on Wildberries pages.

## Runtime data architecture

Use this architecture:

```text
CSV files
  -> import
IndexedDB
  -> runtime storage
in-memory indexes
  -> instant WB page UI
extension UI actions
  -> events + materialized state
export
  -> CSV state files + backups + debug log
