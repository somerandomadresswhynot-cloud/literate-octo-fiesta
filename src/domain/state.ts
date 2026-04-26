import { parseCsv, toCsv } from '../lib/csv.js';
import { clearDb, clearStore, getAll, getByKey, putMany, runTransaction } from '../lib/db.js';
import type { AmazonProduct, AsinLink, DebugEntry, EventRecord, GroupMemberRecord, GroupRecord, MetaRecord, WbProduct } from '../lib/types.js';
import { getMeta } from './actions.js';
import { booleanToCsvString, isActiveLink, isDeleted, normalizeLink, normalizeWbProduct, parseBooleanLike } from '../lib/normalize.js';

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
  groups: ['group_id', 'name', 'icon', 'comment', 'group_type', 'created_at', 'updated_at', 'deleted_at'],
  group_members: ['membership_id', 'group_id', 'wb_sku', 'wb_url', 'created_at', 'updated_at', 'deleted_at'],
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
  const groupRows = (parsed.groups ?? []) as GroupRecord[];
  const activeGroupIds = new Set(groupRows.filter((g) => !isDeleted(g)).map((g) => g.group_id));
  const groupMemberRows = (parsed.group_members ?? []) as GroupMemberRecord[];
  for (const member of groupMemberRows) {
    if (!isDeleted(member) && member.group_id && !activeGroupIds.has(member.group_id)) {
      pushWarn(summary, `orphan group_member: ${member.membership_id}`);
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
    writes.push(replaceStore('groups', groupRows));
    summary.imported.groups = groupRows.length;
  }
  if (parsed.group_members) {
    writes.push(replaceStore('group_members', groupMemberRows));
    summary.imported.group_members = groupMemberRows.length;
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
  status: 'ok' | 'warning' | 'error';
  validation_warnings: string[];
  validation_errors: string[];
  validation_info: string[];
  messages: Array<{ level: 'error' | 'warning' | 'info'; message: string }>;
  duplicate_active_link_count: number;
};

export async function validateLocalState(): Promise<ValidationResult> {
  const [amazon, links, events] = await Promise.all([
    getAll<AmazonProduct>('amazon_products'),
    getAll<AsinLink>('asin_links'),
    getAll<EventRecord>('events')
  ]);
  const [metaRows, groups, groupMembers, debugLogs] = await Promise.all([
    getAll<MetaRecord>('meta'),
    getAll<GroupRecord>('groups'),
    getAll<GroupMemberRecord>('group_members'),
    getAll<DebugEntry>('debug_log')
  ]);

  const warnings: string[] = [];
  const errors: string[] = [];
  const info: string[] = [];
  const asinSet = new Set(amazon.map((item) => item.asin));

  const activeMap = new Map<string, AsinLink[]>();
  for (const link of links) {
    if (!link.link_id || !link.wb_sku || !link.asin) errors.push(`missing required fields in asin_links row: ${link.link_id || 'unknown'}`);
    if (isActiveLink(link)) {
      const key = `${link.wb_sku}::${link.asin}`;
      const bucket = activeMap.get(key) ?? [];
      bucket.push(link);
      activeMap.set(key, bucket);
    }
    if (link.asin && !asinSet.has(link.asin)) warnings.push(`link points to unknown ASIN: ${link.link_id}/${link.asin}`);
    if (!LINK_TYPES.has(link.link_type)) warnings.push(`invalid link_type for link ${link.link_id}: ${link.link_type}`);
    if (!['true', 'false', true, false, '', undefined].includes(link.is_active as any)) warnings.push(`invalid boolean-like is_active for link ${link.link_id}`);
    if (link.created_at && Number.isNaN(Date.parse(link.created_at))) warnings.push(`invalid timestamp created_at in link ${link.link_id}`);
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
    if (event.created_at && Number.isNaN(Date.parse(event.created_at))) warnings.push(`invalid timestamp created_at in event ${event.event_id || 'unknown'}`);
    if (!event.payload_json) continue;
    try { JSON.parse(event.payload_json); } catch {
      warnings.push(`events payload_json invalid for event_id=${event.event_id || 'unknown'}`);
    }
  }
  const meta = metaRows[0];
  if (!meta?.schema_version) warnings.push('meta missing schema_version');
  if (meta?.active_asin && !asinSet.has(meta.active_asin)) warnings.push(`meta active_asin not found in amazon_products: ${meta.active_asin}`);
  const groupIds = new Set(groups.filter((g) => !isDeleted(g)).map((g) => g.group_id));
  const deletedGroupIds = new Set(groups.filter((g) => isDeleted(g)).map((g) => g.group_id));
  const activeMemberships = new Map<string, GroupMemberRecord[]>();
  for (const member of groupMembers) {
    if (!isDeleted(member) && member.group_id && !groupIds.has(member.group_id)) warnings.push(`orphan group_member: ${member.membership_id}`);
    if (!isDeleted(member) && member.group_id && deletedGroupIds.has(member.group_id)) warnings.push(`group_member points to deleted group: ${member.membership_id}`);
    if (!isDeleted(member)) {
      const key = `${member.group_id}::${member.wb_sku}`;
      const bucket = activeMemberships.get(key) ?? [];
      bucket.push(member);
      activeMemberships.set(key, bucket);
    }
  }
  for (const [key, bucket] of activeMemberships.entries()) {
    if (bucket.length > 1) warnings.push(`duplicate active group membership for ${key}: ${bucket.length}`);
  }
  for (const d of debugLogs) {
    if (!d.debug_log_id) warnings.push(`debug log missing id at ts=${d.ts}`);
  }
  info.push(`checked amazon_products=${amazon.length}, asin_links=${links.length}, events=${events.length}`);

  await writeDebug('validation_completed', { warnings: warnings.length, errors: errors.length, duplicate_active_link_count: duplicateCount });
  const messages = [
    ...errors.map((message) => ({ level: 'error' as const, message })),
    ...warnings.map((message) => ({ level: 'warning' as const, message })),
    ...info.map((message) => ({ level: 'info' as const, message }))
  ];
  return { status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok', validation_warnings: warnings, validation_errors: errors, validation_info: info, messages, duplicate_active_link_count: duplicateCount };
}

export async function repairDuplicateActiveLinks(): Promise<{ repaired_count: number; touched_links: string[] }> {
  const links = await getAll<AsinLink>('asin_links');
  const grouped = new Map<string, AsinLink[]>();
  for (const link of links) {
    if (!isActiveLink(link)) continue;
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
    card_controls_position: 'top-left',
    card_controls_offset_x: '8',
    card_controls_offset_y: '8',
    card_controls_prefer_above_overlays: 'true',
    last_imported_at: '',
    last_exported_at: '',
    verbose_scan_logging: 'false'
  };
}

async function writeDebug(action: string, details?: Record<string, unknown>, level: 'info' | 'error' = 'info'): Promise<void> {
  const entry: DebugEntry = { debug_log_id: `dbg_${crypto.randomUUID()}`, ts: now(), level, action, details };
  const logs = await getAll<DebugEntry>('debug_log');
  const next = [...logs, entry].slice(-1000);
  await clearStore('debug_log');
  await putMany('debug_log', next.map((x) => ({ ...x, debug_log_id: x.debug_log_id || `dbg_${crypto.randomUUID()}` })));
}

const LINK_TYPES = new Set(['candidate', 'exact_match', 'similar', 'competitor', 'wrong_size', 'wrong_product']);

type AllInOnePayload = {
  amazon_products?: AmazonProduct[];
  wb_products?: WbProduct[];
  asin_links?: AsinLink[];
  groups?: GroupRecord[];
  group_members?: GroupMemberRecord[];
  events?: EventRecord[];
  meta?: MetaRecord;
  debug_logs?: DebugEntry[];
};

export async function validateAllInOneBackupPayload(payload: unknown): Promise<{ fatalErrors: string[]; warnings: string[]; summary: Record<string, unknown> }> {
  const obj = (payload && typeof payload === 'object') ? payload as AllInOnePayload : {};
  const warnings: string[] = [];
  const fatalErrors: string[] = [];
  if (!Array.isArray(obj.amazon_products)) fatalErrors.push('amazon_products missing or invalid');
  if (!Array.isArray(obj.wb_products)) fatalErrors.push('wb_products missing or invalid');
  if (!Array.isArray(obj.asin_links)) fatalErrors.push('asin_links missing or invalid');
  if (!Array.isArray(obj.groups)) fatalErrors.push('groups missing or invalid');
  if (!Array.isArray(obj.group_members)) fatalErrors.push('group_members missing or invalid');
  if (!Array.isArray(obj.events)) fatalErrors.push('events missing or invalid');
  if (!obj.meta || typeof obj.meta !== 'object') fatalErrors.push('meta missing or invalid');
  const asinSet = new Set((obj.amazon_products || []).map((x) => x.asin));
  for (const link of obj.asin_links || []) {
    const normalized = normalizeLink(link);
    if (normalized.asin && !asinSet.has(normalized.asin)) warnings.push(`link points to unknown ASIN: ${normalized.link_id}/${normalized.asin}`);
  }
  const activeGroupIds = new Set((obj.groups || []).filter((g) => !g.deleted_at).map((g) => g.group_id));
  for (const member of obj.group_members || []) {
    if (!member.deleted_at && member.group_id && !activeGroupIds.has(member.group_id)) warnings.push(`orphan group_member: ${member.membership_id}`);
  }
  const summary = {
    amazon_products: obj.amazon_products?.length || 0,
    wb_products: obj.wb_products?.length || 0,
    asin_links: obj.asin_links?.length || 0,
    groups: obj.groups?.length || 0,
    group_members: obj.group_members?.length || 0,
    events: obj.events?.length || 0,
    debug_logs: obj.debug_logs?.length || 0,
    active_asin: obj.meta?.active_asin || '',
    validation_warnings: warnings,
    validation_errors: fatalErrors
  };
  return { fatalErrors, warnings, summary };
}

export async function restoreFromAllInOneBackup(payload: unknown): Promise<{ restored: boolean; summary: Record<string, unknown> }> {
  const result = await validateAllInOneBackupPayload(payload);
  if (result.fatalErrors.length > 0) {
    return { restored: false, summary: result.summary };
  }
  const obj = payload as AllInOnePayload;
  await runTransaction(['amazon_products', 'wb_products', 'asin_links', 'groups', 'group_members', 'events', 'meta', 'debug_log'], 'readwrite', async (tx) => {
    const clear = (store: string) => tx.objectStore(store).clear();
    ['amazon_products', 'wb_products', 'asin_links', 'groups', 'group_members', 'events', 'meta', 'debug_log'].forEach(clear);
    for (const row of obj.amazon_products || []) tx.objectStore('amazon_products').put(row);
    for (const row of obj.wb_products || []) tx.objectStore('wb_products').put(normalizeWbProduct(row));
    for (const row of obj.asin_links || []) tx.objectStore('asin_links').put(normalizeLink(row));
    for (const row of obj.groups || []) tx.objectStore('groups').put(row);
    for (const row of obj.group_members || []) tx.objectStore('group_members').put(row);
    for (const row of obj.events || []) tx.objectStore('events').put(row);
    tx.objectStore('meta').put({ ...defaultMeta(), ...(obj.meta || {}) });
    for (const row of obj.debug_logs || []) tx.objectStore('debug_log').put({ ...row, debug_log_id: row.debug_log_id || `dbg_${crypto.randomUUID()}` });
    tx.objectStore('events').put({ event_id: `evt_${crypto.randomUUID()}`, operation_id: `op_${crypto.randomUUID()}`, event_type: 'restore_completed', wb_sku: '', asin: obj.meta?.active_asin || '', group_id: '', payload_json: JSON.stringify({ source: 'all_in_one_backup' }), created_at: now(), client_id: 'local-extension' });
    tx.objectStore('debug_log').put({ debug_log_id: `dbg_${crypto.randomUUID()}`, ts: now(), level: 'info', action: 'all_in_one_restore_completed', details: { restored: true } });
  });
  return { restored: true, summary: result.summary };
}
