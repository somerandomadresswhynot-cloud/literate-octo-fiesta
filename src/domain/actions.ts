import { getAll, putMany } from '../lib/db.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from '../lib/types.js';
import { exportStateFiles } from './state.js';

const CLIENT_ID = 'local-extension';
const inFlightLinkOps = new Map<string, Promise<LinkResult>>();
let lastUndoAction: UndoableAction | null = null;

export type LinkResult = {
  ok: true;
  status: 'created' | 'duplicate_skipped';
  link?: AsinLink;
  existing_link_id?: string;
};

type CardContext = {
  wb_sku: string;
  wb_url: string;
  seen_status: string;
  active_asin: string;
  active_links_count: number;
  rejected: boolean;
  deferred: boolean;
};

type UndoableAction =
  | { type: 'link_created'; wb_sku: string; asin: string; link_id: string }
  | { type: 'rejected_set'; wb_sku: string; prevRejected: string; prevReason: string }
  | { type: 'deferred_set'; wb_sku: string; prevDeferred: string; prevReason: string };

function now(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function log(action: string, details?: Record<string, unknown>, level: 'info' | 'error' = 'info'): Promise<void> {
  const entry: DebugEntry = { ts: now(), level, action, details };
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

export async function markSeenByHover(wb_sku: string, wb_url: string): Promise<void> {
  const existingEvents = await getAll<EventRecord>('events');
  if (existingEvents.some((evt) => evt.event_type === 'seen_by_hover' && evt.wb_sku === wb_sku)) {
    return;
  }

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

  const key = `${wb_sku}::${meta.active_asin}`;
  if (inFlightLinkOps.has(key)) {
    return await inFlightLinkOps.get(key)!;
  }

  const op = doCreateOrSkipLink(wb_sku, wb_url, meta.active_asin, meta.default_link_type || 'candidate');
  inFlightLinkOps.set(key, op);
  try {
    return await op;
  } finally {
    inFlightLinkOps.delete(key);
  }
}

async function doCreateOrSkipLink(wb_sku: string, wb_url: string, asin: string, defaultLinkType: string): Promise<LinkResult> {
  const existing = (await getAll<AsinLink>('asin_links')).find((item) => item.wb_sku === wb_sku && item.asin === asin && item.is_active === 'true' && !item.deleted_at);
  if (existing) {
    await log('duplicate_link_skipped', { wb_sku, asin, existing_link_id: existing.link_id });
    return { ok: true, status: 'duplicate_skipped', existing_link_id: existing.link_id };
  }

  const ts = now();
  await upsertWbProduct(wb_sku, wb_url, { seen_status: 'touched' }, 'touched');

  const link: AsinLink = {
    link_id: uid('link'),
    wb_sku,
    asin,
    link_type: defaultLinkType,
    is_active: 'true',
    comment: '',
    created_at: ts,
    updated_at: ts,
    deleted_at: '',
    created_by_action: 'A+'
  };
  await putMany('asin_links', [link]);
  await writeEvent('link_created', wb_sku, asin, { wb_url, link_id: link.link_id });
  await log('link_created', { wb_sku, asin });
  await log('card_state_updated', { wb_sku, linked_to: asin });
  lastUndoAction = { type: 'link_created', wb_sku, asin, link_id: link.link_id };
  return { ok: true, status: 'created', link };
}

export async function setRejected(wb_sku: string, wb_url: string, reasonCode: string, reasonText: string): Promise<void> {
  const productBefore = await getWbProduct(wb_sku);
  const product = await upsertWbProduct(wb_sku, wb_url, {
    seen_status: 'touched',
    rejected: 'true',
    rejected_reason: serializeReason(reasonCode, reasonText),
    deferred: 'false',
    deferred_reason: ''
  }, 'touched');

  await writeEvent('rejected_set', wb_sku, '', { reason_code: reasonCode, reason_text: reasonText, wb_url });
  await log('rejected_set', { wb_sku, reason_code: reasonCode });
  await log('card_state_updated', { wb_sku, rejected: true, seen_status: product.seen_status });
  lastUndoAction = {
    type: 'rejected_set',
    wb_sku,
    prevRejected: productBefore?.rejected ?? 'false',
    prevReason: productBefore?.rejected_reason ?? ''
  };
}

export async function setDeferred(wb_sku: string, wb_url: string, reasonCode: string, reasonText: string): Promise<void> {
  const productBefore = await getWbProduct(wb_sku);
  const product = await upsertWbProduct(wb_sku, wb_url, {
    seen_status: 'touched',
    deferred: 'true',
    deferred_reason: serializeReason(reasonCode, reasonText),
    rejected: 'false',
    rejected_reason: ''
  }, 'touched');

  await writeEvent('deferred_set', wb_sku, '', { reason_code: reasonCode, reason_text: reasonText, wb_url });
  await log('deferred_set', { wb_sku, reason_code: reasonCode });
  await log('card_state_updated', { wb_sku, deferred: true, seen_status: product.seen_status });
  lastUndoAction = {
    type: 'deferred_set',
    wb_sku,
    prevDeferred: productBefore?.deferred ?? 'false',
    prevReason: productBefore?.deferred_reason ?? ''
  };
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
    const links = await getAll<AsinLink>('asin_links');
    const match = links.find((link) => link.link_id === action.link_id && link.is_active === 'true');
    if (match) {
      const ts = now();
      match.is_active = 'false';
      match.deleted_at = ts;
      match.updated_at = ts;
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
    product.rejected = action.prevRejected;
    product.rejected_reason = action.prevReason;
    product.updated_at = now();
    await putMany('wb_products', [product]);
    await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'rejected_set' });
    await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'rejected_set' });
    await log('card_state_updated', { wb_sku: action.wb_sku, rejected: product.rejected });
    return { undone: true, action: 'rejected_set' };
  }

  product.deferred = action.prevDeferred;
  product.deferred_reason = action.prevReason;
  product.updated_at = now();
  await putMany('wb_products', [product]);
  await writeEvent('undo_performed', action.wb_sku, '', { undone_event: 'deferred_set' });
  await log('undo_performed', { wb_sku: action.wb_sku, undone_event: 'deferred_set' });
  await log('card_state_updated', { wb_sku: action.wb_sku, deferred: product.deferred });
  return { undone: true, action: 'deferred_set' };
}

