import { parseCsv } from '../lib/csv.js';
import { getAll, putMany } from '../lib/db.js';
import { getCardState, getMeta, importAmazonProducts, linkWbSkuToActiveAsin, setActiveAsin } from '../domain/actions.js';
import { clearDatabaseWithLog, exportStateFiles, importStateFiles } from '../domain/state.js';
import type { AmazonProduct, DebugEntry } from '../lib/types.js';

type Request =
  | { type: 'importAmazonCsv'; csvText: string }
  | { type: 'importStateFiles'; files: Record<string, string>; mode?: 'import' | 'restore' }
  | { type: 'searchAsin'; query: string }
  | { type: 'setActiveAsin'; asin: string }
  | { type: 'getPopupState' }
  | { type: 'linkSku'; wb_sku: string; wb_url: string }
  | { type: 'getCardState'; wb_sku: string }
  | { type: 'exportState' }
  | { type: 'storageSummary' }
  | { type: 'clearDb' }
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
    const link = await linkWbSkuToActiveAsin(message.wb_sku, message.wb_url);
    return { link };
  }

  if (message.type === 'getCardState') {
    return await getCardState(message.wb_sku);
  }

  if (message.type === 'exportState') {
    const exported = await exportStateFiles();
    return { files: exported.files, backupName: exported.name };
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
    return { summary: { amazon: amazon.length, wb: wb.length, links: links.length, groups: groups.length, groupMembers: groupMembers.length, events: events.length, activeAsin: meta.active_asin, overlayPosition: meta.overlay_position } };
  }

  if (message.type === 'getOverlayPosition') {
    const meta = await getMeta();
    return { position: meta.overlay_position || 'top-left' };
  }

  if (message.type === 'setOverlayPosition') {
    const meta = await getMeta();
    meta.overlay_position = message.position;
    await putMany('meta', [meta]);
    const entry: DebugEntry = {
      ts: new Date().toISOString(),
      level: 'info',
      action: 'overlay_position_setting_changed',
      details: { source: 'background', position: message.position }
    };
    await putMany('debug_log', [entry]);
    return { position: message.position };
  }

  if (message.type === 'logDebug') {
    const entry: DebugEntry = {
      ts: new Date().toISOString(),
      level: message.level ?? 'info',
      action: message.action,
      details: message.details ?? {}
    };
    await putMany('debug_log', [entry]);
    return {};
  }

  if (message.type === 'clearDb') {
    await clearDatabaseWithLog();
    return {};
  }

  return {};
}
