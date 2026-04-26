import { parseCsv, toCsv } from '../lib/csv.js';
import { clearDb, clearStore, getAll, putMany } from '../lib/db.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, GroupMemberRecord, GroupRecord, MetaRecord, WbProduct } from '../lib/types.js';
import { getMeta } from './actions.js';

type FileMap = Record<string, string>;
type StoreKey = 'amazon_products' | 'wb_products' | 'asin_links' | 'groups' | 'group_members' | 'events';

type ImportSummary = {
  imported: Record<StoreKey, number>;
  skipped_rows: number;
  warning_count: number;
  error_count: number;
  warnings: string[];
  errors: string[];
};

const headers: Record<StoreKey, string[]> = {
  amazon_products: ['asin', 'amazon_url', 'title', 'brand', 'image_url', 'category', 'keywords', 'comment', 'priority', 'workflow_status', 'checked_result', 'last_checked_at', 'created_at', 'updated_at'],
  wb_products: ['wb_sku', 'wb_url', 'seen_status', 'first_seen_at', 'last_seen_at', 'last_touched_at', 'rejected', 'rejected_reason', 'deferred', 'deferred_reason', 'created_at', 'updated_at', 'deleted_at'],
  asin_links: ['link_id', 'wb_sku', 'asin', 'link_type', 'is_active', 'comment', 'created_at', 'updated_at', 'deleted_at', 'created_by_action'],
  groups: ['group_id', 'name', 'description', 'created_at', 'updated_at', 'deleted_at'],
  group_members: ['member_id', 'group_id', 'wb_sku', 'created_at', 'updated_at', 'deleted_at'],
  events: ['event_id', 'operation_id', 'event_type', 'wb_sku', 'asin', 'group_id', 'payload_json', 'created_at', 'client_id']
};

function now(): string { return new Date().toISOString(); }

export function getBackupBaseName(ts = now()): string {
  return `wb-asin-backup-${ts.replace(/:/g, '-')}`;
}

export async function exportStateFiles(): Promise<{ files: FileMap; name: string }> {
  await writeDebug('export_bundle_started');
  const [amazon, wb, links, groups, groupMembers, events, debugLog] = await Promise.all([
    getAll<AmazonProduct>('amazon_products'),
    getAll<WbProduct>('wb_products'),
    getAll<AsinLink>('asin_links'),
    getAll<GroupRecord>('groups'),
    getAll<GroupMemberRecord>('group_members'),
    getAll<EventRecord>('events'),
    getAll<DebugEntry>('debug_log')
  ]);
  const meta = await getMeta();
  meta.last_exported_at = now();
  await putMany('meta', [meta]);

  const files: FileMap = {
    'amazon_products.csv': toCsv(amazon as unknown as Record<string, string>[], headers.amazon_products),
    'wb_products.csv': toCsv(wb as unknown as Record<string, string>[], headers.wb_products),
    'asin_links.csv': toCsv(links as unknown as Record<string, string>[], headers.asin_links),
    'groups.csv': toCsv(groups as unknown as Record<string, string>[], headers.groups),
    'group_members.csv': toCsv(groupMembers as unknown as Record<string, string>[], headers.group_members),
    'events.csv': toCsv(events as unknown as Record<string, string>[], headers.events),
    'meta.json': JSON.stringify(meta, null, 2),
    'debug_log.json': JSON.stringify({
      generated_at: now(),
      extension_version: chrome.runtime.getManifest().version,
      active_asin: meta.active_asin,
      counts: { amazon_products: amazon.length, wb_products: wb.length, asin_links: links.length, groups: groups.length, group_members: groupMembers.length, events: events.length },
      last_imported_at: meta.last_imported_at,
      last_exported_at: meta.last_exported_at,
      recent_actions: debugLog.slice(-100),
      recent_errors: debugLog.filter((item) => item.level === 'error').slice(-25),
      validation_warnings: []
    }, null, 2)
  };

  await writeDebug('export_bundle_completed', { file_count: Object.keys(files).length });
  return { files, name: getBackupBaseName() };
}

