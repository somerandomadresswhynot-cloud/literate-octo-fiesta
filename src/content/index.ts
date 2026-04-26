import { sendMessage } from '../lib/runtime.js';
import { buildReasonPayload, DEFER_REASONS, mapConflictResolution, REJECT_REASONS } from './ui-helpers.js';

const SKU_REGEX = /\/catalog\/(\d+)\/detail\.aspx/i;
const CONTENT_BOOT_FLAG = '__wbAsinContentBooted';
const ROOT_ID = 'wb-asin-overlay-root';
const LINK_TYPES = ['candidate', 'exact_match', 'similar', 'competitor', 'wrong_size', 'wrong_product'] as const;

type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto';
type MarkerState = 'A' | 'a' | 'A!' | '·' | '○' | '?' | '×' | '👁' | '!';
type SearchResult = { asin: string; title: string; brand: string; comment: string; workflow_status: string };

type OverlayEntry = {
  sku: string; wbUrl: string; linkElement: HTMLAnchorElement; cardElement: HTMLElement; overlayElement: HTMLDivElement;
  statusElement: HTMLSpanElement; buttonElement: HTMLButtonElement; menuButtonElement: HTMLButtonElement; hoverTimer: number | null;
};

declare global { interface Window { __wbAsinContentBooted?: boolean; } }

class OverlayManager {
  private readonly root: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly dropdownLayer: HTMLDivElement;
  private readonly modalLayer: HTMLDivElement;
  private readonly toastLayer: HTMLDivElement;
  private readonly overlays = new Map<string, OverlayEntry>();
  private readonly pendingLinks = new Set<string>();
  private activeMenu: HTMLDivElement | null = null;
  private activeModal: HTMLDivElement | null = null;
  private restoreFocusEl: HTMLElement | null = null;
  private updateQueued = false;
  private overlayPosition: OverlayPosition = 'top-left';
  private readonly cardSelectors = 'article, li, [data-nm-id], [class*="card"], [class*="product"], [class*="goods"]';

  constructor() {
    this.root = this.ensureRoot();
    this.shadow = this.root.shadowRoot ?? this.root.attachShadow({ mode: 'open' });
    this.layer = document.createElement('div'); this.layer.className = 'overlay-layer';
    this.dropdownLayer = document.createElement('div'); this.dropdownLayer.className = 'dropdown-layer';
    this.modalLayer = document.createElement('div'); this.modalLayer.className = 'modal-layer';
    this.toastLayer = document.createElement('div'); this.toastLayer.className = 'toast-layer';
    this.mountShadow();
  }

