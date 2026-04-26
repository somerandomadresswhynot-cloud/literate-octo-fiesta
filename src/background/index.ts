import { parseCsv } from '../lib/csv.js';
import { clearStore, getAll, putMany } from '../lib/db.js';
import { LINK_TYPES, addWbSkuToGroup, bulkAddToGroup, bulkDefer, bulkLinkToActiveAsin, bulkLinkToSelectedAsin, bulkReject, createGroup, getCardContext, getCardState, getGroupsForWbSku, getHistoryBySku, getMeta, importAmazonProducts, linkWbSkuToActiveAsin, linkWbSkuToAsin, listGroups, markCardTouched, markSeenByHover, recordLinkCopied, removeWbSkuFromGroup, searchGroups, setActiveAsin, setDefaultLinkType, setDeferred, setRejected, undoLastAction } from '../domain/actions.js';
import { clearDatabaseWithLog, exportStateFiles, importStateFiles, repairDuplicateActiveLinks, restoreFromAllInOneBackup, validateAllInOneBackupPayload, validateLocalState } from '../domain/state.js';
import type { AmazonProduct, DebugEntry } from '../lib/types.js';
import { shouldPersistDebug } from '../lib/logging.js';
import { filterAndRankAsinResults } from '../lib/asinSearch.js';

