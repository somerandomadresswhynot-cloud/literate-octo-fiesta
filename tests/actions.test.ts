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
  putMany: async (store: string, rows: any[]) => {
    for (const row of rows) {
      const key = Object.keys(row)[0];
      const idx = (stores[store] ?? []).findIndex((item: any) => item[key] === row[key]);
      if (idx >= 0) stores[store][idx] = row;
      else stores[store] = [...(stores[store] ?? []), row];
    }
  }
}));

import { getCardState, linkWbSkuToActiveAsin, setActiveAsin } from '../src/domain/actions.js';

describe('domain actions', () => {
  beforeEach(() => {
    for (const key of Object.keys(stores)) stores[key] = [];
  });

  test('linkWbSkuToActiveAsin creates active link once', async () => {
    await setActiveAsin('B0TESTASIN');
    const first = await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    const second = await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate_skipped');
    expect(stores.asin_links.length).toBe(1);

    const state = await getCardState('12345678');
    expect(state.linked).toBe(true);
    expect(state.activeAsinLinked).toBe(true);
  });

  test('parallel calls do not create duplicate links and no duplicate link_created event', async () => {
    await setActiveAsin('B0TESTASIN');
    const [r1, r2] = await Promise.all([
      linkWbSkuToActiveAsin('999', 'https://www.wildberries.ru/catalog/999/detail.aspx'),
      linkWbSkuToActiveAsin('999', 'https://www.wildberries.ru/catalog/999/detail.aspx')
    ]);
    expect([r1.status, r2.status].sort()).toEqual(['created', 'created']);
    expect(stores.asin_links.length).toBe(1);
    expect(stores.events.filter((e) => e.event_type === 'link_created').length).toBe(1);
  });
});