  async init(): Promise<void> {
    await this.refreshOverlayPositionSetting();
    document.addEventListener('click', () => this.closeMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeTopLayer(); });
  }

  private closeTopLayer(): void {
    if (this.activeModal) { this.closeModal(); return; }
    this.closeMenu();
  }

  upsertFromAnchor(anchor: HTMLAnchorElement, sku: string, wbUrl: string): void {
    const card = this.findCardContainer(anchor);
    const existing = this.overlays.get(sku);
    if (existing) { existing.linkElement = anchor; existing.cardElement = card; existing.wbUrl = wbUrl; return; }
    const overlay = document.createElement('div'); overlay.className = 'wb-amz-overlay'; overlay.dataset.wbSku = sku;
    const status = document.createElement('span'); status.className = 'wb-amz-status'; status.textContent = '·';
    const btn = document.createElement('button'); btn.className = 'wb-amz-btn'; btn.type = 'button'; btn.textContent = 'A+'; btn.setAttribute('aria-label', `Link WB ${sku} to active ASIN`);
    btn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void this.handleActionTouch(sku, 'link_button').then(() => this.handleLinkClick(sku)); });
    const menuBtn = document.createElement('button'); menuBtn.className = 'wb-amz-menu-btn'; menuBtn.type = 'button'; menuBtn.textContent = '⋯'; menuBtn.setAttribute('aria-label', 'Card actions');
    menuBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.openMenu(sku, menuBtn); });
    overlay.append(status, btn, menuBtn);
    this.layer.appendChild(overlay);

    const entry: OverlayEntry = { sku, wbUrl, linkElement: anchor, cardElement: card, overlayElement: overlay, statusElement: status, buttonElement: btn, menuButtonElement: menuBtn, hoverTimer: null };
    card.addEventListener('mouseenter', () => {
      if (entry.hoverTimer !== null) return;
      entry.hoverTimer = window.setTimeout(() => { entry.hoverTimer = null; void sendMessage({ type: 'markSeenByHover', wb_sku: sku, wb_url: entry.wbUrl }).then(() => this.refreshCardState(sku, status)).catch(() => {}); }, 1200);
    });
    card.addEventListener('mouseleave', () => { if (entry.hoverTimer !== null) { clearTimeout(entry.hoverTimer); entry.hoverTimer = null; } });
    this.overlays.set(sku, entry);
    void this.refreshCardState(sku, status);
  }

  private openMenu(sku: string, trigger: HTMLButtonElement): void {
    this.closeModal(); this.closeMenu();
    const menu = this.buildMenu(sku);
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left)}px`; menu.style.top = `${rect.bottom + 4}px`;
    this.dropdownLayer.appendChild(menu); this.activeMenu = menu;
    void logContent('ui_menu_opened', { sku });
  }

  private closeMenu(): void {
    if (!this.activeMenu) return;
    this.activeMenu.remove(); this.activeMenu = null;
    void logContent('ui_menu_closed', {});
  }

  private openModal(title: string, body: HTMLElement, actions: Array<{ label: string; primary?: boolean; onClick: () => void }>, trigger?: HTMLElement): void {
    this.closeMenu(); this.closeModal();
    const backdrop = document.createElement('div'); backdrop.className = 'wb-amz-modal-backdrop'; backdrop.addEventListener('click', () => this.closeModal());
    const modal = document.createElement('div'); modal.className = 'wb-amz-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-label', title);
    const h = document.createElement('h3'); h.textContent = title;
    const footer = document.createElement('div'); footer.className = 'wb-amz-modal-actions';
    actions.forEach((a) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; b.className = a.primary ? 'primary' : ''; b.addEventListener('click', a.onClick); footer.appendChild(b); });
    modal.append(h, body, footer);
    this.modalLayer.append(backdrop, modal);
    this.activeModal = modal;
    this.restoreFocusEl = trigger ?? (document.activeElement as HTMLElement | null);
    const focusable = modal.querySelector<HTMLElement>('input, textarea, select, button');
    focusable?.focus();
    void logContent('ui_dialog_opened', { title });
  }

  private closeModal(): void {
    if (!this.activeModal) return;
    this.modalLayer.innerHTML = '';
    this.activeModal = null;
    this.restoreFocusEl?.focus?.();
    void logContent('ui_dialog_closed', {});
  }

  getOverlayCount(): number { return this.overlays.size; }

  async setOverlayPosition(position: OverlayPosition): Promise<void> { if (this.overlayPosition === position) return; this.overlayPosition = position; await logContent('overlay_position_setting_changed', { position }); this.schedulePositionUpdate('position_setting_changed'); }
  async refreshOverlayPositionSetting(): Promise<void> { try { const response = await sendMessage<{ ok: boolean; position: OverlayPosition }>({ type: 'getOverlayPosition' }); if (response.position) this.overlayPosition = response.position; } catch { this.overlayPosition = 'top-left'; } }
  schedulePositionUpdate(reason: string): void { if (this.updateQueued) return; this.updateQueued = true; requestAnimationFrame(() => { this.updateQueued = false; this.updatePositions(reason); }); }

  private showToast(message: string, undoType?: 'link_created' | 'rejected_set' | 'deferred_set'): void {
    const toast = document.createElement('div'); toast.className = 'wb-amz-toast';
    const text = document.createElement('span'); text.textContent = message; toast.appendChild(text);
    if (undoType) {
      const undoBtn = document.createElement('button'); undoBtn.type = 'button'; undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', async () => {
        await logContent('ui_toast_undo_clicked', { undoType });
        const result = await sendMessage<{ ok: boolean; undone: boolean }>({ type: 'undoLastAction' });
        if (result.undone) { this.showToast('Action undone'); for (const [sku, entry] of this.overlays.entries()) void this.refreshCardState(sku, entry.statusElement); }
      });
      toast.appendChild(undoBtn);
    }
    this.toastLayer.appendChild(toast);
    void logContent('ui_toast_shown', { message, undoType });
    window.setTimeout(() => toast.remove(), 3200);
  }

  private async handleLinkClick(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry || this.pendingLinks.has(sku)) return;
    this.pendingLinks.add(sku); entry.buttonElement.disabled = true; entry.buttonElement.textContent = '...';
    try { await this.linkWithFlow({ sku, wbUrl: entry.wbUrl, asin: '', useActiveAsin: true, source: 'A+' }); await this.refreshCardState(sku, entry.statusElement); }
    catch (error) { this.setMarker(entry, '!'); this.showToast(`Link failed: ${String(error)}`); await logContent('ui_error', { sku, error: String(error) }); }
    finally { entry.buttonElement.disabled = false; entry.buttonElement.textContent = 'A+'; this.pendingLinks.delete(sku); }
  }

  private async linkWithFlow(params: { sku: string; wbUrl: string; asin: string; useActiveAsin: boolean; linkType?: string; source: 'A+' | 'menu' }): Promise<void> {
    let payload: Record<string, unknown> = params.useActiveAsin ? { type: 'linkSku', wb_sku: params.sku, wb_url: params.wbUrl }
      : { type: 'linkSkuToAsin', wb_sku: params.sku, wb_url: params.wbUrl, asin: params.asin, linkType: params.linkType };
    while (true) {
      const response = await sendMessage<{ ok: boolean; result: { status: string; existing_links?: Array<{ asin: string; link_type: string }>; selected_title?: string; existing_titles?: Record<string, string> } }>(payload);
      const status = response.result?.status;
      if (status === 'created') { this.showToast('Link created', 'link_created'); return; }
      if (status === 'duplicate_skipped') { this.showToast('Link already exists'); return; }
      if (status === 'rejected_confirmation_required') {
        await logContent('ui_rejected_link_dialog_opened', { sku: params.sku });
        const decision = await this.openRejectedLinkDialog(params);
        if (!decision) return;
        payload = { ...(payload as Record<string, unknown>), rejectedResolution: decision };
        continue;
      }
      if (status === 'conflict_detected') {
        await logContent('ui_conflict_dialog_opened', { sku: params.sku });
        const decision = await this.openConflictDialog(response.result.existing_links || [], params);
        const mapped = mapConflictResolution(decision);
        if (!mapped) return;
        await logContent('ui_conflict_resolution_selected', { sku: params.sku, resolution: mapped });
        payload = { ...(payload as Record<string, unknown>), conflictResolution: mapped };
        continue;
      }
      return;
    }
  }

  private async addToAsin(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    await logContent('ui_add_to_asin_opened', { sku });
    const result = await this.openAsinSearchDialog(sku);
    if (!result) return;
    await logContent('ui_add_to_asin_selected', { sku, asin: result.asin, link_type: result.linkType });
    await this.linkWithFlow({ sku, wbUrl: entry.wbUrl, asin: result.asin, linkType: result.linkType, useActiveAsin: false, source: 'menu' });
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async copyWbUrl(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    await this.handleActionTouch(sku, 'copy_wb_url');
    try { await navigator.clipboard.writeText(entry.wbUrl); await sendMessage({ type: 'recordLinkCopied', wb_sku: sku, wb_url: entry.wbUrl }); this.showToast('WB link copied'); }
    catch (error) { this.showToast(`Copy failed: ${String(error)}`); await logContent('ui_error', { sku, error: String(error) }); }
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async rejectCard(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    const data = await this.openReasonDialog('Reject product', REJECT_REASONS as unknown as string[], 'Reject', entry.menuButtonElement);
    if (!data) return;
    const payload = buildReasonPayload(data.reasonCode, data.reasonText);
    await this.handleActionTouch(sku, 'reject');
    await sendMessage({ type: 'setRejected', wb_sku: sku, wb_url: entry.wbUrl, ...payload });
    await logContent('ui_reject_confirmed', { sku, reason: payload.reasonCode });
    this.showToast('Product rejected', 'rejected_set');
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async deferCard(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    const data = await this.openReasonDialog('Defer / check later', DEFER_REASONS as unknown as string[], 'Defer', entry.menuButtonElement);
    if (!data) return;
    const payload = buildReasonPayload(data.reasonCode, data.reasonText);
    await this.handleActionTouch(sku, 'defer');
    await sendMessage({ type: 'setDeferred', wb_sku: sku, wb_url: entry.wbUrl, ...payload });
    await logContent('ui_defer_confirmed', { sku, reason: payload.reasonCode });
    this.showToast('Deferred for later', 'deferred_set');
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async showContext(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    const response = await sendMessage<{ ok: boolean; context: { wb_sku: string; wb_url: string; seen_status: string; active_asin: string; active_links_count: number; rejected: boolean; deferred: boolean; rejected_reason?: string; deferred_reason?: string; active_links?: Array<{ asin: string; link_type: string }> } }>({ type: 'getCardContext', wb_sku: sku, wb_url: entry.wbUrl });
    const c = response.context;
    const body = document.createElement('div'); body.className = 'wb-amz-form';
    body.innerHTML = `<p><b>WB SKU:</b> ${c.wb_sku}</p><p><b>WB URL:</b> ${c.wb_url}</p><p><b>seen_status:</b> ${c.seen_status || '(none)'}</p><p><b>active ASIN:</b> ${c.active_asin || '(none)'}</p><p><b>active links count:</b> ${c.active_links_count}</p><p><b>active links:</b> ${(c.active_links || []).map((x) => `${x.asin} (${x.link_type})`).join(', ') || '(none)'}</p><p><b>rejected:</b> ${c.rejected} ${c.rejected_reason || ''}</p><p><b>deferred:</b> ${c.deferred} ${c.deferred_reason || ''}</p>`;
    this.openModal('Context', body, [
      { label: 'Copy WB URL', onClick: () => { void navigator.clipboard.writeText(c.wb_url); this.closeModal(); this.showToast('WB link copied'); } },
      { label: 'Close', primary: true, onClick: () => this.closeModal() }
    ], entry.menuButtonElement);
  }

  private openReasonDialog(title: string, reasons: string[], confirmLabel: string, trigger: HTMLElement): Promise<{ reasonCode: string; reasonText: string } | null> {
    return new Promise((resolve) => {
      const body = document.createElement('div'); body.className = 'wb-amz-form';
      const quick = document.createElement('div'); quick.className = 'chips';
      let selected = reasons[0];
      const note = document.createElement('textarea'); note.placeholder = 'Optional note';
      reasons.forEach((r, idx) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = r; if (idx === 0) b.classList.add('sel'); b.addEventListener('click', () => { selected = r; quick.querySelectorAll('button').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); }); quick.appendChild(b); });
      body.append(quick, note);
      const done = (value: { reasonCode: string; reasonText: string } | null) => { this.closeModal(); resolve(value); };
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done({ reasonCode: selected, reasonText: note.value }); } });
      this.openModal(title, body, [{ label: 'Cancel', onClick: () => done(null) }, { label: confirmLabel, primary: true, onClick: () => done({ reasonCode: selected, reasonText: note.value }) }], trigger);
    });
  }

  private openAsinSearchDialog(sku: string): Promise<{ asin: string; linkType: string } | null> {
    return new Promise((resolve) => {
      const body = document.createElement('div'); body.className = 'wb-amz-form';
      const search = document.createElement('input'); search.placeholder = 'Search by asin/title/brand/category/keywords/comment/workflow_status';
      const select = document.createElement('select'); LINK_TYPES.forEach((lt) => { const o = document.createElement('option'); o.value = lt; o.textContent = lt; select.appendChild(o); });
      const list = document.createElement('div'); list.className = 'result-list';
      let selectedAsin = '';
      const render = (rows: SearchResult[]) => {
        list.innerHTML = '';
        rows.forEach((r, idx) => {
          const row = document.createElement('button'); row.type = 'button'; row.className = 'result-row';
          row.textContent = `${r.asin} — ${r.title || ''} ${r.brand ? `(${r.brand})` : ''} ${r.workflow_status || r.comment || ''}`;
          row.addEventListener('click', () => { selectedAsin = r.asin; list.querySelectorAll('.result-row').forEach((x) => x.classList.remove('sel')); row.classList.add('sel'); });
          if (idx === 0 && !selectedAsin) { selectedAsin = r.asin; row.classList.add('sel'); }
          list.appendChild(row);
        });
      };
      const fetchResults = async () => {
        await logContent('ui_add_to_asin_search', { sku, query: search.value });
        const res = await sendMessage<{ ok: boolean; results: SearchResult[] }>({ type: 'searchAsin', query: search.value });
        render(res.results);
      };
      search.addEventListener('input', () => { void fetchResults(); });
      body.append(search, list, select);
      const done = (value: { asin: string; linkType: string } | null) => { this.closeModal(); resolve(value); };
      this.openModal('Add WB product to ASIN', body, [
        { label: 'Cancel', onClick: () => done(null) },
        { label: 'Add', primary: true, onClick: () => done(selectedAsin ? { asin: selectedAsin, linkType: select.value } : null) }
      ]);
      void fetchResults();
    });
  }

  private openConflictDialog(existingLinks: Array<{ asin: string; link_type: string }>, params: { asin: string; linkType?: string }): Promise<'cancel' | 'add_second_link' | 'replace_existing'> {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.innerHTML = `<p><b>Existing links:</b> ${(existingLinks.map((x) => `${x.asin} (${x.link_type})`).join(', '))}</p><p><b>New link:</b> ${params.asin || '(active ASIN)'} (${params.linkType || 'candidate'})</p>`;
      const done = (v: 'cancel' | 'add_second_link' | 'replace_existing') => { this.closeModal(); resolve(v); };
      this.openModal('Conflict detected', body, [
        { label: 'Cancel', onClick: () => done('cancel') },
        { label: 'Add second link', onClick: () => done('add_second_link') },
        { label: 'Replace existing links', primary: true, onClick: () => done('replace_existing') }
      ]);
    });
  }

  private openRejectedLinkDialog(params: { asin: string; linkType?: string }): Promise<'keep_rejected' | 'clear_rejected' | null> {
    return new Promise((resolve) => {
      const body = document.createElement('div'); body.innerHTML = `<p>Selected ASIN: ${params.asin || '(active ASIN)'}</p><p>Link type: ${params.linkType || 'candidate'}</p>`;
      const done = (v: 'keep_rejected' | 'clear_rejected' | null) => { this.closeModal(); resolve(v); };
      this.openModal('Product is rejected', body, [
        { label: 'Cancel', onClick: () => done(null) },
        { label: 'Link and keep rejected', onClick: () => done('keep_rejected') },
        { label: 'Clear rejected and link', primary: true, onClick: () => done('clear_rejected') }
      ]);
    });
  }

  private buildMenu(sku: string): HTMLDivElement {
    const menu = document.createElement('div'); menu.className = 'wb-amz-dropdown';
    const item = (label: string, fn: () => Promise<void>) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.closeMenu(); void fn(); }); return b; };
    menu.append(item('Link to active ASIN', async () => this.handleLinkClick(sku)), item('Add to ASIN...', async () => this.addToAsin(sku)), item('Copy WB URL', async () => this.copyWbUrl(sku)), item('Reject', async () => this.rejectCard(sku)), item('Defer / check later', async () => this.deferCard(sku)), item('Show context', async () => this.showContext(sku)));
    return menu;
  }

  private async handleActionTouch(sku: string, source: string): Promise<void> { const entry = this.overlays.get(sku); if (!entry) return; await sendMessage({ type: 'markCardTouched', wb_sku: sku, wb_url: entry.wbUrl, source }); }
  private async refreshCardState(sku: string, statusEl: HTMLSpanElement): Promise<void> {
    try {
      const state = await sendMessage<{ ok: boolean; linked: boolean; activeAsinLinked: boolean; seenStatus: string; rejected: boolean; deferred: boolean; conflictPotential: boolean }>({ type: 'getCardState', wb_sku: sku });
      statusEl.textContent = state.rejected ? '×' : state.deferred ? '?' : state.activeAsinLinked ? 'A' : state.conflictPotential ? 'A!' : state.linked ? 'a' : (state.seenStatus === 'seen' || state.seenStatus === 'touched') ? '👁' : '·';
    } catch { statusEl.textContent = '○'; }
  }

  private updatePositions(reason: string): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    for (const [sku, entry] of this.overlays.entries()) {
      if (!entry.cardElement.isConnected || !entry.linkElement.isConnected) { entry.overlayElement.remove(); this.overlays.delete(sku); continue; }
      const cardRect = entry.cardElement.getBoundingClientRect();
      if (cardRect.width <= 0 || cardRect.height <= 0 || cardRect.bottom < 0 || cardRect.top > viewport.height) { entry.overlayElement.style.display = 'none'; continue; }
      const placement = this.resolvePlacement(entry.cardElement, cardRect, viewport);
      const overlayRect = entry.overlayElement.getBoundingClientRect();
      const width = overlayRect.width || 90; const height = overlayRect.height || 28; const margin = 8;
      let left = cardRect.left + margin; let top = cardRect.top + margin;
      if (placement.includes('right')) left = cardRect.right - width - margin;
      if (placement.includes('bottom')) top = cardRect.bottom - height - margin;
      left = Math.max(0, Math.min(viewport.width - width, left)); top = Math.max(0, Math.min(viewport.height - height, top));
      entry.overlayElement.style.display = 'inline-flex'; entry.overlayElement.style.left = `${Math.round(left)}px`; entry.overlayElement.style.top = `${Math.round(top)}px`;
    }
    void logContent('overlay_position_updated', { reason, visible_count: this.overlays.size });
  }
  private resolvePlacement(card: HTMLElement, rect: DOMRect, viewport: { width: number; height: number }): Exclude<OverlayPosition, 'auto'> {
    if (this.overlayPosition !== 'auto') return this.overlayPosition;
    const topLeftBlocked = this.hasTopLeftBadge(card) || rect.left + 56 > viewport.width || rect.top + 28 > viewport.height;
    if (!topLeftBlocked) return 'top-left'; if (!this.hasTopRightFavorite(card)) return 'top-right'; if (rect.bottom - 28 >= 0) return 'bottom-right'; return 'bottom-left';
  }
  private hasTopLeftBadge(card: HTMLElement): boolean { const badge = card.querySelector<HTMLElement>('[class*="badge"], [class*="sticker"], [class*="sale"], [class*="discount"], [data-tag], [class*="label"]'); if (!badge) return false; const cardRect = card.getBoundingClientRect(); const badgeRect = badge.getBoundingClientRect(); return badgeRect.left <= cardRect.left + cardRect.width * 0.45 && badgeRect.top <= cardRect.top + cardRect.height * 0.35; }
  private hasTopRightFavorite(card: HTMLElement): boolean { return Boolean(card.querySelector('[class*="favorite"], [class*="bookmark"], [class*="heart"], [aria-label*="Избран"], [aria-label*="Favorite"]')); }
  private findCardContainer(anchor: HTMLAnchorElement): HTMLElement { const closest = anchor.closest(this.cardSelectors) as HTMLElement | null; if (closest) return closest; let level = 0; let node: HTMLElement | null = anchor.parentElement; while (node && level < 6) { const rect = node.getBoundingClientRect(); if (rect.width > 120 && rect.height > 150) return node; node = node.parentElement; level += 1; } return anchor; }
  private setMarker(entry: OverlayEntry, value: MarkerState): void { entry.statusElement.textContent = value; }
  private ensureRoot(): HTMLDivElement { const existing = document.getElementById(ROOT_ID) as HTMLDivElement | null; if (existing) return existing; const root = document.createElement('div'); root.id = ROOT_ID; root.style.position = 'fixed'; root.style.inset = '0'; root.style.pointerEvents = 'none'; root.style.zIndex = '2147483646'; document.body.appendChild(root); return root; }

  private mountShadow(): void {
    if (this.shadow.querySelector('style')) return;
    const style = document.createElement('style');
    style.textContent = `.overlay-layer,.dropdown-layer,.modal-layer{position:fixed;inset:0;pointer-events:none}.wb-amz-overlay{position:fixed;display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.96);border:1px solid #7a38ff;border-radius:10px;padding:3px 6px;box-shadow:0 2px 6px rgba(30,20,60,.2);pointer-events:auto;font-family:Arial,sans-serif}.wb-amz-btn,.wb-amz-menu-btn,.wb-amz-modal button,.wb-amz-dropdown button{border:1px solid #5f20d4;color:#fff;background:#7a38ff;font-size:12px;font-weight:700;line-height:1;border-radius:8px;padding:4px 7px;cursor:pointer}.wb-amz-menu-btn{padding:4px 6px}.wb-amz-status{color:#5f20d4;font-size:12px;font-weight:700;min-width:12px;text-align:center}.wb-amz-dropdown{position:fixed;min-width:180px;background:#fff;border:1px solid #c8b7ff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;flex-direction:column;pointer-events:auto}.wb-amz-dropdown button{border:none;background:#fff;color:#221;padding:8px 10px;text-align:left}.wb-amz-dropdown button:hover{background:#f5f0ff}.wb-amz-modal-backdrop{position:fixed;inset:0;background:rgba(20,12,36,.42);pointer-events:auto}.wb-amz-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(500px,95vw);max-height:85vh;overflow:auto;background:#fff;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;pointer-events:auto;font-family:Arial,sans-serif}.wb-amz-modal h3{margin:0;font-size:14px}.wb-amz-modal-actions{display:flex;justify-content:flex-end;gap:8px}.wb-amz-modal-actions .primary{background:#5f20d4}.wb-amz-form{display:flex;flex-direction:column;gap:8px;font-size:12px}.wb-amz-form input,.wb-amz-form textarea,.wb-amz-form select{border:1px solid #ccbaff;border-radius:8px;padding:8px;font-size:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chips button{background:#f5f0ff;color:#3f2679;border:1px solid #d9cbff}.chips button.sel{background:#7a38ff;color:#fff}.result-list{max-height:220px;overflow:auto;border:1px solid #ece4ff;border-radius:8px}.result-row{display:block;width:100%;text-align:left;border:none;background:#fff;color:#222;padding:8px;font-size:12px}.result-row.sel,.result-row:hover{background:#f4efff}.toast-layer{position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;pointer-events:none}.wb-amz-toast{pointer-events:auto;background:#1f1437;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;display:inline-flex;gap:8px;align-items:center}.wb-amz-toast button{border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;padding:2px 6px;cursor:pointer}`;
    this.shadow.append(style, this.layer, this.dropdownLayer, this.modalLayer, this.toastLayer);
  }
}

