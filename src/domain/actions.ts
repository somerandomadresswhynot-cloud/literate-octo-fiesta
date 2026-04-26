import { getAll, getAllByIndex, getByKey, putMany } from '../lib/db.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, GroupMemberRecord, GroupRecord, MetaRecord, WbProduct } from '../lib/types.js';
import { exportStateFiles } from './state.js';
import { isActiveLink, isDeleted, normalizeLink, normalizeWbProduct, parseBooleanLike } from '../lib/normalize.js';

const CLIENT_ID = 'local-extension';
const inFlightLinkOps = new Map<string, Promise<LinkResult>>();
let lastUndoAction: UndoableAction | null = null;

export const LINK_TYPES = ['candidate', 'exact_match', 'similar', 'competitor', 'wrong_size', 'wrong_product'] as const;
export type LinkType = typeof LINK_TYPES[number];
type ConflictResolution = 'add_second_link' | 'replace_existing';
type RejectedResolution = 'keep_rejected' | 'clear_rejected';

export type LinkResult = {
  ok: true;
  status: 'created' | 'duplicate_skipped' | 'conflict_detected' | 'rejected_confirmation_required';
  link?: AsinLink;
  existing_link_id?: string;
  existing_links?: AsinLink[];
};

type CardContext = {
  wb_sku: string;
  wb_url: string;
  seen_status: string;
  active_asin: string;
  active_links_count: number;
  active_links: Array<{ asin: string; link_type: string }>;
  rejected: boolean;
  rejected_reason: string;
  deferred: boolean;
  deferred_reason: string;
};

type UndoableAction =
  | { type: 'link_created'; wb_sku: string; asin: string; link_id: string }
  | { type: 'rejected_set'; wb_sku: string; prevRejected: string; prevReason: string }
  | { type: 'deferred_set'; wb_sku: string; prevDeferred: string; prevReason: string }
  | { type: 'group_added'; wb_sku: string; group_id: string; membership_id: string }
  | { type: 'group_removed'; wb_sku: string; group_id: string; membership_id: string };

