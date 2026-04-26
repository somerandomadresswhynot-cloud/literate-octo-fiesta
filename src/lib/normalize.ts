import type { AsinLink, WbProduct } from './types.js';

export function parseBooleanLike(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  return false;
}

export function booleanToCsvString(value: unknown): 'true' | 'false' {
  return parseBooleanLike(value) ? 'true' : 'false';
}

export function isDeleted(row: { deleted_at?: unknown }): boolean {
  return typeof row.deleted_at === 'string' && row.deleted_at.trim().length > 0;
}

export function isActiveLink(link: Partial<AsinLink>): boolean {
  return parseBooleanLike(link.is_active) && !isDeleted(link);
}

export function normalizeLink(row: Partial<AsinLink>): AsinLink {
  return {
    link_id: String(row.link_id || ''),
    wb_sku: String(row.wb_sku || ''),
    asin: String(row.asin || ''),
    link_type: String(row.link_type || 'candidate'),
    is_active: booleanToCsvString(row.is_active),
    comment: String(row.comment || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    deleted_at: String(row.deleted_at || ''),
    created_by_action: String(row.created_by_action || '')
  };
}

export function normalizeWbProduct(row: Partial<WbProduct>): WbProduct {
  return {
    wb_sku: String(row.wb_sku || ''),
    wb_url: String(row.wb_url || ''),
    seen_status: String(row.seen_status || ''),
    first_seen_at: String(row.first_seen_at || ''),
    last_seen_at: String(row.last_seen_at || ''),
    last_touched_at: String(row.last_touched_at || ''),
    rejected: booleanToCsvString(row.rejected),
    rejected_reason: String(row.rejected_reason || ''),
    deferred: booleanToCsvString(row.deferred),
    deferred_reason: String(row.deferred_reason || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    deleted_at: String(row.deleted_at || '')
  };
}
