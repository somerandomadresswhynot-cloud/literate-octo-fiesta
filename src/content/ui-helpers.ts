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

export function normalizeCardControlsCount(existingCount: number): { shouldCreate: boolean; shouldTrimDuplicates: boolean } {
  return {
    shouldCreate: existingCount === 0,
    shouldTrimDuplicates: existingCount > 1
  };
}

export function computeFloatingMenuPosition(input: { left: number; bottom: number; viewportWidth: number }): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(input.left, input.viewportWidth - 220)),
    top: input.bottom + 4
  };
}

export type CardControlsPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export function computeCardControlsPositionStyle(placement: CardControlsPlacement, xOffset: number, yOffset: number): { left: string; right: string; top: string; bottom: string } {
  const x = `${Math.max(0, xOffset)}px`;
  const y = `${Math.max(0, yOffset)}px`;
  if (placement === 'top-right') return { left: 'auto', right: x, top: y, bottom: 'auto' };
  if (placement === 'bottom-left') return { left: x, right: 'auto', top: 'auto', bottom: y };
  if (placement === 'bottom-right') return { left: 'auto', right: x, top: 'auto', bottom: y };
  return { left: x, right: 'auto', top: y, bottom: 'auto' };
}

export function shouldReparentCardControls(cardLastElementIsControls: boolean): boolean {
  return !cardLastElementIsControls;
}

export function toDocumentCoordinates(rect: { top: number; left: number }, scrollX: number, scrollY: number): { top: number; left: number } {
  return { top: rect.top + scrollY, left: rect.left + scrollX };
}

export function computeAbsoluteControlPlacement(
  placement: CardControlsPlacement,
  cardRect: { width: number; height: number },
  docOrigin: { top: number; left: number },
  controlsSize: { width: number; height: number },
  offsets: { x: number; y: number }
): { top: number; left: number } {
  if (placement === 'top-right') return { top: docOrigin.top + offsets.y, left: docOrigin.left + cardRect.width - controlsSize.width - offsets.x };
  if (placement === 'bottom-left') return { top: docOrigin.top + cardRect.height - controlsSize.height - offsets.y, left: docOrigin.left + offsets.x };
  if (placement === 'bottom-right') return { top: docOrigin.top + cardRect.height - controlsSize.height - offsets.y, left: docOrigin.left + cardRect.width - controlsSize.width - offsets.x };
  return { top: docOrigin.top + offsets.y, left: docOrigin.left + offsets.x };
}

export function cardControlsRootStyle(): string {
  return 'position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;pointer-events:none !important;z-index:2147483647 !important;isolation:isolate !important;';
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
