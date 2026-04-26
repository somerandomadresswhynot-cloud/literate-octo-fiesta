import { beforeEach, describe, expect, test, vi } from 'vitest';

const stores: Record<string, any[]> = { amazon_products: [], wb_products: [], asin_links: [], groups: [], group_members: [], events: [], meta: [], debug_log: [] };
vi.mock('../src/lib/db.js', () => ({
  getAll: async (store: string) => stores[store] ?? [],
  putMany: async () => {},
  clearStore: async () => {}
}));

(globalThis as any).chrome = { runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: 'test' }), lastError: null } };

import { performAsinSearch } from '../src/background/index.js';

describe('asin search', () => {
  beforeEach(() => {
    stores.amazon_products = [
      { asin: 'B0001', amazon_url: '', title: 'Blue Shirt', brand: 'Acme', image_url: '', category: 'apparel', keywords: 'shirt blue', comment: 'summer', priority: '', workflow_status: 'in_progress', checked_result: '', last_checked_at: '', created_at: '', updated_at: '' },
      { asin: 'B0002', amazon_url: '', title: 'Red Pants', brand: 'Road', image_url: '', category: 'apparel', keywords: 'pants red', comment: 'winter', priority: '', workflow_status: 'new', checked_result: '', last_checked_at: '', created_at: '', updated_at: '' }
    ];
    stores.meta = [{ schema_version: '1', data_revision: '1', active_asin: 'B0002', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '', verbose_scan_logging: 'false' }];
    stores.events = [];
  });

  test('search by ASIN', async () => {
    const r = await performAsinSearch('B0001');
    expect(r.results[0].asin).toBe('B0001');
  });
  test('search by title', async () => {
    const r = await performAsinSearch('blue');
    expect(r.results[0].asin).toBe('B0001');
  });
  test('search by brand', async () => {
    const r = await performAsinSearch('road');
    expect(r.results[0].asin).toBe('B0002');
  });
  test('search by comment/keywords', async () => {
    const r = await performAsinSearch('summer');
    expect(r.results[0].asin).toBe('B0001');
    const r2 = await performAsinSearch('pants');
    expect(r2.results[0].asin).toBe('B0002');
  });
});
