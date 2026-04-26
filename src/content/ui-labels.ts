export const LINK_TYPE_LABELS: Record<string, string> = {
  candidate: 'Candidate',
  exact_match: 'Exact match',
  similar: 'Similar',
  competitor: 'Competitor',
  wrong_size: 'Wrong size / variant',
  wrong_product: 'Wrong product'
};

export const LINK_TYPE_HINTS: Record<string, string> = {
  candidate: 'Needs later review',
  exact_match: 'Looks like the same product',
  similar: 'Similar but not necessarily identical',
  competitor: 'Useful competitor/analogue',
  wrong_size: 'Similar product, wrong size/variant',
  wrong_product: 'Known non-match for this ASIN'
};

export const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  candidates_found: 'Candidates found',
  exact_match_found: 'Exact match found',
  similar_found: 'Similar found',
  competitors_found: 'Competitors found',
  not_found: 'Not found',
  deferred: 'Deferred',
  done: 'Done',
  archived: 'Archived'
};

export function toLinkTypeLabel(linkType: string): string {
  return LINK_TYPE_LABELS[linkType] ?? linkType;
}

export function toLinkTypeHint(linkType: string): string {
  return LINK_TYPE_HINTS[linkType] ?? '';
}

export function toWorkflowStatusLabel(status: string): string {
  return WORKFLOW_STATUS_LABELS[status] ?? status ?? '—';
}

export function statsLabel(key: 'linkedActive' | 'linkedTotal'): string {
  if (key === 'linkedActive') return 'Linked to active';
  return 'Linked total';
}
