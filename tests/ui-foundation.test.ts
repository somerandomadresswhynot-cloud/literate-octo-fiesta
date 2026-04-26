import { describe, expect, test } from 'vitest';
import { filterAndRankAsinResults } from '../src/lib/asinSearch.js';
import { buildReasonPayload, buildStatusTooltip, categorizeBulkConflict, computeFloatingMenuPosition, mapConflictResolution, normalizeCardControlsCount } from '../src/content/ui-helpers.js';

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

  test('status tooltip text generation', () => {
    const tip = buildStatusTooltip({ linksCount: 1, firstLink: 'A1 (candidate)', groups: ['G1'], seenStatus: 'seen' });
    expect(tip).toContain('Links: 1');
    expect(tip).toContain('Groups: G1');
  });

  test('conflict summary categorization', () => {
    const c = categorizeBulkConflict([{ linksCount: 0, linkedToTarget: false, linkedToOther: false, rejected: false, deferred: false }, { linksCount: 2, linkedToTarget: true, linkedToOther: true, rejected: true, deferred: true }]);
    expect(c.noConflict).toBe(1);
    expect(c.multipleLinks).toBe(1);
  });

  test('card controls duplicate normalization helper', () => {
    expect(normalizeCardControlsCount(0)).toEqual({ shouldCreate: true, shouldTrimDuplicates: false });
    expect(normalizeCardControlsCount(1)).toEqual({ shouldCreate: false, shouldTrimDuplicates: false });
    expect(normalizeCardControlsCount(3)).toEqual({ shouldCreate: false, shouldTrimDuplicates: true });
  });

  test('menu position helper keeps dropdown in viewport bounds', () => {
    expect(computeFloatingMenuPosition({ left: 2, bottom: 20, viewportWidth: 400 })).toEqual({ left: 8, top: 24 });
    expect(computeFloatingMenuPosition({ left: 390, bottom: 40, viewportWidth: 400 })).toEqual({ left: 180, top: 44 });
  });
});
