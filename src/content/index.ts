import { sendMessage } from '../lib/runtime.js';

const CLASS_NAME = 'wb-amz-overlay';
const SKU_REGEX = /\/catalog\/(\d+)\/detail\.aspx/i;
const CONTENT_BOOT_FLAG = '__wbAsinContentBooted';

console.log('[WB-ASIN] content script loaded', location.href);

type ScanStats = {
  linksFound: number;
  skuExtracted: number;
  overlaysInjected: number;
  cardContainerNotFound: number;
  sampleHrefs: string[];
  sampleSkus: string[];
};

declare global {
  interface Window {
    __wbAsinContentBooted?: boolean;
  }
}

if (!window[CONTENT_BOOT_FLAG]) {
  window[CONTENT_BOOT_FLAG] = true;
  void logContent('content_script_loaded', { url: location.href, ready_state: document.readyState });
  startContentScript();
}

function startContentScript(): void {
  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message.type === 'pingContentScript') {
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'forceScan') {
      const stats = scan('popup_force_scan');
      sendResponse({ ok: true, foundLinks: stats.linksFound, extractedSkus: stats.skuExtracted, injectedOverlays: stats.overlaysInjected });
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => scan('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', () => scan('scroll'), { passive: true });
  setInterval(() => scan('interval'), 3000);
  scan('initial');
}

function getVisibleProductAnchors(): HTMLAnchorElement[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"][href*="detail.aspx"]'));
  return anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    const style = window.getComputedStyle(anchor);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function extractSkuFromAnchor(anchor: HTMLAnchorElement): { sku: string | null; absoluteUrl: string; rawHref: string } {
  const rawHref = anchor.getAttribute('href') ?? '';
  const absoluteUrl = new URL(rawHref || anchor.href, location.href).toString();
  const match = absoluteUrl.match(SKU_REGEX);
  return { sku: match?.[1] ?? null, absoluteUrl, rawHref };
}

function findCardContainer(anchor: HTMLAnchorElement): { container: HTMLElement; fallbackUsed: boolean } {
  const closest = anchor.closest('article, li, [data-nm-id], [class*="card"], [class*="product"], [class*="goods"]') as HTMLElement | null;
  if (closest) return { container: closest, fallbackUsed: false };

  let level = 0;
  let node: HTMLElement | null = anchor.parentElement;
  while (node && level < 5) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 120 && rect.height > 150) {
      return { container: node, fallbackUsed: false };
    }
    node = node.parentElement;
    level += 1;
  }

  return { container: anchor, fallbackUsed: true };
}

function ensureInjected(link: HTMLAnchorElement, sku: string, wbUrl: string, stats: ScanStats): void {
  const { container: card, fallbackUsed } = findCardContainer(link);
  if (fallbackUsed) stats.cardContainerNotFound += 1;

  const existing = card.querySelector(`.${CLASS_NAME}[data-wb-sku="${sku}"]`);
  if (existing) return;

  if (getComputedStyle(card).position === 'static') {
    card.style.position = 'relative';
  }

  const wrap = document.createElement('div');
  wrap.className = CLASS_NAME;
  wrap.dataset.wbSku = sku;

  const status = document.createElement('span');
  status.className = 'wb-amz-status';
  status.textContent = '·';

  const btn = document.createElement('button');
  btn.className = 'wb-amz-btn';
  btn.type = 'button';
  btn.textContent = 'A+';
  btn.title = `Link WB ${sku} to active ASIN`;
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await sendMessage<{ ok: boolean }>({ type: 'linkSku', wb_sku: sku, wb_url: wbUrl });
      status.textContent = 'A';
    } catch (error) {
      status.textContent = '!';
      void logContent('link_click_error', { sku, error: String(error) });
    }
  });

  wrap.append(status, btn);
  card.appendChild(wrap);
  stats.overlaysInjected += 1;
  void refreshCardState(sku, status);
}

async function refreshCardState(sku: string, statusEl: HTMLElement): Promise<void> {
  try {
    const state = await sendMessage<{ ok: boolean; linked: boolean; activeAsinLinked: boolean }>({ type: 'getCardState', wb_sku: sku });
    statusEl.textContent = state.activeAsinLinked ? 'A' : state.linked ? 'a' : '·';
  } catch {
    statusEl.textContent = '?';
  }
}

function scan(reason = 'auto'): ScanStats {
  const stats: ScanStats = {
    linksFound: 0,
    skuExtracted: 0,
    overlaysInjected: 0,
    cardContainerNotFound: 0,
    sampleHrefs: [],
    sampleSkus: []
  };

  void logContent('scan_started', { reason });
  const links = getVisibleProductAnchors();
  stats.linksFound = links.length;

  for (const link of links) {
    const parsed = extractSkuFromAnchor(link);
    if (stats.sampleHrefs.length < 10) {
      stats.sampleHrefs.push(parsed.rawHref || parsed.absoluteUrl);
    }
    if (!parsed.sku) continue;

    stats.skuExtracted += 1;
    if (stats.sampleSkus.length < 10) stats.sampleSkus.push(parsed.sku);
    ensureInjected(link, parsed.sku, parsed.absoluteUrl, stats);
  }

  void logContent('product_links_found', { reason, count: stats.linksFound });
  void logContent('sku_extracted', { reason, count: stats.skuExtracted });
  void logContent('overlay_injected', { reason, count: stats.overlaysInjected });
  void logContent('card_container_not_found', { reason, count: stats.cardContainerNotFound });
  void logContent('scan_samples', { reason, sample_hrefs: stats.sampleHrefs, sample_skus: stats.sampleSkus });
  return stats;
}

async function logContent(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await sendMessage<{ ok: boolean }>({ type: 'logDebug', level: 'info', action, details: { ...details, source: 'content' } });
  } catch {
    // ignore logging failures
  }
}

export {};
