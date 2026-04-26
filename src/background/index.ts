import { parseCsv } from '../lib/csv.js';
import { getAll, clearDb } from '../lib/db.js';
import { exportCsvState, getCardState, getMeta, importAmazonProducts, linkWbSkuToActiveAsin, setActiveAsin } from '../domain/actions.js';
import type { AmazonProduct } from '../lib/types.js';

type Request =
  | { type: 'importAmazonCsv'; csvText: string }
  | { type: 'searchAsin'; query: string }
  | { type: 'setActiveAsin'; asin: string }
  | { type: 'getPopupState' }
  | { type: 'linkSku'; wb_sku: string; wb_url: string }
  | { type: 'getCardState'; wb_sku: string }
  | { type: 'exportState' }
  | { type: 'storageSummary' }
  | { type: 'clearDb' };

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
    const files = await exportCsvState();
    return { files };
  }

  if (message.type === 'storageSummary') {
    const [amazon, wb, links, events, meta] = await Promise.all([
      getAll('amazon_products'),
      getAll('wb_products'),
      getAll('asin_links'),
      getAll('events'),
      getMeta()
    ]);
    return { summary: { amazon: amazon.length, wb: wb.length, links: links.length, events: events.length, activeAsin: meta.active_asin } };
  }

  if (message.type === 'clearDb') {
    await clearDb();
    return {};
  }

  return {};
}
