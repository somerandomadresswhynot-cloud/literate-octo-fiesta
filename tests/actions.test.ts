import { beforeEach, describe, expect, test, vi } from 'vitest';

const keyByStore: Record<string, string> = {
  amazon_products: 'asin',
  wb_products: 'wb_sku',
  asin_links: 'link_id',
  groups: 'group_id',
  group_members: 'member_id',
  events: 'event_id',
  meta: 'schema_version',
  debug_log: 'ts'
};

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
      const key = keyByStore[store];
      const idx = (stores[store] ?? []).findIndex((item: any) => item[key] === row[key]);
      if (idx >= 0) stores[store][idx] = row;
      else stores[store] = [...(stores[store] ?? []), row];
    }
  }
}));

import {
  getCardState,
  linkWbSkuToActiveAsin,
  markCardTouched,
  markSeenByHover,
  setActiveAsin,
  setDeferred,
  setRejected,
  undoLastAction
} from '../src/domain/actions.js';

describe('domain actions', () => {
  beforeEach(() => {
    for (const key of Object.keys(stores)) stores[key] = [];
  });

  test('seen_by_hover event is written once per sku', async () => {
    await markSeenByHover('123', 'https://www.wildberries.ru/catalog/123/detail.aspx');
    await markSeenByHover('123', 'https://www.wildberries.ru/catalog/123/detail.aspx');
    expect(stores.events.filter((e) => e.event_type === 'seen_by_hover').length).toBe(1);
  });

  test('markCardTouched sets touched status', async () => {
    await markCardTouched('123', 'https://www.wildberries.ru/catalog/123/detail.aspx', 'copy');
    const state = await getCardState('123');
    expect(state.seenStatus).toBe('touched');
  });

  test('reject updates wb_products and writes event', async () => {
    await setRejected('555', 'https://www.wildberries.ru/catalog/555/detail.aspx', 'wrong_product', 'bad color');
    expect(stores.wb_products[0].rejected).toBe('true');
    expect(stores.wb_products[0].rejected_reason).toContain('wrong_product');
    expect(stores.events.some((e) => e.event_type === 'rejected_set' && e.wb_sku === '555')).toBe(true);
  });

  test('defer updates wb_products and writes event', async () => {
    await setDeferred('777', 'https://www.wildberries.ru/catalog/777/detail.aspx', 'check_photo', 'need zoom');
    expect(stores.wb_products[0].deferred).toBe('true');
    expect(stores.wb_products[0].deferred_reason).toContain('check_photo');
    expect(stores.events.some((e) => e.event_type === 'deferred_set' && e.wb_sku === '777')).toBe(true);
  });

  test('undo link deactivates active link', async () => {
    await setActiveAsin('B0TESTASIN');
    await linkWbSkuToActiveAsin('900', 'https://www.wildberries.ru/catalog/900/detail.aspx');
    const undo = await undoLastAction();
    expect(undo.undone).toBe(true);
    expect(stores.asin_links[0].is_active).toBe('false');
  });

  test('undo reject clears rejected state', async () => {
    await setRejected('1000', 'https://www.wildberries.ru/catalog/1000/detail.aspx', 'duplicate', '');
    await undoLastAction();
    expect(stores.wb_products[0].rejected).toBe('false');
    expect(stores.wb_products[0].rejected_reason).toBe('');
  });

  test('undo defer clears deferred state', async () => {
    await setDeferred('1001', 'https://www.wildberries.ru/catalog/1001/detail.aspx', 'other', '');
    await undoLastAction();
    expect(stores.wb_products[0].deferred).toBe('false');
    expect(stores.wb_products[0].deferred_reason).toBe('');
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