if (!window[CONTENT_BOOT_FLAG]) { window[CONTENT_BOOT_FLAG] = true; void startContentScript(); }

async function startContentScript(): Promise<void> {
  const manager = new OverlayManager(); await manager.init(); await logContent('content_script_loaded', { url: location.href, ready_state: document.readyState });
  chrome.runtime.onMessage.addListener((message: { type?: string; position?: OverlayPosition }, _sender, sendResponse) => {
    if (message.type === 'pingContentScript') { sendResponse({ ok: true }); return true; }
    if (message.type === 'forceScan') { const stats = scan(manager, 'popup_force_scan'); sendResponse({ ok: true, foundLinks: stats.linksFound, extractedSkus: stats.skuExtracted, injectedOverlays: stats.overlaysInjected }); return true; }
    if (message.type === 'overlayPositionSettingChanged' && message.position) { void manager.setOverlayPosition(message.position); sendResponse({ ok: true }); return true; }
    return false;
  });
  let pendingReason = 'initial'; let scanTimer: number | null = null;
  const scheduleScan = (reason: string): void => { pendingReason = reason === 'popup_force_scan' ? reason : pendingReason === 'popup_force_scan' ? pendingReason : reason; if (scanTimer !== null) return; scanTimer = window.setTimeout(() => { scan(manager, pendingReason); pendingReason = 'idle'; scanTimer = null; }, reason === 'popup_force_scan' ? 0 : 350); };
  const observer = new MutationObserver(() => scheduleScan('mutation')); observer.observe(document.documentElement, { childList: true, subtree: true }); window.addEventListener('scroll', () => scheduleScan('scroll'), { passive: true }); window.addEventListener('resize', () => manager.schedulePositionUpdate('resize')); setInterval(() => scheduleScan('interval'), 8000); scheduleScan('initial');
}

