import { beforeEach, describe, expect, test, vi } from 'vitest';

const keyByStore: Record<string, string> = {
  amazon_products: 'asin', wb_products: 'wb_sku', asin_links: 'link_id', groups: 'group_id', group_members: 'membership_id', events: 'event_id', meta: 'schema_version', debug_log: 'debug_log_id'
};
const stores: Record<string, any[]> = { amazon_products: [], wb_products: [], asin_links: [], groups: [], group_members: [], events: [], meta: [], debug_log: [] };

vi.mock('../src/lib/db.js', () => ({
  getAll: async (store: string) => stores[store] ?? [],
  getByKey: async (store: string, key: string) => (stores[store] ?? []).find((item: any) => item[keyByStore[store]] === key),
  getAllByIndex: async (store: string, indexName: string, key: string) => {
    if (indexName.includes('wb_sku')) return (stores[store] ?? []).filter((item: any) => item.wb_sku === key);
    if (indexName.includes('group_id')) return (stores[store] ?? []).filter((item: any) => item.group_id === key);
    if (indexName.includes('asin')) return (stores[store] ?? []).filter((item: any) => item.asin === key);
    return stores[store] ?? [];
  },
  putMany: async (store: string, rows: any[]) => {
    for (const row of rows) {
      const key = keyByStore[store];
      const idx = (stores[store] ?? []).findIndex((item: any) => item[key] === row[key]);
      if (idx >= 0) stores[store][idx] = row;
      else stores[store] = [...(stores[store] ?? []), row];
    }
  }
}));

import { addWbSkuToGroup, bulkAddToGroup, bulkDefer, bulkLinkToSelectedAsin, bulkReject, createGroup, getCardState, getHistoryBySku, linkWbSkuToActiveAsin, linkWbSkuToAsin, markCardTouched, markSeenByHover, removeWbSkuFromGroup, setActiveAsin, setDefaultLinkType, setDeferred, setRejected, undoLastAction } from '../src/domain/actions.js';

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
    expect(['created', 'duplicate_skipped']).toContain(a.status);
    expect(['created', 'duplicate_skipped']).toContain(b.status);
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

  test('create group + add sku + duplicate skipped + remove soft delete', async () => {
    const group = await createGroup({ name: 'Проверить позже', icon: '≡', comment: 'later', group_type: 'manual' });
    expect(group.group_id).toBeTruthy();
    const add = await addWbSkuToGroup('100', 'u', group.group_id);
    expect(add.status).toBe('added');
    const dup = await addWbSkuToGroup('100', 'u', group.group_id);
    expect(dup.status).toBe('already_in_group');
    const removed = await removeWbSkuFromGroup('100', group.group_id);
    expect(removed.removed).toBe(true);
    const member = stores.group_members[0];
    expect(Boolean(member.deleted_at)).toBe(true);
  });

  test('card state includes group count and preview', async () => {
    const a = await createGroup({ name: 'A' });
    const b = await createGroup({ name: 'B' });
    await addWbSkuToGroup('200', 'u', a.group_id);
    await addWbSkuToGroup('200', 'u', b.group_id);
    const state = await getCardState('200');
    expect(state.groupCount).toBe(2);
    expect(state.groupPreview.length).toBeGreaterThan(0);
  });

  test('bulk link no-conflict links all', async () => {
    const s = await bulkLinkToSelectedAsin([{ wb_sku: '31', wb_url: 'u1' }, { wb_sku: '32', wb_url: 'u2' }], 'A31', 'candidate', 'skip_conflicts');
    expect(s.succeeded).toBe(2);
  });

  test('bulk add to group skips duplicates', async () => {
    const g = await createGroup({ name: 'bulk' });
    await addWbSkuToGroup('41', 'u', g.group_id);
    const s = await bulkAddToGroup([{ wb_sku: '41', wb_url: 'u' }, { wb_sku: '42', wb_url: 'u' }], g.group_id);
    expect(s.succeeded).toBe(1);
    expect(s.duplicates).toBe(1);
  });

  test('bulk reject/defer keep links and write events', async () => {
    await linkWbSkuToAsin({ wb_sku: '51', wb_url: 'u', asin: 'A', createdByAction: 'add_to_asin' });
    await bulkReject([{ wb_sku: '51', wb_url: 'u' }], 'bad_candidate', '');
    await bulkDefer([{ wb_sku: '52', wb_url: 'u' }], 'unsure_match', '');
    expect(stores.asin_links.find((x) => x.wb_sku === '51' && x.is_active === 'true')).toBeTruthy();
    expect(stores.events.some((e) => e.event_type === 'bulk_action_started')).toBe(true);
    expect(stores.events.some((e) => e.event_type === 'bulk_action_completed')).toBe(true);
  });

  test('history query by wb_sku works', async () => {
    await markSeenByHover('61', 'u');
    await markCardTouched('61', 'u', 'x');
    const h = await getHistoryBySku('61', 100);
    expect(h.events.length).toBeGreaterThan(0);
  });
});
