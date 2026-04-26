import { sendMessage } from '../lib/runtime.js';

const SKU_REGEX = /\/catalog\/(\d+)\/detail\.aspx/i;
const CONTENT_BOOT_FLAG = '__wbAsinContentBooted';
const ROOT_ID = 'wb-asin-overlay-root';

type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto';
type MarkerState = 'A' | 'a' | '·' | '?' | '!';

type OverlayEntry = {
  sku: string;
  wbUrl: string;
  linkElement: HTMLAnchorElement;
  cardElement: HTMLElement;
  overlayElement: HTMLDivElement;
  statusElement: HTMLSpanElement;
  buttonElement: HTMLButtonElement;
};

declare global {
  interface Window {
    __wbAsinContentBooted?: boolean;
  }
}

class OverlayManager {
  private readonly root: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly overlays = new Map<string, OverlayEntry>();
  private updateQueued = false;
  private overlayPosition: OverlayPosition = 'top-left';
  private readonly cardSelectors = 'article, li, [data-nm-id], [class*="card"], [class*="product"], [class*="goods"]';

  constructor() {
    this.root = this.ensureRoot();
    this.shadow = this.root.shadowRoot ?? this.root.attachShadow({ mode: 'open' });
    this.layer = document.createElement('div');
    this.layer.className = 'overlay-layer';
    this.mountShadow();
  }

  async init(): Promise<void> {
    await this.refreshOverlayPositionSetting();
  }

  upsertFromAnchor(anchor: HTMLAnchorElement, sku: string, wbUrl: string): void {
    const card = this.findCardContainer(anchor);
    const existing = this.overlays.get(sku);
    if (existing) {
      existing.linkElement = anchor;
      existing.cardElement = card;
      existing.wbUrl = wbUrl;
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'wb-amz-overlay';
    overlay.dataset.wbSku = sku;

    const status = document.createElement('span');
    status.className = 'wb-amz-status';
    status.textContent = '·';

    const btn = document.createElement('button');
    btn.className = 'wb-amz-btn';
    btn.type = 'button';
    btn.textContent = 'A+';
    btn.title = `Link WB ${sku} to active ASIN`;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.handleLinkClick(sku);
    });

    overlay.append(status, btn);
    this.layer.appendChild(overlay);
    this.overlays.set(sku, {
      sku,
      wbUrl,
      linkElement: anchor,
      cardElement: card,
      overlayElement: overlay,
      statusElement: status,
      buttonElement: btn
    });

