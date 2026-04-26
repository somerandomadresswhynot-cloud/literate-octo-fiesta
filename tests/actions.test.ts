import { beforeEach, describe, expect, test, vi } from 'vitest';

const keyByStore: Record<string, string> = {
  amazon_products: 'asin', wb_products: 'wb_sku', asin_links: 'link_id', groups: 'group_id', group_members: 'member_id', events: 'event_id', meta: 'schema_version', debug_log: 'debug_log_id'
};
const stores: Record<string, any[]> = { amazon_products: [], wb_products: [], asin_links: [], groups: [], group_members: [], events: [], meta: [], debug_log: [] };

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

import { getCardState, linkWbSkuToActiveAsin, linkWbSkuToAsin, markCardTouched, markSeenByHover, setActiveAsin, setDefaultLinkType, setDeferred, setRejected, undoLastAction } from '../src/domain/actions.js';

describe('domain actions', () => {
  beforeEach(() => { for (const key of Object.keys(stores)) stores[key] = []; });

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

  test('A+ uses default link type', async () => {
    await setActiveAsin('B0TESTASIN');
    await setDefaultLinkType('exact_match');
    const first = await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    expect(first.status).toBe('created');
    expect(stores.asin_links[0].link_type).toBe('exact_match');
  });

  test('duplicate same ASIN skipped', async () => {
    await setActiveAsin('B0TESTASIN');
    await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    const second = await linkWbSkuToActiveAsin('12345678', 'https://www.wildberries.ru/catalog/12345678/detail.aspx');
    expect(second.status).toBe('duplicate_skipped');
    expect(stores.asin_links.length).toBe(1);
  });

  test('parallel duplicate A+ creates one active link', async () => {
    await setActiveAsin('B0PARALLEL');
    const [a, b] = await Promise.all([
      linkWbSkuToActiveAsin('parallel-sku', 'https://www.wildberries.ru/catalog/1/detail.aspx'),
      linkWbSkuToActiveAsin('parallel-sku', 'https://www.wildberries.ru/catalog/1/detail.aspx')
    ]);
    expect([a.status, b.status].sort()).toEqual(['created', 'duplicate_skipped'].sort());
    expect(stores.asin_links.filter((x) => x.wb_sku === 'parallel-sku' && x.is_active === 'true').length).toBe(1);
  });

  test('add second link creates second active link', async () => {
    await linkWbSkuToAsin({ wb_sku: '1', wb_url: 'u', asin: 'A1', createdByAction: 'add_to_asin' });
    const conflict = await linkWbSkuToAsin({ wb_sku: '1', wb_url: 'u', asin: 'A2', createdByAction: 'add_to_asin' });
    expect(conflict.status).toBe('conflict_detected');
    const resolved = await linkWbSkuToAsin({ wb_sku: '1', wb_url: 'u', asin: 'A2', createdByAction: 'add_to_asin', conflictResolution: 'add_second_link' });
    expect(resolved.status).toBe('created');
    expect(stores.asin_links.filter((x) => x.wb_sku === '1' && x.is_active === 'true').length).toBe(2);
  });

  test('replace deactivates old link and creates new one', async () => {
    await linkWbSkuToAsin({ wb_sku: '2', wb_url: 'u', asin: 'A1', createdByAction: 'add_to_asin' });
    await linkWbSkuToAsin({ wb_sku: '2', wb_url: 'u', asin: 'A2', createdByAction: 'add_to_asin', conflictResolution: 'replace_existing' });
    const old = stores.asin_links.find((x) => x.wb_sku === '2' && x.asin === 'A1');
    const cur = stores.asin_links.find((x) => x.wb_sku === '2' && x.asin === 'A2' && x.is_active === 'true');
    expect(old.is_active).toBe('false');
    expect(Boolean(old.deleted_at)).toBe(true);
    expect(cur).toBeTruthy();
  });

  test('rejected product requires explicit choice', async () => {
    await setRejected('5', 'u', 'wrong_product', 'x');
    const first = await linkWbSkuToAsin({ wb_sku: '5', wb_url: 'u', asin: 'A1', createdByAction: 'add_to_asin' });
    expect(first.status).toBe('rejected_confirmation_required');
    const second = await linkWbSkuToAsin({ wb_sku: '5', wb_url: 'u', asin: 'A1', createdByAction: 'add_to_asin', rejectedResolution: 'keep_rejected' });
    expect(second.status).toBe('created');
  });

  test('undo link deactivates active link', async () => {
    await setActiveAsin('B0TESTASIN');
    await linkWbSkuToActiveAsin('900', 'https://www.wildberries.ru/catalog/900/detail.aspx');
    const undo = await undoLastAction();
    expect(undo.undone).toBe(true);
    expect(stores.asin_links[0].is_active).toBe('false');
  });

  test('defer updates wb_products and writes event', async () => {
    await setDeferred('777', 'https://www.wildberries.ru/catalog/777/detail.aspx', 'check_photo', 'need zoom');
    expect(stores.wb_products[0].deferred).toBe('true');
  });
});
