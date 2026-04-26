import { describe, expect, test } from 'vitest';
import { filterAndRankAsinResults } from '../src/lib/asinSearch.js';
import { buildCardMenuSections, buildReasonPayload, buildStatsGrid, buildStatusTooltip, cardControlsRootStyle, categorizeBulkConflict, computeAbsoluteControlPlacement, computeCardControlsPositionStyle, computeFloatingMenuPosition, getImageFallbackLabel, mapConflictResolution, normalizeCardControlsCount, shouldReparentCardControls, toDocumentCoordinates } from '../src/content/ui-helpers.js';
import { toLinkTypeLabel, toWorkflowStatusLabel } from '../src/content/ui-labels.js';

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

  test('bring-to-front helper requires reparent when not last child', () => {
    expect(shouldReparentCardControls(false)).toBe(true);
    expect(shouldReparentCardControls(true)).toBe(false);
  });

  test('position style helper supports all corners', () => {
    expect(computeCardControlsPositionStyle('top-left', 8, 6)).toEqual({ left: '8px', right: 'auto', top: '6px', bottom: 'auto' });
    expect(computeCardControlsPositionStyle('top-right', 8, 6)).toEqual({ left: 'auto', right: '8px', top: '6px', bottom: 'auto' });
    expect(computeCardControlsPositionStyle('bottom-left', 8, 6)).toEqual({ left: '8px', right: 'auto', top: 'auto', bottom: '6px' });
    expect(computeCardControlsPositionStyle('bottom-right', 8, 6)).toEqual({ left: 'auto', right: '8px', top: 'auto', bottom: '6px' });
  });

  test('document coordinates are derived from rect + scroll', () => {
    expect(toDocumentCoordinates({ top: 20, left: 40 }, 10, 200)).toEqual({ top: 220, left: 50 });
  });

  test('absolute placement helper uses card size and control size', () => {
    const input = { width: 200, height: 300 };
    const origin = { top: 1000, left: 500 };
    const controls = { width: 80, height: 24 };
    const offsets = { x: 8, y: 6 };
    expect(computeAbsoluteControlPlacement('top-left', input, origin, controls, offsets)).toEqual({ top: 1006, left: 508 });
    expect(computeAbsoluteControlPlacement('top-right', input, origin, controls, offsets)).toEqual({ top: 1006, left: 612 });
    expect(computeAbsoluteControlPlacement('bottom-left', input, origin, controls, offsets)).toEqual({ top: 1270, left: 508 });
    expect(computeAbsoluteControlPlacement('bottom-right', input, origin, controls, offsets)).toEqual({ top: 1270, left: 612 });
  });

  test('absolute root style helper includes required non-layout styles', () => {
    const css = cardControlsRootStyle();
    expect(css).toContain('position:absolute');
    expect(css).toContain('pointer-events:none');
    expect(css).toContain('z-index:2147483647');
  });

  test('friendly labels map stored link/workflow values', () => {
    expect(toLinkTypeLabel('exact_match')).toBe('Exact match');
    expect(toWorkflowStatusLabel('in_progress')).toBe('In progress');
  });

  test('stats labels/chips use user-friendly names', () => {
    const chips = buildStatsGrid({ total: 2, seen: 1, linkedActive: 1, linkedTotal: 2, groups: 0, rejected: 0, deferred: 1, selected: 1 });
    expect(chips.find((x) => x.key === 'linked_active')?.label).toBe('Linked to active');
    expect(chips.find((x) => x.key === 'linked_total')?.label).toBe('Linked total');
  });

  test('menu item generation adapts to card state', () => {
    const rows = buildCardMenuSections({ rejected: true, deferred: false, groupCount: 1, linked: true });
    expect(rows).toContain('remove_rejection');
    expect(rows).toContain('manage_groups');
    expect(rows).toContain('show_links');
    expect(rows).not.toContain('reject');
  });

  test('image fallback helper returns asin marker', () => {
    expect(getImageFallbackLabel('b00x')).toBe('B');
    expect(getImageFallbackLabel('')).toBe('ASIN');
  });
});