export async function importStateFiles(files: FileMap, mode: 'import' | 'restore'): Promise<ImportSummary> {
  await writeDebug(mode === 'restore' ? 'restore_started' : 'import_state_started', { files: Object.keys(files) });
  const summary: ImportSummary = {
    imported: { amazon_products: 0, wb_products: 0, asin_links: 0, groups: 0, group_members: 0, events: 0 },
    skipped_rows: 0,
    warning_count: 0,
    error_count: 0,
    warnings: [],
    errors: []
  };

  const parsed: Partial<Record<StoreKey, Record<string, string>[]>> = {};
  for (const [store, filename] of Object.entries(fileMapByStore()) as [StoreKey, string][]) {
    if (!files[filename]) continue;
    const rows = parseCsv(files[filename]);
    parsed[store] = rows;
    validateHeaders(store, rows, summary);
  }

  let importedMeta: MetaRecord | null = null;
  if (files['meta.json']) {
    try {
      importedMeta = JSON.parse(files['meta.json']) as MetaRecord;
      if (!importedMeta || typeof importedMeta !== 'object') throw new Error('meta root must be object');
    } catch (error) {
      summary.errors.push(`invalid meta.json: ${String(error)}`);
      summary.error_count += 1;
      await writeDebug('import_state_error', { error: String(error) }, 'error');
    }
  }

  const amazonRows = (parsed.amazon_products ?? []) as AmazonProduct[];
  const seenAsin = new Set<string>();
  const cleanAmazon: AmazonProduct[] = [];
  for (const row of amazonRows) {
    if (!row.asin) {
      pushWarn(summary, 'amazon_products row skipped: missing asin');
      continue;
    }
    if (seenAsin.has(row.asin)) {
      pushWarn(summary, `duplicate ASIN in amazon_products: ${row.asin}`);
      continue;
    }
    seenAsin.add(row.asin);
    cleanAmazon.push(row);
  }

  const existingAmazon = parsed.amazon_products ? [] : await getAll<AmazonProduct>('amazon_products');
  existingAmazon.forEach((row) => seenAsin.add(row.asin));

  const linkRows = (parsed.asin_links ?? []) as AsinLink[];
  const linkSet = new Set<string>();
  const cleanLinks: AsinLink[] = [];
  for (const link of linkRows) {
    const key = `${link.wb_sku}::${link.asin}::${link.is_active}`;
    if (link.is_active === 'true' && linkSet.has(key)) {
      pushWarn(summary, `duplicate active asin_links pair: ${link.wb_sku}/${link.asin}`);
      continue;
    }
    linkSet.add(key);
    if (link.asin && !seenAsin.has(link.asin)) {
      pushWarn(summary, `asin_links points to unknown ASIN: ${link.asin}`);
    }
    cleanLinks.push(link);
  }

  const eventsRows = (parsed.events ?? []) as EventRecord[];
  for (const event of eventsRows) {
    if (!event.payload_json) continue;
    try { JSON.parse(event.payload_json); } catch {
      pushWarn(summary, `events payload_json invalid for event_id=${event.event_id || 'unknown'}`);
    }
  }

  const writes: Array<Promise<void>> = [];
  if (parsed.amazon_products) {
    writes.push(replaceStore('amazon_products', cleanAmazon));
    summary.imported.amazon_products = cleanAmazon.length;
    summary.skipped_rows += parsed.amazon_products.length - cleanAmazon.length;
  }
  if (parsed.wb_products) {
    const rows = parsed.wb_products as WbProduct[];
    writes.push(replaceStore('wb_products', rows));
    summary.imported.wb_products = rows.length;
  }
  if (parsed.asin_links) {
    writes.push(replaceStore('asin_links', cleanLinks));
    summary.imported.asin_links = cleanLinks.length;
    summary.skipped_rows += parsed.asin_links.length - cleanLinks.length;
  }
  if (parsed.groups) {
    const rows = parsed.groups as GroupRecord[];
    writes.push(replaceStore('groups', rows));
    summary.imported.groups = rows.length;
  }
  if (parsed.group_members) {
    const rows = parsed.group_members as GroupMemberRecord[];
    writes.push(replaceStore('group_members', rows));
    summary.imported.group_members = rows.length;
  }
  if (parsed.events) {
    writes.push(replaceStore('events', eventsRows));
    summary.imported.events = eventsRows.length;
  }
  await Promise.all(writes);
  for (const err of summary.errors) {
    await writeDebug('import_state_error', { error: err }, 'error');
  }

  if (importedMeta) {
    await putMany('meta', [{ ...defaultMeta(), ...importedMeta }]);
  } else {
    const meta = await getMeta();
    meta.last_imported_at = now();
    await putMany('meta', [meta]);
  }

  await writeDebug('validation_completed', { warnings: summary.warning_count, errors: summary.error_count });
  await writeDebug(mode === 'restore' ? 'restore_completed' : 'import_state_completed', summary as unknown as Record<string, unknown>);
  return summary;
}

export async function clearDatabaseWithLog(): Promise<void> {
  await writeDebug('clear_database_requested');
  await clearDb();
  await writeDebug('clear_database_completed');
}

function fileMapByStore(): Record<StoreKey, string> {
  return {
    amazon_products: 'amazon_products.csv',
    wb_products: 'wb_products.csv',
    asin_links: 'asin_links.csv',
    groups: 'groups.csv',
    group_members: 'group_members.csv',
    events: 'events.csv'
  };
}

