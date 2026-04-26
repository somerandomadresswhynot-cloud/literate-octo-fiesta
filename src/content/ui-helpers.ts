export const REJECT_REASONS = ['wrong_product', 'wrong_size', 'other_brand', 'bad_candidate', 'duplicate', 'not_interesting', 'other'] as const;
export const DEFER_REASONS = ['compare_size', 'check_photo', 'unsure_match', 'check_seller', 'other'] as const;

export function buildReasonPayload(reasonCode: string, reasonText: string): { reasonCode: string; reasonText: string } {
  return { reasonCode: reasonCode.trim(), reasonText: reasonText.trim() };
}

export function mapConflictResolution(decision: 'cancel' | 'add_second_link' | 'replace_existing'): 'add_second_link' | 'replace_existing' | null {
  if (decision === 'cancel') return null;
  return decision;
}

export function buildStatusTooltip(input: { linksCount: number; firstLink?: string; groups?: string[]; rejectedReason?: string; deferredReason?: string; seenStatus?: string }): string {
  const parts = [`Links: ${input.linksCount}`];
  if (input.firstLink) parts.push(`First: ${input.firstLink}`);
  if (input.groups && input.groups.length) parts.push(`Groups: ${input.groups.join(', ')}`);
  if (input.rejectedReason) parts.push(`Rejected: ${input.rejectedReason}`);
  if (input.deferredReason) parts.push(`Deferred: ${input.deferredReason}`);
  if (input.seenStatus) parts.push(`Seen: ${input.seenStatus}`);
  return parts.join('\n');
}

export function categorizeBulkConflict(items: Array<{ linksCount: number; linkedToTarget: boolean; linkedToOther: boolean; rejected: boolean; deferred: boolean }>): { noConflict: number; alreadyLinked: number; linkedOther: number; rejected: number; deferred: number; multipleLinks: number } {
  return items.reduce((acc, item) => {
    if (item.linksCount === 0) acc.noConflict += 1;
    if (item.linkedToTarget) acc.alreadyLinked += 1;
    if (item.linkedToOther) acc.linkedOther += 1;
    if (item.rejected) acc.rejected += 1;
    if (item.deferred) acc.deferred += 1;
    if (item.linksCount > 1) acc.multipleLinks += 1;
    return acc;
  }, { noConflict: 0, alreadyLinked: 0, linkedOther: 0, rejected: 0, deferred: 0, multipleLinks: 0 });
}
