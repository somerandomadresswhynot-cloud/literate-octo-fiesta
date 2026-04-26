import { parseCsv } from '../lib/csv.js';
import { clearStore, getAll, putMany } from '../lib/db.js';
import { getCardContext, getCardState, getMeta, importAmazonProducts, linkWbSkuToActiveAsin, markCardTouched, markSeenByHover, recordLinkCopied, setActiveAsin, setDeferred, setRejected, undoLastAction } from '../domain/actions.js';
import { clearDatabaseWithLog, exportStateFiles, importStateFiles, repairDuplicateActiveLinks, validateLocalState } from '../domain/state.js';
import type { AmazonProduct, DebugEntry } from '../lib/types.js';
import { shouldPersistDebug } from '../lib/logging.js';

type Request =
  | { type: 'importAmazonCsv'; csvText: string }
  | { type: 'importStateFiles'; files: Record<string, string>; mode?: 'import' | 'restore' }
  | { type: 'searchAsin'; query: string }
  | { type: 'setActiveAsin'; asin: string }
  | { type: 'getPopupState' }
  | { type: 'linkSku'; wb_sku: string; wb_url: string }
  | { type: 'getCardState'; wb_sku: string }
  | { type: 'markSeenByHover'; wb_sku: string; wb_url: string }
  | { type: 'markCardTouched'; wb_sku: string; wb_url: string; source: string }
  | { type: 'recordLinkCopied'; wb_sku: string; wb_url: string }
  | { type: 'setRejected'; wb_sku: string; wb_url: string; reasonCode: string; reasonText: string }
  | { type: 'setDeferred'; wb_sku: string; wb_url: string; reasonCode: string; reasonText: string }
  | { type: 'undoLastAction' }
  | { type: 'getCardContext'; wb_sku: string; wb_url: string }
  | { type: 'exportState' }
  | { type: 'getExportData' }
  | { type: 'storageSummary' }
  | { type: 'clearDb' }
  | { type: 'validateLocalState' }
  | { type: 'repairDuplicateActiveLinks' }
  | { type: 'getVerboseLogging' }
  | { type: 'setVerboseLogging'; enabled: boolean }
  | { type: 'getOverlayPosition' }
  | { type: 'setOverlayPosition'; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto' }
  | { type: 'logDebug'; level?: 'info' | 'error'; action: string; details?: Record<string, unknown> };

chrome.runtime.onMessage.addListener((message: Request, _sender: unknown, sendResponse: (response: unknown) => void) => {
  void handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function handleMessage(message: Request): Promise<Record<string, unknown>> {
  if (message.type === 'importAmazonCsv') {
    const rows = parseCsv(message.csvText) as unknown as AmazonProduct[];
    await importAmazonProducts(rows);
    return { imported: rows.length };
  }

  if (message.type === 'importStateFiles') {
    const summary = await importStateFiles(message.files, message.mode ?? 'import');
    return { summary };
  }

  if (message.type === 'searchAsin') {
    const products = await getAll<AmazonProduct>('amazon_products');
    const q = message.query.toLowerCase().trim();
    const results = products.filter((product) => {
      if (!q) return true;
      return [product.asin, product.title, product.brand, product.comment].some((field) => field?.toLowerCase().includes(q));
    }).slice(0, 50);
    return { results };
  }

  if (message.type === 'setActiveAsin') {
    await setActiveAsin(message.asin);
    return {};
  }

  if (message.type === 'getPopupState') {
    const products = await getAll<AmazonProduct>('amazon_products');
    const meta = await getMeta();
    return { amazonCount: products.length, activeAsin: meta.active_asin };
  }

  if (message.type === 'linkSku') {
    const result = await linkWbSkuToActiveAsin(message.wb_sku, message.wb_url);
    return { result };
  }

  if (message.type === 'getCardState') {
    return await getCardState(message.wb_sku);
  }


  if (message.type === 'markSeenByHover') {
    await markSeenByHover(message.wb_sku, message.wb_url);
    return {};
  }

  if (message.type === 'markCardTouched') {
    await markCardTouched(message.wb_sku, message.wb_url, message.source);
    return {};
  }

  if (message.type === 'recordLinkCopied') {
    await recordLinkCopied(message.wb_sku, message.wb_url);
    return {};
  }

  if (message.type === 'setRejected') {
    await setRejected(message.wb_sku, message.wb_url, message.reasonCode, message.reasonText);
    return {};
  }

  if (message.type === 'setDeferred') {
    await setDeferred(message.wb_sku, message.wb_url, message.reasonCode, message.reasonText);
    return {};
  }

  if (message.type === 'undoLastAction') {
    return await undoLastAction();
  }

  if (message.type === 'getCardContext') {
    return { context: await getCardContext(message.wb_sku, message.wb_url) };
  }

  if (message.type === 'exportState') {
    const exported = await exportStateFiles();
    return { files: exported.files, backupName: exported.name };
  }

  if (message.type === 'getExportData') {
    const [amazon, wb, links, groups, groupMembers, events, meta, debugLog, validation] = await Promise.all([
      getAll('amazon_products'),
      getAll('wb_products'),
      getAll('asin_links'),
      getAll('groups'),
      getAll('group_members'),
      getAll('events'),
      getMeta(),
      getAll('debug_log'),
      validateLocalState()
    ]);
    return {
      data: {
        amazon_products: amazon,
        wb_products: wb,
        asin_links: links,
        groups,
        group_members: groupMembers,
        events,
        meta,
        debug_log: debugLog,
        validation_warnings: validation.validation_warnings,
        validation_errors: validation.validation_errors,
        duplicate_active_link_count: validation.duplicate_active_link_count,
        verbose_logging_enabled: meta.verbose_scan_logging === 'true',
        debug_log_count: debugLog.length
      }
    };
  }

  if (message.type === 'storageSummary') {
    const [amazon, wb, links, groups, groupMembers, events, meta] = await Promise.all([
      getAll('amazon_products'),
      getAll('wb_products'),
      getAll('asin_links'),
      getAll('groups'),
      getAll('group_members'),
      getAll('events'),
      getMeta()
    ]);
    return { summary: { amazon: amazon.length, wb: wb.length, links: links.length, groups: groups.length, groupMembers: groupMembers.length, events: events.length, activeAsin: meta.active_asin, overlayPosition: meta.overlay_position, verboseLogging: meta.verbose_scan_logging } };
  }

  if (message.type === 'validateLocalState') {
    return await validateLocalState();
  }

  if (message.type === 'repairDuplicateActiveLinks') {
    return await repairDuplicateActiveLinks();
  }

  if (message.type === 'getVerboseLogging') {
    const meta = await getMeta();
    return { enabled: meta.verbose_scan_logging === 'true' };
  }

  if (message.type === 'setVerboseLogging') {
    const meta = await getMeta();
    meta.verbose_scan_logging = message.enabled ? 'true' : 'false';
    await putMany('meta', [meta]);
    return { enabled: message.enabled };
  }

  if (message.type === 'getOverlayPosition') {
    const meta = await getMeta();
    return { position: meta.overlay_position || 'top-left' };
  }

  if (message.type === 'setOverlayPosition') {
    const meta = await getMeta();
    meta.overlay_position = message.position;
    await putMany('meta', [meta]);
    await writeDebugEntry({ ts: new Date().toISOString(), level: 'info', action: 'overlay_position_setting_changed', details: { source: 'background', position: message.position } });
    return { position: message.position };
  }

  if (message.type === 'logDebug') {
    const meta = await getMeta();
    if (!shouldPersistDebug(message.action, meta.verbose_scan_logging === 'true')) return {};

    const entry: DebugEntry = {
      ts: new Date().toISOString(),
      level: message.level ?? 'info',
      action: message.action,
      details: message.details ?? {}
    };
    await writeDebugEntry(entry);
    return {};
  }

  if (message.type === 'clearDb') {
    await clearDatabaseWithLog();
    return {};
  }

  return {};
}

async function writeDebugEntry(entry: DebugEntry): Promise<void> {
  const logs = await getAll<DebugEntry>('debug_log');
  const next = [...logs, entry];
  const capped = next.slice(-1000);
  await clearStore('debug_log');
  if (capped.length > 0) {
    await putMany('debug_log', capped);
  }
}
