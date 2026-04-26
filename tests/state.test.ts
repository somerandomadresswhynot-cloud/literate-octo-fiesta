import { beforeEach, describe, expect, test, vi } from 'vitest';

const stores: Record<string, any[]> = {
  amazon_products: [],
  wb_products: [],
  asin_links: [],
  groups: [],
  group_members: [],
  events: [],
  meta: [],
  debug_log: []
};

vi.mock('../src/lib/db.js', () => ({
  getAll: async (store: string) => stores[store] ?? [],
  putMany: async (store: string, rows: any[]) => { stores[store] = [...(stores[store] ?? []), ...rows]; },
  clearStore: async (store: string) => { stores[store] = []; },
  clearDb: async () => { Object.keys(stores).forEach((k) => { stores[k] = []; }); }
}));

(globalThis as any).chrome = {
  runtime: { getManifest: () => ({ version: '0.1.0-test' }) }
};

import { exportStateFiles, importStateFiles, repairDuplicateActiveLinks, validateLocalState } from '../src/domain/state.js';

describe('state import/export', () => {
  beforeEach(() => {
    Object.keys(stores).forEach((k) => { stores[k] = []; });
  });

  test('imports empty groups and group_members files', async () => {
    const summary = await importStateFiles({
      'groups.csv': 'group_id,name,description,created_at,updated_at,deleted_at\n',
      'group_members.csv': 'member_id,group_id,wb_sku,created_at,updated_at,deleted_at\n'
    }, 'import');
    expect(summary.imported.groups).toBe(0);
    expect(summary.imported.group_members).toBe(0);
  });

  test('warns on invalid payload_json and duplicate active links', async () => {
    const summary = await importStateFiles({
      'amazon_products.csv': 'asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at\nA1,url,t,b,i,c,k,c,p,w,r,l,ca,ua',
      'asin_links.csv': 'link_id,wb_sku,asin,link_type,is_active,comment,created_at,updated_at,deleted_at,created_by_action\n1,sku,A1,candidate,true,,a,b,,A+\n2,sku,A1,candidate,true,,a,b,,A+',
      'events.csv': 'event_id,operation_id,event_type,wb_sku,asin,group_id,payload_json,created_at,client_id\ne1,o1,t,sku,A1,,{bad_json},now,cid'
    }, 'import');
    expect(summary.warning_count).toBeGreaterThan(1);
  });

  test('meta restore sets active asin', async () => {
    await importStateFiles({
      'meta.json': JSON.stringify({ schema_version: '1', data_revision: '2', active_asin: 'A55', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '' })
    }, 'restore');
    expect(stores.meta[0].active_asin).toBe('A55');
  });

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

  test('repairDuplicateActiveLinks deactivates later duplicate without deleting', async () => {
    await importStateFiles({
      'amazon_products.csv': 'asin,amazon_url,title,brand,image_url,category,keywords,comment,priority,workflow_status,checked_result,last_checked_at,created_at,updated_at\nA1,url,t,b,i,c,k,c,p,w,r,l,ca,ua',
      'asin_links.csv': 'link_id,wb_sku,asin,link_type,is_active,comment,created_at,updated_at,deleted_at,created_by_action\n1,sku,A1,candidate,true,,2026-01-01,2026-01-01,,A+\n2,sku,A1,candidate,true,,2026-01-02,2026-01-02,,A+'
    }, 'import');
    const repaired = await repairDuplicateActiveLinks();
    expect(repaired.repaired_count).toBe(1);
    expect(stores.asin_links.length).toBe(2);
    const deactivated = stores.asin_links.find((x) => x.link_id === '2');
    expect(deactivated.is_active).toBe('false');
    expect(Boolean(deactivated.deleted_at)).toBe(true);
  });

});