function now(): string { return new Date().toISOString(); }
function uid(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

async function log(action: string, details?: Record<string, unknown>, level: 'info' | 'error' = 'info'): Promise<void> {
  const entry: DebugEntry = { debug_log_id: uid('dbg'), ts: now(), level, action, details };
  await putMany('debug_log', [entry]);
}

export async function setActiveAsin(asin: string): Promise<void> {
  const meta = await getMeta();
  meta.active_asin = asin;
  meta.data_revision = String(Number(meta.data_revision || '0') + 1);
  await putMany('meta', [meta]);
  await writeEvent('active_asin_changed', '', asin, { active_asin: asin });
  await log('active_asin_changed', { asin });
}

export async function setDefaultLinkType(linkType: LinkType): Promise<void> {
  const meta = await getMeta();
  meta.default_link_type = linkType;
  await putMany('meta', [meta]);
  await log('default_link_type_changed', { link_type: linkType });
}

export async function markSeenByHover(wb_sku: string, wb_url: string): Promise<void> {
  const existingEvents = await getAll<EventRecord>('events');
  if (existingEvents.some((evt) => evt.event_type === 'seen_by_hover' && evt.wb_sku === wb_sku)) return;
  const product = await upsertWbProduct(wb_sku, wb_url, { seen_status: 'seen' }, 'seen');
  await writeEvent('seen_by_hover', wb_sku, '', { wb_url, seen_status: product.seen_status });
  await log('card_hover_seen', { wb_sku });
  await log('card_state_updated', { wb_sku, seen_status: product.seen_status });
}

export async function markCardTouched(wb_sku: string, wb_url: string, source: string): Promise<void> {
  const product = await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched' }, 'touched');
  await writeEvent('card_touched', wb_sku, '', { wb_url, source, seen_status: 'touched' });
  await log('card_touched', { wb_sku, source });
  await log('card_state_updated', { wb_sku, seen_status: product.seen_status });
}

export async function linkWbSkuToActiveAsin(wb_sku: string, wb_url: string): Promise<LinkResult> {
  const meta = await getMeta();
  if (!meta.active_asin) {
    await log('link_failed_no_active_asin', { wb_sku }, 'error');
    throw new Error('No active ASIN selected');
  }
  return linkWbSkuToAsin({ wb_sku, wb_url, asin: meta.active_asin, linkType: asLinkType(meta.default_link_type), createdByAction: 'A+' });
}

export async function linkWbSkuToAsin(params: {
  wb_sku: string;
  wb_url: string;
  asin: string;
  linkType?: LinkType;
  createdByAction: 'A+' | 'add_to_asin';
  conflictResolution?: ConflictResolution;
  rejectedResolution?: RejectedResolution;
}): Promise<LinkResult> {
  const meta = await getMeta();
  const linkType = params.linkType ?? asLinkType(meta.default_link_type);
  const key = `${params.wb_sku}::${params.asin}::${linkType}::${params.conflictResolution || '-'}::${params.rejectedResolution || '-'}`;
  if (inFlightLinkOps.has(key)) return await inFlightLinkOps.get(key)!;
  const op = doCreateOrSkipLink(params.wb_sku, params.wb_url, params.asin, linkType, params.createdByAction, params.conflictResolution, params.rejectedResolution);
  inFlightLinkOps.set(key, op);
  try { return await op; } finally { inFlightLinkOps.delete(key); }
}

async function doCreateOrSkipLink(
  wb_sku: string,
  wb_url: string,
  asin: string,
  linkType: LinkType,
  createdByAction: 'A+' | 'add_to_asin',
  conflictResolution?: ConflictResolution,
  rejectedResolution?: RejectedResolution
): Promise<LinkResult> {
  const [links, wbBefore] = await Promise.all([getAllByIndex<AsinLink>('asin_links', 'wb_sku', wb_sku), getWbProduct(wb_sku)]);

  if (parseBooleanLike(wbBefore?.rejected) && !rejectedResolution) {
    await log('rejected_link_warning_shown', { wb_sku, asin });
    return { ok: true, status: 'rejected_confirmation_required' };
  }
  if (parseBooleanLike(wbBefore?.rejected) && rejectedResolution === 'clear_rejected') {
    await upsertWbProduct(wb_sku, wb_url, { rejected: 'false', rejected_reason: '' }, wbBefore?.seen_status === 'touched' ? 'touched' : 'seen');
  }

  const activeForSku = links.map(normalizeLink).filter((item) => item.wb_sku === wb_sku && isActiveLink(item));
  const existing = activeForSku.find((item) => item.asin === asin);
  if (existing) {
    await log('duplicate_link_skipped', { wb_sku, asin, existing_link_id: existing.link_id });
    await writeEvent('duplicate_link_skipped', wb_sku, asin, { existing_link_id: existing.link_id });
    return { ok: true, status: 'duplicate_skipped', existing_link_id: existing.link_id };
  }

  const conflicting = activeForSku.filter((item) => item.asin !== asin);
  if (conflicting.length > 0 && !conflictResolution) {
    await writeEvent('conflict_detected', wb_sku, asin, { existing_links: conflicting.map((x) => ({ link_id: x.link_id, asin: x.asin, link_type: x.link_type })) });
    await log('conflict_detected', { wb_sku, asin, existing_count: conflicting.length });
    return { ok: true, status: 'conflict_detected', existing_links: conflicting };
  }

  const ts = now();
  await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched' }, 'touched');

  if (conflicting.length > 0 && conflictResolution === 'replace_existing') {
    for (const old of conflicting) {
      old.is_active = 'false';
      old.deleted_at = ts;
      old.updated_at = ts;
      await putMany('asin_links', [old]);
      await writeEvent('link_deactivated', wb_sku, old.asin, { deactivated_link_id: old.link_id, reason: 'replaced' });
    }
    await writeEvent('link_replaced', wb_sku, asin, { replaced_count: conflicting.length, replaced_link_ids: conflicting.map((x) => x.link_id) });
    await log('conflict_replace_link', { wb_sku, asin, replaced_count: conflicting.length });
  }

  if (conflicting.length > 0 && conflictResolution === 'add_second_link') {
    await log('conflict_add_second_link', { wb_sku, asin, existing_count: conflicting.length });
  }

  const link: AsinLink = normalizeLink({
    link_id: uid('link'), wb_sku, asin, link_type: linkType, is_active: 'true', comment: '', created_at: ts, updated_at: ts, deleted_at: '', created_by_action: createdByAction
  });
  await putMany('asin_links', [link]);
  await writeEvent('link_created', wb_sku, asin, { wb_url, link_id: link.link_id, link_type: linkType, created_by_action: createdByAction });
  await log('link_created', { wb_sku, asin, link_type: linkType, created_by_action: createdByAction });
  await log('card_state_updated', { wb_sku, linked_to: asin });
  lastUndoAction = { type: 'link_created', wb_sku, asin, link_id: link.link_id };
  return { ok: true, status: 'created', link };
}

export async function setRejected(wb_sku: string, wb_url: string, reasonCode: string, reasonText: string): Promise<void> {
  const productBefore = await getWbProduct(wb_sku);
  const product = await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched', rejected: 'true', rejected_reason: serializeReason(reasonCode, reasonText), deferred: 'false', deferred_reason: '' }, 'touched');
  await writeEvent('rejected_set', wb_sku, '', { reason_code: reasonCode, reason_text: reasonText, wb_url });
  await log('rejected_set', { wb_sku, reason_code: reasonCode });
  await log('card_state_updated', { wb_sku, rejected: true, seen_status: product.seen_status });
  lastUndoAction = { type: 'rejected_set', wb_sku, prevRejected: productBefore?.rejected ?? 'false', prevReason: productBefore?.rejected_reason ?? '' };
}

export async function setDeferred(wb_sku: string, wb_url: string, reasonCode: string, reasonText: string): Promise<void> {
  const productBefore = await getWbProduct(wb_sku);
  const product = await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched', deferred: 'true', deferred_reason: serializeReason(reasonCode, reasonText), rejected: 'false', rejected_reason: '' }, 'touched');
  await writeEvent('deferred_set', wb_sku, '', { reason_code: reasonCode, reason_text: reasonText, wb_url });
  await log('deferred_set', { wb_sku, reason_code: reasonCode });
  await log('card_state_updated', { wb_sku, deferred: true, seen_status: product.seen_status });
  lastUndoAction = { type: 'deferred_set', wb_sku, prevDeferred: productBefore?.deferred ?? 'false', prevReason: productBefore?.deferred_reason ?? '' };
}

export async function recordLinkCopied(wb_sku: string, wb_url: string): Promise<void> {
  await writeEvent('wb_link_copied', wb_sku, '', { wb_url });
  await log('wb_link_copied', { wb_sku });
}

export async function undoLastAction(): Promise<{ undone: boolean; action?: string }> {
  if (!lastUndoAction) return { undone: false };
  const action = lastUndoAction;
  lastUndoAction = null;
  if (action.type === 'link_created') {
    const links = await getAllByIndex<AsinLink>('asin_links', 'wb_sku', action.wb_sku);
    const match = links.find((link) => link.link_id === action.link_id && link.is_active === 'true');
    if (match) {
      const ts = now();
      match.is_active = 'false'; match.deleted_at = ts; match.updated_at = ts;
      await putMany('asin_links', [match]);
    }
    await writeEvent('undo_performed', action.wb_sku, action.asin, { undone_event: 'link_created', link_id: action.link_id });
    await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'link_created' });
    await log('card_state_updated', { wb_sku: action.wb_sku, link_active: false });
    return { undone: true, action: 'link_created' };
  }

  const product = await getWbProduct(action.wb_sku);
  if (!product) return { undone: false };
  if (action.type === 'rejected_set') {
    product.rejected = action.prevRejected; product.rejected_reason = action.prevReason; product.updated_at = now();
    await putMany('wb_products', [product]);
    await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'rejected_set' });
    await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'rejected_set' });
    await log('card_state_updated', { wb_sku: action.wb_sku, rejected: product.rejected });
    return { undone: true, action: 'rejected_set' };
  }

  if (action.type === 'group_added') {
    const membership = await getByKey<GroupMemberRecord>('group_members', action.membership_id);
    if (membership && !isDeleted(membership)) {
      membership.deleted_at = now();
      membership.updated_at = now();
      await putMany('group_members', [membership]);
      await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'group_added', group_id: action.group_id, membership_id: action.membership_id }, action.group_id);
      await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'group_added', group_id: action.group_id });
      await log('card_state_updated', { wb_sku: action.wb_sku, group_removed: action.group_id });
      return { undone: true, action: 'group_added' };
    }
    return { undone: false };
  }

  if (action.type === 'group_removed') {
    const membership = await getByKey<GroupMemberRecord>('group_members', action.membership_id);
    if (membership && isDeleted(membership)) {
      membership.deleted_at = '';
      membership.updated_at = now();
      await putMany('group_members', [membership]);
      await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'group_removed', group_id: action.group_id, membership_id: action.membership_id }, action.group_id);
      await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'group_removed', group_id: action.group_id });
      await log('card_state_updated', { wb_sku: action.wb_sku, group_added: action.group_id });
      return { undone: true, action: 'group_removed' };
    }
    return { undone: false };
  }

  product.deferred = action.prevDeferred; product.deferred_reason = action.prevReason; product.updated_at = now();
  await putMany('wb_products', [product]);
  await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'deferred_set' });
  await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'deferred_set' });
  await log('card_state_updated', { wb_sku: action.wb_sku, deferred: product.deferred });
  return { undone: true, action: 'deferred_set' };
}