export async function getCardState(wb_sku: string): Promise<{ linked: boolean; activeAsinLinked: boolean; activeAsin: string; seenStatus: string; rejected: boolean; deferred: boolean }> {
  const links = await getAll<AsinLink>('asin_links');
  const meta = await getMeta();
  const wb = await getWbProduct(wb_sku);
  const skuLinks = links.filter((item) => item.wb_sku === wb_sku && item.is_active === 'true' && !item.deleted_at);
  return {
    linked: skuLinks.length > 0,
    activeAsinLinked: skuLinks.some((item) => item.asin === meta.active_asin),
    activeAsin: meta.active_asin,
    seenStatus: wb?.seen_status ?? '',
    rejected: wb?.rejected === 'true',
    deferred: wb?.deferred === 'true'
  };
}

export async function getCardContext(wb_sku: string, wb_url: string): Promise<CardContext> {
  const state = await getCardState(wb_sku);
  const links = await getAll<AsinLink>('asin_links');
  const wb = await upsertWbProduct(wb_sku, wb_url, {}, state.seenStatus === 'touched' ? 'touched' : 'seen');
  return {
    wb_sku,
    wb_url,
    seen_status: wb.seen_status,
    active_asin: state.activeAsin,
    active_links_count: links.filter((item) => item.wb_sku === wb_sku && item.is_active === 'true' && !item.deleted_at).length,
    rejected: wb.rejected === 'true',
    deferred: wb.deferred === 'true'
  };
}

export async function exportCsvState(): Promise<Record<string, string>> {
  const result = await exportStateFiles();
  await writeEvent('export', '', (await getMeta()).active_asin, { file_count: Object.keys(result.files).length });
  return result.files;
}

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
  return records[0] ?? {
    schema_version: '1',
    data_revision: '1',
    active_asin: '',
    default_link_type: 'candidate',
    overlay_position: 'top-left',
    last_imported_at: '',
    last_exported_at: '',
    verbose_scan_logging: 'false'
  };
}

async function getWbProduct(wb_sku: string): Promise<WbProduct | undefined> {
  const rows = await getAll<WbProduct>('wb_products');
  return rows.find((item) => item.wb_sku === wb_sku);
}

async function upsertWbProduct(
  wb_sku: string,
  wb_url: string,
  updates: Partial<Pick<WbProduct, 'seen_status' | 'rejected' | 'rejected_reason' | 'deferred' | 'deferred_reason'>>,
  seenFallback: 'seen' | 'touched'
): Promise<WbProduct> {
  const current = await getWbProduct(wb_sku);
  const ts = now();
  const seen = updates.seen_status ?? current?.seen_status ?? seenFallback;
  const next: WbProduct = {
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
  };
  await putMany('wb_products', [next]);
  return next;
}

function serializeReason(code: string, text: string): string {
  if (!text.trim()) return code;
  return `${code}: ${text.trim()}`;
}

async function writeEvent(event_type: string, wb_sku: string, asin: string, payload: Record<string, unknown>): Promise<void> {
  const event: EventRecord = {
    event_id: uid('evt'),
    operation_id: uid('op'),
    event_type,
    wb_sku,
    asin,
    group_id: '',
    payload_json: JSON.stringify(payload),
    created_at: now(),
    client_id: CLIENT_ID
  };
  await putMany('events', [event]);
}
