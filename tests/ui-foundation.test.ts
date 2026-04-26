import { describe, expect, test } from 'vitest';
import { filterAndRankAsinResults } from '../src/lib/asinSearch.js';
import { buildReasonPayload, mapConflictResolution } from '../src/content/ui-helpers.js';

describe('ui foundation helpers', () => {
  test('asin ranking defaults keep active first', () => {
    const products: any[] = [
      { asin: 'B2', title: 'Two', brand: '', category: '', keywords: '', comment: '', workflow_status: 'new' },
      { asin: 'B1', title: 'One', brand: '', category: '', keywords: '', comment: '', workflow_status: 'in_progress' }
    ];
    const rows = filterAndRankAsinResults({ products, query: '', activeAsin: 'B2', recentAsins: [] });
    expect(rows[0].asin).toBe('B2');
  });

  test('conflict decision map', () => {
    expect(mapConflictResolution('cancel')).toBeNull();
    expect(mapConflictResolution('add_second_link')).toBe('add_second_link');
    expect(mapConflictResolution('replace_existing')).toBe('replace_existing');
  });

  test('reject/defer payload trims text', () => {
    expect(buildReasonPayload('wrong_product', '  note  ')).toEqual({ reasonCode: 'wrong_product', reasonText: 'note' });
  });
});