    void this.refreshCardState(sku, status);
  }

  getOverlayCount(): number {
    return this.overlays.size;
  }

  async setOverlayPosition(position: OverlayPosition): Promise<void> {
    if (this.overlayPosition === position) return;
    this.overlayPosition = position;
    await logContent('overlay_position_setting_changed', { position });
    this.schedulePositionUpdate('position_setting_changed');
  }

  async refreshOverlayPositionSetting(): Promise<void> {
    try {
      const response = await sendMessage<{ ok: boolean; position: OverlayPosition }>({ type: 'getOverlayPosition' });
      if (response.position) {
        this.overlayPosition = response.position;
      }
    } catch {
      this.overlayPosition = 'top-left';
    }
  }

  schedulePositionUpdate(reason: string): void {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      this.updatePositions(reason);
    });
  }

  private updatePositions(reason: string): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let visibleCount = 0;
    let removedCount = 0;

    for (const [sku, entry] of this.overlays.entries()) {
      if (!entry.cardElement.isConnected || !entry.linkElement.isConnected) {
        entry.overlayElement.remove();
        this.overlays.delete(sku);
        removedCount += 1;
        continue;
      }

      const cardRect = entry.cardElement.getBoundingClientRect();
      if (cardRect.width <= 0 || cardRect.height <= 0 || cardRect.bottom < 0 || cardRect.top > viewport.height) {
        entry.overlayElement.style.display = 'none';
        continue;
      }

      const placement = this.resolvePlacement(entry.cardElement, cardRect, viewport);
      const overlayRect = entry.overlayElement.getBoundingClientRect();
      const width = overlayRect.width || 56;
      const height = overlayRect.height || 28;
      const margin = 8;

      let left = cardRect.left + margin;
      let top = cardRect.top + margin;
      if (placement.includes('right')) left = cardRect.right - width - margin;
      if (placement.includes('bottom')) top = cardRect.bottom - height - margin;

      left = Math.max(0, Math.min(viewport.width - width, left));
      top = Math.max(0, Math.min(viewport.height - height, top));

      entry.overlayElement.style.display = 'inline-flex';
      entry.overlayElement.style.left = `${Math.round(left)}px`;
      entry.overlayElement.style.top = `${Math.round(top)}px`;
      visibleCount += 1;
    }

    void logContent('overlay_position_updated', { reason, visible_count: visibleCount });
    void logContent('overlay_visible_count', { reason, count: visibleCount });
    if (removedCount > 0) {
      void logContent('overlay_removed_count', { reason, count: removedCount });
    }
  }

  private resolvePlacement(card: HTMLElement, rect: DOMRect, viewport: { width: number; height: number }): Exclude<OverlayPosition, 'auto'> {
    if (this.overlayPosition !== 'auto') return this.overlayPosition;

    const topLeftBlocked = this.hasTopLeftBadge(card) || rect.left + 56 > viewport.width || rect.top + 28 > viewport.height;
    if (!topLeftBlocked) return 'top-left';

    if (!this.hasTopRightFavorite(card)) return 'top-right';
    if (rect.bottom - 28 >= 0) return 'bottom-right';
    return 'bottom-left';
  }

  private hasTopLeftBadge(card: HTMLElement): boolean {
    const badge = card.querySelector<HTMLElement>('[class*="badge"], [class*="sticker"], [class*="sale"], [class*="discount"], [data-tag], [class*="label"]');
    if (!badge) return false;
    const cardRect = card.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    return badgeRect.left <= cardRect.left + cardRect.width * 0.45 && badgeRect.top <= cardRect.top + cardRect.height * 0.35;
  }

  private hasTopRightFavorite(card: HTMLElement): boolean {
    return Boolean(card.querySelector('[class*="favorite"], [class*="bookmark"], [class*="heart"], [aria-label*="Избран"], [aria-label*="Favorite"]'));
  }

  private findCardContainer(anchor: HTMLAnchorElement): HTMLElement {
    const closest = anchor.closest(this.cardSelectors) as HTMLElement | null;
    if (closest) return closest;

    let level = 0;
    let node: HTMLElement | null = anchor.parentElement;
    while (node && level < 6) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 150) return node;
      node = node.parentElement;
      level += 1;
    }
    return anchor;
  }

  private async handleLinkClick(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    try {
      await sendMessage<{ ok: boolean }>({ type: 'linkSku', wb_sku: sku, wb_url: entry.wbUrl });
      this.setMarker(entry, 'A');
      await this.refreshCardState(sku, entry.statusElement);
    } catch (error) {
      this.setMarker(entry, '!');
      await logContent('link_click_error', { sku, error: String(error) });
    }
  }

  private async refreshCardState(sku: string, statusEl: HTMLSpanElement): Promise<void> {
    try {
      const state = await sendMessage<{ ok: boolean; linked: boolean; activeAsinLinked: boolean }>({ type: 'getCardState', wb_sku: sku });
      statusEl.textContent = state.activeAsinLinked ? 'A' : state.linked ? 'a' : '·';
    } catch {
      statusEl.textContent = '?';
    }
  }

  private setMarker(entry: OverlayEntry, value: MarkerState): void {
    entry.statusElement.textContent = value;
  }

  private ensureRoot(): HTMLDivElement {
    const existing = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (existing) return existing;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483646';
    document.body.appendChild(root);
    void logContent('overlay_root_created', { id: ROOT_ID });
    return root;
  }

  private mountShadow(): void {
    if (this.shadow.querySelector('style')) return;
    const style = document.createElement('style');
    style.textContent = `
      .overlay-layer { position: fixed; inset: 0; pointer-events: none; }
      .wb-amz-overlay {
        position: fixed;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid #7a38ff;
        border-radius: 10px;
        padding: 3px 6px;
        box-shadow: 0 2px 6px rgba(30, 20, 60, 0.2);
        pointer-events: auto;
        font-family: Arial, sans-serif;
      }
      .wb-amz-btn {
        border: 1px solid #5f20d4;
        color: #fff;
        background: #7a38ff;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        border-radius: 8px;
        padding: 4px 7px;
        cursor: pointer;
      }
      .wb-amz-status {
        color: #5f20d4;
        font-size: 11px;
        font-weight: 700;
        min-width: 10px;
        text-align: center;
      }
    `;
    this.shadow.append(style, this.layer);
  }
}