export async function listGroups(): Promise<Array<GroupRecord & { product_count: number; already_in_group: boolean }>> {
  const [groups, members] = await Promise.all([getAll<GroupRecord>('groups'), getAll<GroupMemberRecord>('group_members')]);
  const activeMembers = members.filter((m) => !isDeleted(m));
  const countByGroup = new Map<string, number>();
  for (const member of activeMembers) countByGroup.set(member.group_id, (countByGroup.get(member.group_id) ?? 0) + 1);
  return groups
    .filter((group) => !isDeleted(group))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.name.localeCompare(b.name))
    .map((group) => ({ ...group, product_count: countByGroup.get(group.group_id) ?? 0, already_in_group: false }));
}

export async function searchGroups(query: string): Promise<Array<GroupRecord & { product_count: number; already_in_group: boolean }>> {
  const normalized = query.trim().toLowerCase();
  const all = await listGroups();
  if (!normalized) return all;
  return all.filter((group) => [group.name, group.comment, group.group_type, group.icon].some((v) => v.toLowerCase().includes(normalized)));
}

export async function createGroup(input: { name: string; icon?: string; comment?: string; group_type?: string }): Promise<GroupRecord> {
  const ts = now();
  const row: GroupRecord = {
    group_id: uid('grp'),
    name: input.name.trim(),
    icon: (input.icon || '').trim(),
    comment: (input.comment || '').trim(),
    group_type: (input.group_type || '').trim(),
    created_at: ts,
    updated_at: ts,
    deleted_at: ''
  };
  await putMany('groups', [row]);
  await writeEvent('group_created', '', '', { group_id: row.group_id, name: row.name }, row.group_id);
  await log('group_created', { group_id: row.group_id, name: row.name });
  return row;
}

