import { beforeEach, describe, expect, test, vi } from 'vitest';

const stores: Record<string, any[]> = {
  amazon_products: [],
  wb_products: [],
  asin_links: [],
  events: [],
  meta: [],
  debug_log: []
};

vi.mock('../src/lib/db.js', () => ({
  getAll: async (store: string) => stores[store] ?? [],
  putMany: async (store: string, rows: any[]) => {
    stores[store] = [...(stores[store] ?? []), ...rows];
  }
}));

import { linkWbSkuToActiveAsin, setActiveAsin, getCardState } from '../src/domain/actions.js';

describe('domain actions', () => {
  beforeEach(() => {
    for (const key of Object.keys(stores)) stores[key] = [];
  });

  test('linkWbSkuToActiveAsin creates active link', async () => {
    await setActiveAsin('B0TESTASIN');
    const link = await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    expect(link.asin).toBe('B0TESTASIN');

    const state = await getCardState('12345678');
    expect(state.linked).toBe(true);
    expect(state.activeAsinLinked).toBe(true);
  });
});