console.log('[WB-ASIN] content script loaded', location.href);

if (!window[CONTENT_BOOT_FLAG]) {
  window[CONTENT_BOOT_FLAG] = true;
  void startContentScript();
}

async function startContentScript(): Promise<void> {
  const manager = new OverlayManager();
  await manager.init();
  await logContent('content_script_loaded', { url: location.href, ready_state: document.readyState });

  chrome.runtime.onMessage.addListener((message: { type?: string; position?: OverlayPosition }, _sender, sendResponse) => {
    if (message.type === 'pingContentScript') {
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'forceScan') {
      const stats = scan(manager, 'popup_force_scan');
      sendResponse({ ok: true, foundLinks: stats.linksFound, extractedSkus: stats.skuExtracted, injectedOverlays: stats.overlaysInjected });
      return true;
    }
    if (message.type === 'overlayPositionSettingChanged' && message.position) {
      void manager.setOverlayPosition(message.position);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  const onChange = (reason: string): void => {
    scan(manager, reason);
  };

  const observer = new MutationObserver(() => onChange('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', () => onChange('scroll'), { passive: true });
  window.addEventListener('resize', () => manager.schedulePositionUpdate('resize'));
  setInterval(() => onChange('interval'), 3000);
  onChange('initial');
}

type ScanStats = { linksFound: number; skuExtracted: number; overlaysInjected: number; sampleSkus: string[] };

function getVisibleProductAnchors(): HTMLAnchorElement[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"][href*="detail.aspx"]'));
  return anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    const style = window.getComputedStyle(anchor);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function extractSkuFromAnchor(anchor: HTMLAnchorElement): { sku: string | null; absoluteUrl: string } {
  const rawHref = anchor.getAttribute('href') ?? '';
  const absoluteUrl = new URL(rawHref || anchor.href, location.href).toString();
  const match = absoluteUrl.match(SKU_REGEX);
  return { sku: match?.[1] ?? null, absoluteUrl };
}

function scan(manager: OverlayManager, reason: string): ScanStats {
  const stats: ScanStats = { linksFound: 0, skuExtracted: 0, overlaysInjected: 0, sampleSkus: [] };
  const before = manager.getOverlayCount();
  const links = getVisibleProductAnchors();
  stats.linksFound = links.length;

  for (const link of links) {
    const { sku, absoluteUrl } = extractSkuFromAnchor(link);
    if (!sku) continue;
    stats.skuExtracted += 1;
    if (stats.sampleSkus.length < 8) stats.sampleSkus.push(sku);
    manager.upsertFromAnchor(link, sku, absoluteUrl);
  }

  stats.overlaysInjected = Math.max(0, manager.getOverlayCount() - before);
  manager.schedulePositionUpdate(reason);
  void logContent('product_links_found', { reason, count: stats.linksFound });
  void logContent('sku_extracted', { reason, count: stats.skuExtracted, sample_skus: stats.sampleSkus });
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