type Request =
  | { type: 'importAmazonCsv'; csvText: string }
  | { type: 'importStateFiles'; files: Record<string, string>; mode?: 'import' | 'restore' }
  | { type: 'searchAsin'; query: string }
  | { type: 'setActiveAsin'; asin: string }
  | { type: 'setDefaultLinkType'; linkType: string }
  | { type: 'getPopupState' }
  | { type: 'linkSku'; wb_sku: string; wb_url: string }
  | { type: 'linkSkuToAsin'; wb_sku: string; wb_url: string; asin: string; linkType?: string; conflictResolution?: 'add_second_link' | 'replace_existing'; rejectedResolution?: 'keep_rejected' | 'clear_rejected' }
  | { type: 'getCardState'; wb_sku: string }
  | { type: 'markSeenByHover'; wb_sku: string; wb_url: string }
  | { type: 'markCardTouched'; wb_sku: string; wb_url: string; source: string }
  | { type: 'recordLinkCopied'; wb_sku: string; wb_url: string }
  | { type: 'setRejected'; wb_sku: string; wb_url: string; reasonCode: string; reasonText: string }
  | { type: 'setDeferred'; wb_sku: string; wb_url: string; reasonCode: string; reasonText: string }
  | { type: 'undoLastAction' }
  | { type: 'listGroups' }
  | { type: 'searchGroups'; query: string }
  | { type: 'createGroup'; name: string; icon?: string; comment?: string; group_type?: string }
  | { type: 'addWbSkuToGroup'; wb_sku: string; wb_url: string; group_id: string }
  | { type: 'removeWbSkuFromGroup'; wb_sku: string; group_id: string }
  | { type: 'getGroupsForWbSku'; wb_sku: string }
  | { type: 'getCardContext'; wb_sku: string; wb_url: string }

  | { type: 'bulkLinkToActiveAsin'; items: Array<{ wb_sku: string; wb_url: string }>; linkType?: string; conflictResolution?: 'skip_conflicts' | 'add_second_link' | 'replace_existing'; rejectedResolution?: 'keep_rejected' | 'clear_rejected' }
  | { type: 'bulkLinkToSelectedAsin'; items: Array<{ wb_sku: string; wb_url: string }>; asin: string; linkType?: string; conflictResolution?: 'skip_conflicts' | 'add_second_link' | 'replace_existing'; rejectedResolution?: 'keep_rejected' | 'clear_rejected' }
  | { type: 'bulkAddToGroup'; items: Array<{ wb_sku: string; wb_url: string }>; group_id: string }
  | { type: 'bulkReject'; items: Array<{ wb_sku: string; wb_url: string }>; reasonCode: string; reasonText: string }
  | { type: 'bulkDefer'; items: Array<{ wb_sku: string; wb_url: string }>; reasonCode: string; reasonText: string }
  | { type: 'getHistoryBySku'; wb_sku: string; limit?: number }
  | { type: 'exportState' }
  | { type: 'getExportData' }
  | { type: 'storageSummary' }
  | { type: 'clearDb' }
  | { type: 'validateLocalState' }
  | { type: 'repairDuplicateActiveLinks' }
  | { type: 'validateAllInOneBackup'; payload: unknown }
  | { type: 'restoreAllInOneBackup'; payload: unknown }
  | { type: 'getVerboseLogging' }
  | { type: 'setVerboseLogging'; enabled: boolean }
  | { type: 'getOverlayPosition' }
  | { type: 'setOverlayPosition'; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto' }
  | { type: 'getCardControlsSettings' }
  | { type: 'setCardControlsSettings'; settings: { placement: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; offsetX: number; offsetY: number; preferAboveOverlays: boolean } }
  | { type: 'logDebug'; level?: 'info' | 'error'; action: string; details?: Record<string, unknown> };


export async function performAsinSearch(query: string): Promise<{ results: AmazonProduct[]; activeAsin: string; linkTypes: readonly string[] }> {
  const [products, meta, events] = await Promise.all([
    getAll<AmazonProduct>('amazon_products'),
    getMeta(),
    getAll('events')
  ]);
  const recentAsins = (events as Array<{ event_type: string; asin: string }>).filter((x) => x.event_type === 'active_asin_changed' && x.asin).map((x) => x.asin);
  return {
    results: filterAndRankAsinResults({ products, query, activeAsin: meta.active_asin, recentAsins }),
    activeAsin: meta.active_asin,
    linkTypes: LINK_TYPES
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message: Request, _sender: unknown, sendResponse: (response: unknown) => void) => {
    void handleMessage(message)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });
}

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
    return await performAsinSearch(message.query);
  }

  if (message.type === 'setActiveAsin') {
    await setActiveAsin(message.asin);
    return {};
  }

  if (message.type === 'setDefaultLinkType') {
    await setDefaultLinkType(message.linkType as any);
    return {};
  }

  if (message.type === 'getPopupState') {
    const products = await getAll<AmazonProduct>('amazon_products');
    const meta = await getMeta();
    return { amazonCount: products.length, activeAsin: meta.active_asin, defaultLinkType: meta.default_link_type || 'candidate', linkTypes: LINK_TYPES };
  }

  if (message.type === 'linkSku') {
    const result = await linkWbSkuToActiveAsin(message.wb_sku, message.wb_url);
    return { result };
  }

  if (message.type === 'linkSkuToAsin') {
    const result = await linkWbSkuToAsin({
      wb_sku: message.wb_sku,
      wb_url: message.wb_url,
      asin: message.asin,
      linkType: message.linkType as any,
      createdByAction: 'add_to_asin',
      conflictResolution: message.conflictResolution,
      rejectedResolution: message.rejectedResolution
    });
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
  if (message.type === 'listGroups') return { groups: await listGroups() };
  if (message.type === 'searchGroups') return { groups: await searchGroups(message.query) };
  if (message.type === 'createGroup') return { group: await createGroup({ name: message.name, icon: message.icon, comment: message.comment, group_type: message.group_type }) };
  if (message.type === 'addWbSkuToGroup') return await addWbSkuToGroup(message.wb_sku, message.wb_url, message.group_id);
  if (message.type === 'removeWbSkuFromGroup') return await removeWbSkuFromGroup(message.wb_sku, message.group_id);
  if (message.type === 'getGroupsForWbSku') return { groups: await getGroupsForWbSku(message.wb_sku) };

  if (message.type === 'getCardContext') {
    return { context: await getCardContext(message.wb_sku, message.wb_url) };
  }


  if (message.type === 'bulkLinkToActiveAsin') {
    return { summary: await bulkLinkToActiveAsin(message.items, (message.linkType as any) || 'candidate', message.conflictResolution || 'skip_conflicts', message.rejectedResolution || 'keep_rejected') };
  }

  if (message.type === 'bulkLinkToSelectedAsin') {
    return { summary: await bulkLinkToSelectedAsin(message.items, message.asin, (message.linkType as any) || 'candidate', message.conflictResolution || 'skip_conflicts', message.rejectedResolution || 'keep_rejected') };
  }

  if (message.type === 'bulkAddToGroup') {
    return { summary: await bulkAddToGroup(message.items, message.group_id) };
  }

  if (message.type === 'bulkReject') {
    return { summary: await bulkReject(message.items, message.reasonCode, message.reasonText) };
  }

  if (message.type === 'bulkDefer') {
    return { summary: await bulkDefer(message.items, message.reasonCode, message.reasonText) };
  }

  if (message.type === 'getHistoryBySku') {
    return await getHistoryBySku(message.wb_sku, message.limit || 100);
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
  if (message.type === 'validateAllInOneBackup') {
    return await validateAllInOneBackupPayload(message.payload);
  }
  if (message.type === 'restoreAllInOneBackup') {
    return await restoreFromAllInOneBackup(message.payload);
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
  if (message.type === 'getCardControlsSettings') {
    const meta = await getMeta();
    return {
      settings: {
        placement: (meta.card_controls_position || meta.overlay_position || 'top-left') as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
        offsetX: Number(meta.card_controls_offset_x || '8') || 8,
        offsetY: Number(meta.card_controls_offset_y || '8') || 8,
        preferAboveOverlays: (meta.card_controls_prefer_above_overlays || 'true') !== 'false'
      }
    };
  }
  if (message.type === 'setCardControlsSettings') {
    const meta = await getMeta();
    meta.card_controls_position = message.settings.placement;
    meta.card_controls_offset_x = String(Math.max(0, Math.min(36, Number(message.settings.offsetX) || 0)));
    meta.card_controls_offset_y = String(Math.max(0, Math.min(36, Number(message.settings.offsetY) || 0)));
    meta.card_controls_prefer_above_overlays = message.settings.preferAboveOverlays ? 'true' : 'false';
    await putMany('meta', [meta]);
    await writeDebugEntry({ ts: new Date().toISOString(), level: 'info', action: 'card_controls_position_setting_changed', details: { source: 'background', settings: message.settings } });
    return { settings: message.settings };
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
  const next = [...logs, { ...entry, debug_log_id: entry.debug_log_id || `dbg_${crypto.randomUUID()}` }];
  const capped = next.slice(-1000);
  await clearStore('debug_log');
  if (capped.length > 0) {
    await putMany('debug_log', capped);
  }
}
