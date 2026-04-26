export const REJECT_REASONS = ['wrong_product', 'wrong_size', 'other_brand', 'bad_candidate', 'duplicate', 'not_interesting', 'other'] as const;
export const DEFER_REASONS = ['compare_size', 'check_photo', 'unsure_match', 'check_seller', 'other'] as const;

export function buildReasonPayload(reasonCode: string, reasonText: string): { reasonCode: string; reasonText: string } {
  return { reasonCode: reasonCode.trim(), reasonText: reasonText.trim() };
}

export function mapConflictResolution(decision: 'cancel' | 'add_second_link' | 'replace_existing'): 'add_second_link' | 'replace_existing' | null {
  if (decision === 'cancel') return null;
  return decision;
}