export async function addWbSkuToGroup(wb_sku: string, wb_url: string, group_id: string): Promise<{ status: 'added' | 'already_in_group'; membership?: GroupMemberRecord }> {
  await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched' }, 'touched');
  const [group, members] = await Promise.all([getByKey<GroupRecord>('groups', group_id), getAllByIndex<GroupMemberRecord>('group_members', 'group_id', group_id)]);
  if (!group || isDeleted(group)) throw new Error('Group not found');
  const existing = members.find((m) => m.group_id === group_id && m.wb_sku === wb_sku && !isDeleted(m));
  if (existing) {
    await writeEvent('duplicate_group_membership_skipped', wb_sku, '', { group_id, membership_id: existing.membership_id }, group_id);
    await log('duplicate_group_membership_skipped', { wb_sku, group_id, membership_id: existing.membership_id });
    return { status: 'already_in_group' };
  }
  const ts = now();
  const membership: GroupMemberRecord = { membership_id: uid('gmem'), group_id, wb_sku, wb_url, created_at: ts, updated_at: ts, deleted_at: '' };
  await putMany('group_members', [membership]);
  await writeEvent('group_added', wb_sku, '', { group_id, membership_id: membership.membership_id, wb_url }, group_id);
  await log('group_added', { wb_sku, group_id, membership_id: membership.membership_id });
  await log('card_state_updated', { wb_sku, group_added: group_id });
  lastUndoAction = { type: 'group_added', wb_sku, group_id, membership_id: membership.membership_id };
  return { status: 'added', membership };
}