type ScanStats = { linksFound: number; skuExtracted: number; overlaysInjected: number; sampleSkus: string[] };
function getVisibleProductAnchors(): HTMLAnchorElement[] { const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"][href*="detail.aspx"]')); return anchors.filter((anchor) => { const rect = anchor.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return false; const style = window.getComputedStyle(anchor); return style.visibility !== 'hidden' && style.display !== 'none'; }); }
function extractSkuFromAnchor(anchor: HTMLAnchorElement): { sku: string | null; absoluteUrl: string } { const rawHref = anchor.getAttribute('href') ?? ''; const absoluteUrl = new URL(rawHref || anchor.href, location.href).toString(); const match = absoluteUrl.match(SKU_REGEX); return { sku: match?.[1] ?? null, absoluteUrl }; }
function scan(manager: OverlayManager, reason: string): ScanStats { const stats: ScanStats = { linksFound: 0, skuExtracted: 0, overlaysInjected: 0, sampleSkus: [] }; const before = manager.getOverlayCount(); const links = getVisibleProductAnchors(); stats.linksFound = links.length; for (const link of links) { const { sku, absoluteUrl } = extractSkuFromAnchor(link); if (!sku) continue; stats.skuExtracted += 1; if (stats.sampleSkus.length < 8) stats.sampleSkus.push(sku); manager.upsertFromAnchor(link, sku, absoluteUrl); } stats.overlaysInjected = Math.max(0, manager.getOverlayCount() - before); manager.schedulePositionUpdate(reason); if (reason === 'popup_force_scan' || reason === 'initial' || reason === 'interval') void logContent('scan_samples', { reason, count: stats.skuExtracted, sample_skus: stats.sampleSkus }); return stats; }
async function logContent(action: string, details: Record<string, unknown>): Promise<void> { try { await sendMessage<{ ok: boolean }>({ type: 'logDebug', level: 'info', action, details: { ...details, source: 'content' } }); } catch {} }

export {};
