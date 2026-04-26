import { beforeEach, describe, expect, test, vi } from 'vitest';

const stores: Record<string, any[]> = {
  amazon_products: [], wb_products: [], asin_links: [], groups: [], group_members: [], events: [], meta: [], debug_log: []
};
const keyByStore: Record<string, string> = { amazon_products: 'asin', wb_products: 'wb_sku', asin_links: 'link_id', groups: 'group_id', group_members: 'member_id', events: 'event_id', meta: 'schema_version', debug_log: 'debug_log_id' };

vi.mock('../src/lib/db.js', () => ({
  getAll: async (store: string) => stores[store] ?? [],
  getByKey: async (store: string, key: string) => (stores[store] ?? []).find((row) => row[keyByStore[store]] === key),
  putMany: async (store: string, rows: any[]) => { stores[store] = [...(stores[store] ?? []), ...rows]; },
  clearStore: async (store: string) => { stores[store] = []; },
  clearDb: async () => { Object.keys(stores).forEach((k) => { stores[k] = []; }); },
  runTransaction: async (_stores: string[], _mode: string, run: (tx: any) => Promise<void> | void) => {
    const tx = { objectStore: (store: string) => ({
      clear: () => { stores[store] = []; },
      put: (row: any) => {
        const key = keyByStore[store];
        const idx = stores[store].findIndex((x) => x[key] === row[key]);
        if (idx >= 0) stores[store][idx] = row; else stores[store].push(row);
      }
    }) };
    await run(tx);
  }
}));

(globalThis as any).chrome = { runtime: { getManifest: () => ({ version: '0.1.0-test' }) } };

import { exportStateFiles, importStateFiles, repairDuplicateActiveLinks, restoreFromAllInOneBackup, validateAllInOneBackupPayload, validateLocalState } from '../src/domain/state.js';

describe('state import/export', () => {
  beforeEach(() => { Object.keys(stores).forEach((k) => { stores[k] = []; }); });

  test('roundtrip export/import keeps records', async () => {
    await importStateFiles({
      'amazon_products.csv': 'asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at\nA1,url,t,b,i,c,k,c,p,w,r,l,ca,ua'
    }, 'import');
    const exported = await exportStateFiles();
    Object.keys(stores).forEach((k) => { stores[k] = []; });
    const summary = await importStateFiles(exported.files, 'restore');
    expect(summary.imported.amazon_products).toBe(1);
  });

  test('validateLocalState reports duplicate active links', async () => {
    await importStateFiles({
      'amazon_products.csv': 'asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at\nA1,url,t,b,i,c,k,c,p,w,r,l,ca,ua',
      'asin_links.csv': 'link_id,wb_sku,asin,link_type,is_active,comment,created_at,updated_at,deleted_at,created_by_action\n1,sku,A1,candidate,true,,2026-01-01,2026-01-01,,A+\n2,sku,A1,candidate,true,,2026-01-02,2026-01-02,,A+'
    }, 'import');
    const result = await validateLocalState();
    expect(result.duplicate_active_link_count).toBe(1);
    expect(result.validation_warnings.some((w) => w.includes('duplicate active links'))).toBe(true);
  });

  test('all-in-one restore restores counts, links, events, and active ASIN', async () => {
    const payload = {
      amazon_products: [{ asin: 'A1' }],
      wb_products: [{ wb_sku: 'W1', wb_url: '', seen_status: 'seen', first_seen_at: '', last_seen_at: '', last_touched_at: '', rejected: 'false', rejected_reason: '', deferred: 'false', deferred_reason: '', created_at: '', updated_at: '', deleted_at: '' }],
      asin_links: [{ link_id: 'L1', wb_sku: 'W1', asin: 'A1', link_type: 'candidate', is_active: 'true', comment: '', created_at: '', updated_at: '', deleted_at: '', created_by_action: 'A+' }],
      groups: [],
      group_members: [],
      events: [{ event_id: 'E1', operation_id: 'O1', event_type: 'link_created', wb_sku: 'W1', asin: 'A1', group_id: '', payload_json: '{}', created_at: '2026-01-01T00:00:00.000Z', client_id: 'local' }],
      meta: { schema_version: '1', data_revision: '1', active_asin: 'A1', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '', verbose_scan_logging: 'false' },
      debug_logs: [{ ts: '2026-01-01T00:00:00.000Z', level: 'info', action: 'x' }]
    };

    const dryRun = await validateAllInOneBackupPayload(payload);
    expect(dryRun.fatalErrors.length).toBe(0);
    const restored = await restoreFromAllInOneBackup(payload);
    expect(restored.restored).toBe(true);
    expect(stores.amazon_products.length).toBe(1);
    expect(stores.asin_links.length).toBe(1);
    expect(stores.events.some((e) => e.event_type === 'restore_completed')).toBe(true);
    expect(stores.meta[0].active_asin).toBe('A1');
  });

  test('repairDuplicateActiveLinks deactivates later duplicate without deleting', async () => {
    await importStateFiles({
      'amazon_products.csv': 'asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at\nA1,url,t,b,i,c,k,c,p,w,r,l,ca,ua',
      'asin_links.csv': 'link_id,wb_sku,asin,link_type,is_active,comment,created_at,updated_at,deleted_at,created_by_action\n1,sku,A1,candidate,true,,2026-01-01,2026-01-01,,A+\n2,sku,A1,candidate,true,,2026-01-02,2026-01-02,,A+'
    }, 'import');
    const repaired = await repairDuplicateActiveLinks();
    expect(repaired.repaired_count).toBe(1);
    const deactivated = stores.asin_links.find((x) => x.link_id === '2');
    expect(deactivated.is_active).toBe('false');
  });
});
