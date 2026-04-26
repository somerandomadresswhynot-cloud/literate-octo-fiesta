import { getAll, putMany } from '../lib/db.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from '../lib/types.js';
import { exportStateFiles } from './state.js';

const CLIENT_ID = 'local-extension';
const inFlightLinkOps = new Map<string, Promise<LinkResult>>();

export type LinkResult = {
  ok: true;
  status: 'created' | 'duplicate_skipped';
  link?: AsinLink;
  existing_link_id?: string;
};

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
  return { ok: true, status: 'created', link };
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
