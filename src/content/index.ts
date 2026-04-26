import { sendMessage } from '../lib/runtime.js';

const SKU_REGEX = /\/catalog\/(\d+)\/detail\.aspx/i;
const CONTENT_BOOT_FLAG = '__wbAsinContentBooted';
const ROOT_ID = 'wb-asin-overlay-root';

type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto';
type MarkerState = 'A' | 'a' | '·' | '○' | '?' | '×' | '👁' | '!';

type OverlayEntry = {
  sku: string;
  wbUrl: string;
  linkElement: HTMLAnchorElement;
  cardElement: HTMLElement;
  overlayElement: HTMLDivElement;
  statusElement: HTMLSpanElement;
  buttonElement: HTMLButtonElement;
  menuButtonElement: HTMLButtonElement;
  menuElement: HTMLDivElement;
  hoverTimer: number | null;
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
  private readonly toastLayer: HTMLDivElement;
  private readonly overlays = new Map<string, OverlayEntry>();
  private readonly pendingLinks = new Set<string>();
  private updateQueued = false;
  private overlayPosition: OverlayPosition = 'top-left';
  private readonly cardSelectors = 'article, li, [data-nm-id], [class*="card"], [class*="product"], [class*="goods"]';

  constructor() {
    this.root = this.ensureRoot();
    this.shadow = this.root.shadowRoot ?? this.root.attachShadow({ mode: 'open' });
    this.layer = document.createElement('div');
    this.layer.className = 'overlay-layer';
    this.toastLayer = document.createElement('div');
    this.toastLayer.className = 'toast-layer';
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
      void this.handleActionTouch(sku, 'link_button').then(() => this.handleLinkClick(sku));
    });

    const menuBtn = document.createElement('button');
    menuBtn.className = 'wb-amz-menu-btn';
    menuBtn.type = 'button';
    menuBtn.textContent = '⋯';
    menuBtn.title = 'Card actions';

    const menu = this.buildMenu(sku);
    menuBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = menu.style.display !== 'block';
      menu.style.display = open ? 'block' : 'none';
      if (open) {
        void logContent('card_menu_opened', { sku });
      }
    });

    document.addEventListener('click', () => {
      menu.style.display = 'none';
    });

    overlay.append(status, btn, menuBtn, menu);
    this.layer.appendChild(overlay);

    const entry: OverlayEntry = {
      sku,
      wbUrl,
      linkElement: anchor,
      cardElement: card,
      overlayElement: overlay,
      statusElement: status,
      buttonElement: btn,
      menuButtonElement: menuBtn,
      menuElement: menu,
      hoverTimer: null
    };

    card.addEventListener('mouseenter', () => {
      if (entry.hoverTimer !== null) return;
      entry.hoverTimer = window.setTimeout(() => {
        entry.hoverTimer = null;
        void sendMessage({ type: 'markSeenByHover', wb_sku: sku, wb_url: entry.wbUrl })
          .then(() => this.refreshCardState(sku, status))
          .catch(() => {});
      }, 1200);
    });
    card.addEventListener('mouseleave', () => {
      if (entry.hoverTimer !== null) {
        clearTimeout(entry.hoverTimer);
        entry.hoverTimer = null;
      }
    });

    this.overlays.set(sku, entry);
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

  private showToast(message: string, withUndo = false): void {
    const toast = document.createElement('div');
    toast.className = 'wb-amz-toast';
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    if (withUndo) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', async () => {
        const result = await sendMessage<{ ok: boolean; undone: boolean }>({ type: 'undoLastAction' });
        if (result.undone) {
          this.showToast('Action undone');
          for (const [sku, entry] of this.overlays.entries()) {
            void this.refreshCardState(sku, entry.statusElement);
          }
        }
      });
      toast.appendChild(undoBtn);
    }

    this.toastLayer.appendChild(toast);
    void logContent('toast_shown', { message, withUndo });
    window.setTimeout(() => toast.remove(), 3200);
  }

  private updatePositions(reason: string): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    for (const [sku, entry] of this.overlays.entries()) {
      if (!entry.cardElement.isConnected || !entry.linkElement.isConnected) {
        entry.overlayElement.remove();
        this.overlays.delete(sku);
        continue;
      }

      const cardRect = entry.cardElement.getBoundingClientRect();
      if (cardRect.width <= 0 || cardRect.height <= 0 || cardRect.bottom < 0 || cardRect.top > viewport.height) {
        entry.overlayElement.style.display = 'none';
        continue;
      }

      const placement = this.resolvePlacement(entry.cardElement, cardRect, viewport);
      const overlayRect = entry.overlayElement.getBoundingClientRect();
      const width = overlayRect.width || 90;
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
    }

    void logContent('overlay_position_updated', { reason, visible_count: this.overlays.size });
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

  private async handleActionTouch(sku: string, source: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    await sendMessage({ type: 'markCardTouched', wb_sku: sku, wb_url: entry.wbUrl, source });
  }

  private async handleLinkClick(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry || this.pendingLinks.has(sku)) return;

    this.pendingLinks.add(sku);
    entry.buttonElement.disabled = true;
    entry.buttonElement.textContent = '...';
    try {
      const response = await sendMessage<{ ok: boolean; result: { status: 'created' | 'duplicate_skipped' } }>({ type: 'linkSku', wb_sku: sku, wb_url: entry.wbUrl });
      this.setMarker(entry, response.result?.status === 'duplicate_skipped' ? 'a' : 'A');
      if (response.result?.status === 'created') {
        this.showToast('Linked to active ASIN', true);
      }
      await this.refreshCardState(sku, entry.statusElement);
    } catch (error) {
      this.setMarker(entry, '!');
      this.showToast(`Link failed: ${String(error)}`);
      await logContent('link_click_error', { sku, error: String(error) });
    } finally {
      entry.buttonElement.disabled = false;
      entry.buttonElement.textContent = 'A+';
      this.pendingLinks.delete(sku);
    }
  }

  private async copyWbUrl(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    await this.handleActionTouch(sku, 'copy_wb_url');
    try {
      await navigator.clipboard.writeText(entry.wbUrl);
      await sendMessage({ type: 'recordLinkCopied', wb_sku: sku, wb_url: entry.wbUrl });
      this.showToast('WB link copied');
      await this.refreshCardState(sku, entry.statusElement);
    } catch (error) {
      await logContent('wb_link_copied_error', { sku, error: String(error) });
      this.showToast(`Copy failed: ${String(error)}`);
    }
  }

  private async rejectCard(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    const reasonCode = this.promptWithOptions('Reject reason', ['wrong_product', 'wrong_size', 'other_brand', 'bad_candidate', 'duplicate', 'not_interesting', 'other']);
    if (!reasonCode) return;
    const reasonText = window.prompt('Optional reject note', '') ?? '';
    await this.handleActionTouch(sku, 'reject');
    await sendMessage({ type: 'setRejected', wb_sku: sku, wb_url: entry.wbUrl, reasonCode, reasonText });
    this.showToast('Product rejected', true);
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async deferCard(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    const reasonCode = this.promptWithOptions('Defer reason', ['compare_size', 'check_photo', 'unsure_match', 'check_seller', 'other']);
    if (!reasonCode) return;
    const reasonText = window.prompt('Optional defer note', '') ?? '';
    await this.handleActionTouch(sku, 'defer');
    await sendMessage({ type: 'setDeferred', wb_sku: sku, wb_url: entry.wbUrl, reasonCode, reasonText });
    this.showToast('Deferred for later', true);
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async showContext(sku: string): Promise<void> {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    const response = await sendMessage<{ ok: boolean; context: { wb_sku: string; wb_url: string; seen_status: string; active_asin: string; active_links_count: number; rejected: boolean; deferred: boolean } }>({ type: 'getCardContext', wb_sku: sku, wb_url: entry.wbUrl });
    const c = response.context;
    window.alert([
      `WB SKU: ${c.wb_sku}`,
      `WB URL: ${c.wb_url}`,
      `seen_status: ${c.seen_status || '(none)'}`,
      `active ASIN: ${c.active_asin || '(none)'}`,
      `active links count: ${c.active_links_count}`,
      `rejected: ${c.rejected}`,
      `deferred: ${c.deferred}`
    ].join('\n'));
  }

  private buildMenu(sku: string): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'wb-amz-menu';

    const item = (label: string, fn: () => Promise<void>) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.style.display = 'none';
        void fn();
      });
      return btn;
    };

    menu.append(
      item('Link to active ASIN', async () => this.handleLinkClick(sku)),
      item('Copy WB URL', async () => this.copyWbUrl(sku)),
      item('Reject', async () => this.rejectCard(sku)),
      item('Defer / check later', async () => this.deferCard(sku)),
      item('Show context', async () => this.showContext(sku))
    );

    return menu;
  }

  private promptWithOptions(title: string, options: string[]): string | null {
    const input = window.prompt(`${title}: ${options.join(', ')}`, options[0]);
    if (!input) return null;
    const value = input.trim();
    if (options.includes(value)) return value;
    this.showToast(`Unknown option. Use one of: ${options.join(', ')}`);
    return null;
  }

  private async refreshCardState(sku: string, statusEl: HTMLSpanElement): Promise<void> {
    try {
      const state = await sendMessage<{ ok: boolean; linked: boolean; activeAsinLinked: boolean; seenStatus: string; rejected: boolean; deferred: boolean }>({ type: 'getCardState', wb_sku: sku });
      if (state.rejected) {
        statusEl.textContent = '×';
      } else if (state.deferred) {
        statusEl.textContent = '?';
      } else if (state.activeAsinLinked) {
        statusEl.textContent = 'A';
      } else if (state.linked) {
        statusEl.textContent = 'a';
      } else if (state.seenStatus === 'seen' || state.seenStatus === 'touched') {
        statusEl.textContent = '👁';
      } else {
        statusEl.textContent = '·';
      }
    } catch {
      statusEl.textContent = '○';
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
      .wb-amz-btn, .wb-amz-menu-btn {
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
      .wb-amz-menu-btn { padding: 4px 6px; }
      .wb-amz-btn:disabled { opacity: 0.6; cursor: wait; }
      .wb-amz-status {
        color: #5f20d4;
        font-size: 12px;
        font-weight: 700;
        min-width: 12px;
        text-align: center;
      }
      .wb-amz-menu {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        min-width: 150px;
        background: #fff;
        border: 1px solid #c8b7ff;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        display: none;
        z-index: 2;
      }
      .wb-amz-menu button {
        display: block;
        width: 100%;
        border: none;
        background: transparent;
        text-align: left;
        padding: 7px 9px;
        font-size: 12px;
        cursor: pointer;
      }
      .wb-amz-menu button:hover { background: #f5f0ff; }
      .toast-layer {
        position: fixed;
        right: 12px;
        bottom: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .wb-amz-toast {
        pointer-events: auto;
        background: #1f1437;
        color: #fff;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .wb-amz-toast button {
        border: 1px solid #fff;
        background: transparent;
        color: #fff;
        border-radius: 6px;
        padding: 2px 6px;
        cursor: pointer;
      }
    `;
    this.shadow.append(style, this.layer, this.toastLayer);
  }
}

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

  let pendingReason = 'initial';
  let scanTimer: number | null = null;
  const scheduleScan = (reason: string): void => {
    pendingReason = reason === 'popup_force_scan' ? reason : pendingReason === 'popup_force_scan' ? pendingReason : reason;
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scan(manager, pendingReason);
      pendingReason = 'idle';
      scanTimer = null;
    }, reason === 'popup_force_scan' ? 0 : 350);
  };

  const observer = new MutationObserver(() => scheduleScan('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', () => scheduleScan('scroll'), { passive: true });
  window.addEventListener('resize', () => manager.schedulePositionUpdate('resize'));
  setInterval(() => scheduleScan('interval'), 8000);
  scheduleScan('initial');
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
  if (reason === 'popup_force_scan' || reason === 'initial' || reason === 'interval') {
    void logContent('scan_samples', { reason, count: stats.skuExtracted, sample_skus: stats.sampleSkus });
  }
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