export async function removeWbSkuFromGroup(wb_sku: string, group_id: string): Promise<{ removed: boolean; membership_id?: string }> {
  const members = await getAllByIndex<GroupMemberRecord>('group_members', 'group_id', group_id);
  const active = members.find((m) => m.wb_sku === wb_sku && !isDeleted(m));
  if (!active) return { removed: false };
  active.deleted_at = now();
  active.updated_at = now();
  await putMany('group_members', [active]);
  await writeEvent('group_removed', wb_sku, '', { group_id, membership_id: active.membership_id }, group_id);
  await log('group_removed', { wb_sku, group_id, membership_id: active.membership_id });
  await log('card_state_updated', { wb_sku, group_removed: group_id });
  lastUndoAction = { type: 'group_removed', wb_sku, group_id, membership_id: active.membership_id };
  return { removed: true, membership_id: active.membership_id };
}

export async function getGroupsForWbSku(wb_sku: string): Promise<Array<GroupRecord & { membership_id: string }>> {
  const [groups, members] = await Promise.all([getAll<GroupRecord>('groups'), getAllByIndex<GroupMemberRecord>('group_members', 'wb_sku', wb_sku)]);
  const groupById = new Map(groups.filter((g) => !isDeleted(g)).map((g) => [g.group_id, g]));
  return members
    .filter((m) => !isDeleted(m))
    .map((m) => {
      const group = groupById.get(m.group_id);
      if (!group) return null;
      return { membership_id: m.membership_id, ...group };
    })
    .filter((x): x is GroupRecord & { membership_id: string } => Boolean(x))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCardState(wb_sku: string): Promise<{ linked: boolean; activeAsinLinked: boolean; activeAsin: string; seenStatus: string; rejected: boolean; deferred: boolean; conflictPotential: boolean; groupCount: number; groupPreview: string[] }> {
  const [links, meta, wb, skuGroups] = await Promise.all([getAllByIndex<AsinLink>('asin_links', 'wb_sku', wb_sku), getMeta(), getWbProduct(wb_sku), getGroupsForWbSku(wb_sku)]);
  const skuLinks = links.map(normalizeLink).filter((item) => item.wb_sku === wb_sku && isActiveLink(item));
  const activeAsinLinked = skuLinks.some((item) => item.asin === meta.active_asin);
  return {
    linked: skuLinks.length > 0,
    activeAsinLinked,
    activeAsin: meta.active_asin,
    seenStatus: wb?.seen_status ?? '',
    rejected: parseBooleanLike(wb?.rejected),
    deferred: parseBooleanLike(wb?.deferred),
    conflictPotential: Boolean(meta.active_asin) && !activeAsinLinked && skuLinks.length > 0,
    groupCount: skuGroups.length,
    groupPreview: skuGroups.slice(0, 3).map((g) => g.name)
  };
}

export async function getCardContext(wb_sku: string, wb_url: string): Promise<CardContext> {
  const state = await getCardState(wb_sku);
  const links = await getAllByIndex<AsinLink>('asin_links', 'wb_sku', wb_sku);
  const wb = await upsertWbProduct(wb_sku, wb_url, {}, state.seenStatus === 'touched' ? 'touched' : 'seen');
  const activeLinks = links.map(normalizeLink).filter((item) => item.wb_sku === wb_sku && isActiveLink(item));
  return { wb_sku, wb_url, seen_status: wb.seen_status, active_asin: state.activeAsin, active_links_count: activeLinks.length, active_links: activeLinks.map((item) => ({ asin: item.asin, link_type: item.link_type })), rejected: parseBooleanLike(wb.rejected), rejected_reason: wb.rejected_reason, deferred: parseBooleanLike(wb.deferred), deferred_reason: wb.deferred_reason };
}

export async function exportCsvState(): Promise<Record<string, string>> { const result = await exportStateFiles(); await writeEvent('export', '', (await getMeta()).active_asin, { file_count: Object.keys(result.files).length }); return result.files; }

export async function importAmazonProducts(rows: AmazonProduct[]): Promise<void> {
  await putMany('amazon_products', rows);
  const meta = await getMeta();
  meta.last_imported_at = now();
  await putMany('meta', [meta]);
  await writeEvent('import', '', meta.active_asin, { imported_count: rows.length });
  await log('import_amazon_products', { count: rows.length });
}

export async function getMeta(): Promise<MetaRecord> {
  const records = await getAll<MetaRecord>('meta');
  return records[0] ?? { schema_version: '1', data_revision: '1', active_asin: '', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '', verbose_scan_logging: 'false' };
}

async function getWbProduct(wb_sku: string): Promise<WbProduct | undefined> {
  return await getByKey<WbProduct>('wb_products', wb_sku);
}

async function upsertWbProduct(wb_sku: string, wb_url: string, updates: Partial<Pick<WbProduct, 'seen_status' | 'rejected' | 'rejected_reason' | 'deferred' | 'deferred_reason'>>, seenFallback: 'seen' | 'touched'): Promise<WbProduct> {
  const current = await getWbProduct(wb_sku);
  const ts = now();
  const seen = updates.seen_status ?? current?.seen_status ?? seenFallback;
  const next: WbProduct = normalizeWbProduct({
    wb_sku,
    wb_url: wb_url || current?.wb_url || '',
    seen_status: seen,
    first_seen_at: current?.first_seen_at || ts,
    last_seen_at: seen === 'seen' || seen === 'touched' ? ts : current?.last_seen_at || ts,
    last_touched_at: seen === 'touched' ? ts : current?.last_touched_at || '',
    rejected: updates.rejected ?? current?.rejected ?? 'false',
    rejected_reason: updates.rejected_reason ?? current?.rejected_reason ?? '',
    deferred: updates.deferred ?? current?.deferred ?? 'false',
    deferred_reason: updates.deferred_reason ?? current?.deferred_reason ?? '',
    created_at: current?.created_at || ts,
    updated_at: ts,
    deleted_at: current?.deleted_at || ''
  });
  await putMany('wb_products', [next]);
  return next;
}

function asLinkType(value: string): LinkType { return (LINK_TYPES as readonly string[]).includes(value) ? value as LinkType : 'candidate'; }
function serializeReason(code: string, text: string): string { if (!text.trim()) return code; return `${code}: ${text.trim()}`; }


export type BulkConflictResolution = 'skip_conflicts' | 'add_second_link' | 'replace_existing';
export type BulkSummary = { total: number; succeeded: number; skipped: number; duplicates: number; conflicts: number; errors: number; rejected: number; deferred: number };

function emptyBulkSummary(total: number): BulkSummary { return { total, succeeded: 0, skipped: 0, duplicates: 0, conflicts: 0, errors: 0, rejected: 0, deferred: 0 }; }

async function writeBulkBoundaryEvent(eventType: 'bulk_action_started' | 'bulk_action_completed' | 'bulk_action_failed', action: string, summary: BulkSummary, extra: Record<string, unknown> = {}): Promise<void> {
  await writeEvent(eventType, '', '', { action, ...summary, ...extra });
  await log(eventType, { action, ...summary, ...extra }, eventType === 'bulk_action_failed' ? 'error' : 'info');
}

export async function bulkLinkToSelectedAsin(
  wbItems: Array<{ wb_sku: string; wb_url: string }>,
  asin: string,
  linkType: LinkType,
  conflictResolution: BulkConflictResolution,
  rejectedResolution: RejectedResolution = 'keep_rejected'
): Promise<BulkSummary> {
  const summary = emptyBulkSummary(wbItems.length);
  await writeBulkBoundaryEvent('bulk_action_started', 'bulk_link_to_selected_asin', summary, { asin, link_type: linkType, conflictResolution });
  try {
    for (const item of wbItems) {
      try {
        const result = await linkWbSkuToAsin({
          wb_sku: item.wb_sku,
          wb_url: item.wb_url,
          asin,
          linkType,
          createdByAction: 'add_to_asin',
          conflictResolution: conflictResolution === 'skip_conflicts' ? undefined : (conflictResolution as ConflictResolution),
          rejectedResolution
        });
        const wb = await getWbProduct(item.wb_sku);
        if (parseBooleanLike(wb?.rejected)) summary.rejected += 1;
        if (parseBooleanLike(wb?.deferred)) summary.deferred += 1;
        if (result.status === 'created') summary.succeeded += 1;
        else if (result.status === 'duplicate_skipped') { summary.skipped += 1; summary.duplicates += 1; }
        else if (result.status === 'conflict_detected' || result.status === 'rejected_confirmation_required') { summary.skipped += 1; summary.conflicts += 1; }
        else summary.skipped += 1;
      } catch {
        summary.errors += 1;
      }
    }
    await writeBulkBoundaryEvent('bulk_action_completed', 'bulk_link_to_selected_asin', summary, { asin, link_type: linkType, conflictResolution });
    return summary;
  } catch (error) {
    await writeBulkBoundaryEvent('bulk_action_failed', 'bulk_link_to_selected_asin', summary, { asin, error: String(error) });
    throw error;
  }
}

export async function bulkLinkToActiveAsin(
  wbItems: Array<{ wb_sku: string; wb_url: string }>,
  linkType: LinkType,
  conflictResolution: BulkConflictResolution,
  rejectedResolution: RejectedResolution = 'keep_rejected'
): Promise<BulkSummary> {
  const meta = await getMeta();
  if (!meta.active_asin) throw new Error('No active ASIN selected');
  return await bulkLinkToSelectedAsin(wbItems, meta.active_asin, linkType, conflictResolution, rejectedResolution);
}

export async function bulkAddToGroup(wbItems: Array<{ wb_sku: string; wb_url: string }>, group_id: string): Promise<BulkSummary> {
  const summary = emptyBulkSummary(wbItems.length);
  await writeBulkBoundaryEvent('bulk_action_started', 'bulk_add_to_group', summary, { group_id });
  for (const item of wbItems) {
    try {
      const res = await addWbSkuToGroup(item.wb_sku, item.wb_url, group_id);
      if (res.status === 'added') summary.succeeded += 1;
      else { summary.skipped += 1; summary.duplicates += 1; }
    } catch {
      summary.errors += 1;
    }
  }
  await writeBulkBoundaryEvent('bulk_action_completed', 'bulk_add_to_group', summary, { group_id });
  return summary;
}

export async function bulkReject(wbItems: Array<{ wb_sku: string; wb_url: string }>, reasonCode: string, reasonText: string): Promise<BulkSummary> {
  const summary = emptyBulkSummary(wbItems.length);
  await writeBulkBoundaryEvent('bulk_action_started', 'bulk_reject', summary, { reasonCode });
  for (const item of wbItems) {
    try {
      await setRejected(item.wb_sku, item.wb_url, reasonCode, reasonText);
      summary.succeeded += 1;
      summary.rejected += 1;
    } catch {
      summary.errors += 1;
    }
  }
  await writeBulkBoundaryEvent('bulk_action_completed', 'bulk_reject', summary, { reasonCode });
  return summary;
}

export async function bulkDefer(wbItems: Array<{ wb_sku: string; wb_url: string }>, reasonCode: string, reasonText: string): Promise<BulkSummary> {
  const summary = emptyBulkSummary(wbItems.length);
  await writeBulkBoundaryEvent('bulk_action_started', 'bulk_defer', summary, { reasonCode });
  for (const item of wbItems) {
    try {
      await setDeferred(item.wb_sku, item.wb_url, reasonCode, reasonText);
      summary.succeeded += 1;
      summary.deferred += 1;
    } catch {
      summary.errors += 1;
    }
  }
  await writeBulkBoundaryEvent('bulk_action_completed', 'bulk_defer', summary, { reasonCode });
  return summary;
}

export async function getHistoryBySku(wb_sku: string, limit = 100): Promise<{ events: EventRecord[]; hasMore: boolean }> {
  const events = (await getAllByIndex<EventRecord>('events', 'wb_sku', wb_sku))
    .filter((evt) => evt.wb_sku === wb_sku)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { events: events.slice(0, limit), hasMore: events.length > limit };
}

async function writeEvent(event_type: string, wb_sku: string, asin: string, payload: Record<string, unknown>, group_id = ''): Promise<void> {
  const event: EventRecord = { event_id: uid('evt'), operation_id: uid('op'), event_type, wb_sku, asin, group_id, payload_json: JSON.stringify(payload), created_at: now(), client_id: CLIENT_ID };
  await putMany('events', [event]);
}