function validateHeaders(store: StoreKey, rows: Record<string, string>[], summary: ImportSummary): void {
  const expected = headers[store];
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const missing = expected.filter((h) => !keys.includes(h));
  if (missing.length > 0) {
    summary.errors.push(`${store} missing required headers: ${missing.join(', ')}`);
    summary.error_count += 1;
  }
}

function pushWarn(summary: ImportSummary, warning: string): void {
  summary.warnings.push(warning);
  summary.warning_count += 1;
  void writeDebug('import_state_warning', { warning });
}

async function replaceStore(store: 'amazon_products' | 'wb_products' | 'asin_links' | 'groups' | 'group_members' | 'events', rows: object[]): Promise<void> {
  await clearStore(store);
  if (rows.length > 0) {
    await putMany(store, rows);
  }
}



export type ValidationResult = {
  validation_warnings: string[];
  validation_errors: string[];
  duplicate_active_link_count: number;
};

export async function validateLocalState(): Promise<ValidationResult> {
  const [amazon, links, events] = await Promise.all([
    getAll<AmazonProduct>('amazon_products'),
    getAll<AsinLink>('asin_links'),
    getAll<EventRecord>('events')
  ]);

  const warnings: string[] = [];
  const errors: string[] = [];
  const asinSet = new Set(amazon.map((item) => item.asin));

  const activeMap = new Map<string, AsinLink[]>();
  for (const link of links) {
    if (!link.link_id || !link.wb_sku || !link.asin) errors.push(`missing required fields in asin_links row: ${link.link_id || 'unknown'}`);
    if (link.is_active === 'true' && !link.deleted_at) {
      const key = `${link.wb_sku}::${link.asin}`;
      const bucket = activeMap.get(key) ?? [];
      bucket.push(link);
      activeMap.set(key, bucket);
    }
    if (link.asin && !asinSet.has(link.asin)) warnings.push(`link points to unknown ASIN: ${link.link_id}/${link.asin}`);
  }

  let duplicateCount = 0;
  for (const [key, dupes] of activeMap.entries()) {
    if (dupes.length > 1) {
      duplicateCount += dupes.length - 1;
      warnings.push(`duplicate active links for ${key}: ${dupes.length}`);
    }
  }

  for (const event of events) {
    if (!event.event_id || !event.event_type || !event.created_at) errors.push(`event missing required fields: ${event.event_id || 'unknown'}`);
    if (!event.payload_json) continue;
    try { JSON.parse(event.payload_json); } catch {
      warnings.push(`events payload_json invalid for event_id=${event.event_id || 'unknown'}`);
    }
  }

  await writeDebug('validation_completed', { warnings: warnings.length, errors: errors.length, duplicate_active_link_count: duplicateCount });
  return { validation_warnings: warnings, validation_errors: errors, duplicate_active_link_count: duplicateCount };
}

export async function repairDuplicateActiveLinks(): Promise<{ repaired_count: number; touched_links: string[] }> {
  const links = await getAll<AsinLink>('asin_links');
  const grouped = new Map<string, AsinLink[]>();
  for (const link of links) {
    if (link.is_active !== 'true' || link.deleted_at) continue;
    const key = `${link.wb_sku}::${link.asin}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(link);
    grouped.set(key, bucket);
  }

  const toUpdate: AsinLink[] = [];
  const touched: string[] = [];
  for (const bucket of grouped.values()) {
    if (bucket.length <= 1) continue;
    bucket.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.link_id.localeCompare(b.link_id));
    const keep = bucket[0];
    for (const dupe of bucket.slice(1)) {
      dupe.is_active = 'false';
      dupe.deleted_at = dupe.deleted_at || now();
      dupe.updated_at = now();
      toUpdate.push(dupe);
      touched.push(dupe.link_id);
      await putMany('events', [{
        event_id: `evt_${crypto.randomUUID()}`,
        operation_id: `op_${crypto.randomUUID()}`,
        event_type: 'duplicate_link_deactivated',
        wb_sku: dupe.wb_sku,
        asin: dupe.asin,
        group_id: '',
        payload_json: JSON.stringify({ deactivated_link_id: dupe.link_id, kept_link_id: keep.link_id }),
        created_at: now(),
        client_id: 'local-extension'
      }]);
    }
  }

  if (toUpdate.length > 0) await putMany('asin_links', toUpdate);
  await writeDebug('repair_duplicate_links', { repaired_count: toUpdate.length, touched_links: touched });
  return { repaired_count: toUpdate.length, touched_links: touched };
}
function defaultMeta(): MetaRecord {
  return {
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

async function writeDebug(action: string, details?: Record<string, unknown>, level: 'info' | 'error' = 'info'): Promise<void> {
  const entry: DebugEntry = { ts: now(), level, action, details };
  await putMany('debug_log', [entry]);
}
