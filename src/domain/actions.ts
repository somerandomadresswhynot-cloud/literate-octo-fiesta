import { getAll, putMany } from '../lib/db.js';
import { toCsv } from '../lib/csv.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from '../lib/types.js';

const CLIENT_ID = 'local-extension';

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

export async function linkWbSkuToActiveAsin(wb_sku: string, wb_url: string): Promise<AsinLink> {
  const meta = await getMeta();
  if (!meta.active_asin) {
    await log('link_failed_no_active_asin', { wb_sku }, 'error');
    throw new Error('No active ASIN selected');
  }

  const ts = now();
  const wbProduct: WbProduct = {
    wb_sku,
    wb_url,
    seen_status: 'seen',
    first_seen_at: ts,
    last_seen_at: ts,
    last_touched_at: ts,
    rejected: 'false',
    rejected_reason: '',
    deferred: 'false',
    deferred_reason: '',
    created_at: ts,
    updated_at: ts,
    deleted_at: ''
  };
  await putMany('wb_products', [wbProduct]);

  const link: AsinLink = {
    link_id: uid('link'),
    wb_sku,
    asin: meta.active_asin,
    link_type: meta.default_link_type || 'candidate',
    is_active: 'true',
    comment: '',
    created_at: ts,
    updated_at: ts,
    deleted_at: '',
    created_by_action: 'A+'
  };
  await putMany('asin_links', [link]);
  await writeEvent('link_created', wb_sku, meta.active_asin, { wb_url, link_id: link.link_id });
  await log('link_created', { wb_sku, asin: meta.active_asin });
  return link;
}

export async function getCardState(wb_sku: string): Promise<{ linked: boolean; activeAsinLinked: boolean; activeAsin: string }> {
  const links = await getAll<AsinLink>('asin_links');
  const meta = await getMeta();
  const skuLinks = links.filter((item) => item.wb_sku === wb_sku && item.is_active === 'true' && !item.deleted_at);
  return {
    linked: skuLinks.length > 0,
    activeAsinLinked: skuLinks.some((item) => item.asin === meta.active_asin),
    activeAsin: meta.active_asin
  };
}

export async function exportCsvState(): Promise<Record<string, string>> {
  const amazon = await getAll<AmazonProduct>('amazon_products');
  const wb = await getAll<WbProduct>('wb_products');
  const links = await getAll<AsinLink>('asin_links');
  const events = await getAll<EventRecord>('events');
  const meta = await getMeta();
  const debugLog = await getAll<DebugEntry>('debug_log');

  meta.last_exported_at = now();
  await putMany('meta', [meta]);
  await writeEvent('export', '', meta.active_asin, { counts: { amazon: amazon.length, wb: wb.length, links: links.length, events: events.length } });

  const files: Record<string, string> = {
    'wb_products.csv': toCsv(wb as unknown as Record<string, string>[], wbHeaders),
    'asin_links.csv': toCsv(links as unknown as Record<string, string>[], asinLinkHeaders),
    'events.csv': toCsv(events as unknown as Record<string, string>[], eventHeaders),
    'meta.json': JSON.stringify(meta, null, 2),
    'debug_log.json': JSON.stringify({
      generated_at: now(),
      active_asin: meta.active_asin,
      counts: { amazon: amazon.length, wb: wb.length, links: links.length, events: events.length },
      recent_actions: debugLog.slice(-50),
      errors: debugLog.filter((entry) => entry.level === 'error').slice(-20)
    }, null, 2)
  };
  await log('export', { file_count: Object.keys(files).length });
  return files;
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
    last_imported_at: '',
    last_exported_at: ''
  };
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

const wbHeaders = ['wb_sku', 'wb_url', 'seen_status', 'first_seen_at', 'last_seen_at', 'last_touched_at', 'rejected', 'rejected_reason', 'deferred', 'deferred_reason', 'created_at', 'updated_at', 'deleted_at'];
const asinLinkHeaders = ['link_id', 'wb_sku', 'asin', 'link_type', 'is_active', 'comment', 'created_at', 'updated_at', 'deleted_at', 'created_by_action'];
const eventHeaders = ['event_id', 'operation_id', 'event_type', 'wb_sku', 'asin', 'group_id', 'payload_json', 'created_at', 'client_id'];
