import { sendMessage } from '../lib/runtime.js';
import { buildReasonPayload, cardControlsRootStyle, computeAbsoluteControlPlacement, computeFloatingMenuPosition, DEFER_REASONS, mapConflictResolution, normalizeCardControlsCount, REJECT_REASONS, toDocumentCoordinates } from './ui-helpers.js';

const SKU_REGEX = /\/catalog\/(\d+)\/detail\.aspx/i;
const CONTENT_BOOT_FLAG = '__wbAsinContentBooted';
const ROOT_ID = 'wb-asin-overlay-root';
const LINK_TYPES = ['candidate', 'exact_match', 'similar', 'competitor', 'wrong_size', 'wrong_product'] as const;

type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto';
type CardPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type MarkerState = 'A' | 'a' | 'A!' | '·' | '○' | '?' | '×' | '👁' | '!' | '≡';
type SearchResult = { asin: string; title: string; brand: string; comment: string; workflow_status: string };
type CardControlsSettings = { placement: CardPlacement; offsetX: number; offsetY: number; preferAboveOverlays: boolean };

type OverlayEntry = {
  sku: string; wbUrl: string; linkElement: HTMLAnchorElement; cardElement: HTMLElement; overlayElement: HTMLDivElement;
  statusElement: HTMLSpanElement; buttonElement: HTMLButtonElement; menuButtonElement: HTMLButtonElement; selectElement: HTMLInputElement; hoverTimer: number | null;
  lastCardState: string;
};

declare global { interface Window { __wbAsinContentBooted?: boolean; } }

class OverlayManager {
  private readonly root: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly cardControlsRoot: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly dropdownLayer: HTMLDivElement;
  private readonly modalLayer: HTMLDivElement;
  private readonly toastLayer: HTMLDivElement;
  private readonly panelButton: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly selectedInfoEl: HTMLDivElement;
  private readonly bulkActionsEl: HTMLDivElement;
  private readonly activeAsinEl: HTMLDivElement;
  private readonly activeAsinSearch: HTMLInputElement;
  private readonly linkTypeSelect: HTMLSelectElement;
  private readonly overlays = new Map<string, OverlayEntry>();
  private readonly selectedSkus = new Set<string>();
  private readonly stateBySku = new Map<string, { linked: boolean; activeAsinLinked: boolean; rejected: boolean; deferred: boolean; groupCount: number; seenStatus: string; conflictPotential: boolean }>();
  private readonly pendingLinks = new Set<string>();
  private activeMenu: HTMLDivElement | null = null;
  private activeModal: HTMLDivElement | null = null;
  private restoreFocusEl: HTMLElement | null = null;
  private updateQueued = false;
  private overlayPosition: OverlayPosition = 'top-left';
  private cardControlsSettings: CardControlsSettings = { placement: 'top-left', offsetX: 8, offsetY: 8, preferAboveOverlays: true };
  private occlusionLogged = 0;
  private readonly cardSelectors = 'article, li, [data-nm-id], [class*="card"], [class*="product"], [class*="goods"]';

  constructor() {
    this.root = this.ensureRoot();
    this.cardControlsRoot = this.ensureCardControlsRoot();
    this.shadow = this.root.shadowRoot ?? this.root.attachShadow({ mode: 'open' });
    this.layer = document.createElement('div'); this.layer.className = 'overlay-layer';
    this.dropdownLayer = document.createElement('div'); this.dropdownLayer.className = 'dropdown-layer';
    this.modalLayer = document.createElement('div'); this.modalLayer.className = 'modal-layer';
    this.toastLayer = document.createElement('div'); this.toastLayer.className = 'toast-layer';
    this.panelButton = document.createElement('button'); this.panelButton.type = 'button'; this.panelButton.className = 'wb-amz-panel-button'; this.panelButton.textContent = 'WB ↔ A';
    this.panel = document.createElement('div'); this.panel.className = 'wb-amz-panel';
    this.activeAsinEl = document.createElement('div'); this.activeAsinEl.className = 'active-asin-card';
    this.activeAsinSearch = document.createElement('input'); this.activeAsinSearch.placeholder = 'Search ASIN';
    this.linkTypeSelect = document.createElement('select'); LINK_TYPES.forEach((lt) => { const o = document.createElement('option'); o.value = lt; o.textContent = lt; this.linkTypeSelect.appendChild(o); });
    this.statsEl = document.createElement('div'); this.statsEl.className = 'wb-amz-stats';
    this.selectedInfoEl = document.createElement('div'); this.selectedInfoEl.className = 'bulk-empty'; this.selectedInfoEl.textContent = 'Bulk actions appear after selecting cards.';
    this.bulkActionsEl = document.createElement('div'); this.bulkActionsEl.className = 'row';
    this.mountShadow();
  }

  async init(): Promise<void> {
    await this.refreshOverlayPositionSetting();
    await this.refreshCardControlsSettings();
    await this.refreshPanelContext();
    this.panelButton.addEventListener('click', () => {
      const open = this.panel.classList.toggle('open');
      void logContent(open ? 'panel_opened' : 'panel_closed', {});
      if (open) void this.updatePageStats();
    });
    this.activeAsinSearch.addEventListener('input', () => { void this.searchActiveAsinAndSet(); });
    this.linkTypeSelect.addEventListener('change', () => { void sendMessage({ type: 'setDefaultLinkType', linkType: this.linkTypeSelect.value }); });
    document.addEventListener('click', () => this.closeMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeTopLayer(); });
    window.addEventListener('scroll', () => this.closeMenu(), { passive: true });
    setInterval(() => { void this.refreshPanelContext(); }, 3500);
    void logContent('card_controls_strategy', { strategy: 'document_absolute' });
  }

  private closeTopLayer(): void {
    if (this.activeModal) { this.closeModal(); return; }
    this.closeMenu();
  }

  upsertFromAnchor(anchor: HTMLAnchorElement, sku: string, wbUrl: string): void {
    const card = this.findCardContainer(anchor);
    const existing = this.overlays.get(sku);
    if (existing) {
      existing.linkElement = anchor; existing.cardElement = card; existing.wbUrl = wbUrl;
      if (!this.cardControlsRoot.contains(existing.overlayElement)) this.cardControlsRoot.appendChild(existing.overlayElement);
      this.applyCardControlPosition(existing, 'card_updated');
      void logContent('card_controls_updated', { sku });
      return;
    }
    const duplicates = this.cardControlsRoot.querySelectorAll<HTMLDivElement>(`.wb-asin-card-controls[data-wb-sku="${sku}"]`);
    const normalize = normalizeCardControlsCount(duplicates.length);
    const duplicate = duplicates[0] ?? null;
    if (normalize.shouldTrimDuplicates) {
      for (let i = 1; i < duplicates.length; i += 1) duplicates[i].remove();
    }
    const overlay = duplicate ?? document.createElement('div'); overlay.className = 'wb-amz-overlay wb-asin-card-controls'; overlay.dataset.wbSku = sku;
    const status = document.createElement('span'); status.className = 'wb-amz-status'; status.textContent = '·';
    status.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (status.textContent === '≡') void this.manageGroups(sku);
    });
    const btn = document.createElement('button'); btn.className = 'wb-amz-btn'; btn.type = 'button'; btn.textContent = 'A+'; btn.setAttribute('aria-label', `Link WB ${sku} to active ASIN`);
    btn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void this.handleActionTouch(sku, 'link_button').then(() => this.handleLinkClick(sku)); });
    const menuBtn = document.createElement('button'); menuBtn.className = 'wb-amz-menu-btn'; menuBtn.type = 'button'; menuBtn.textContent = '⋯'; menuBtn.setAttribute('aria-label', 'Card actions');
    menuBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void this.openMenu(sku, menuBtn); });
    const select = document.createElement('input'); select.type = 'checkbox'; select.className = 'wb-amz-select';
    select.addEventListener('change', async () => { await this.handleActionTouch(sku, 'select'); this.toggleSelection(sku, select.checked); });
    if (!duplicate) overlay.append(select, status, btn, menuBtn);
    this.cardControlsRoot.appendChild(overlay);

    const entry: OverlayEntry = { sku, wbUrl, linkElement: anchor, cardElement: card, overlayElement: overlay, statusElement: status, buttonElement: btn, menuButtonElement: menuBtn, selectElement: select, hoverTimer: null, lastCardState: '' };
    card.addEventListener('mouseenter', () => {
      if (entry.hoverTimer !== null) return;
      entry.hoverTimer = window.setTimeout(() => { entry.hoverTimer = null; void sendMessage({ type: 'markSeenByHover', wb_sku: sku, wb_url: entry.wbUrl }).then(() => this.refreshCardState(sku, status)).catch(() => {}); }, 1200);
    });
    card.addEventListener('mouseleave', () => { if (entry.hoverTimer !== null) { clearTimeout(entry.hoverTimer); entry.hoverTimer = null; } });
    this.overlays.set(sku, entry);
    this.applyCardControlPosition(entry, 'initial_attach');
    if (this.selectedSkus.has(sku)) select.checked = true;
    void this.refreshCardState(sku, status);
    void this.updatePageStats();
    void logContent('card_controls_attached', { sku });
  }

  private toggleSelection(sku: string, selected: boolean): void {
    const entry = this.overlays.get(sku);
    if (!entry) return;
    if (selected) this.selectedSkus.add(sku); else this.selectedSkus.delete(sku);
    entry.overlayElement.classList.toggle('selected', selected);
    this.selectedInfoEl.textContent = this.selectedSkus.size > 0 ? `Selected: ${this.selectedSkus.size}` : 'Bulk actions appear after selecting cards.';
    this.bulkActionsEl.style.display = this.selectedSkus.size > 0 ? 'flex' : 'none';
    void logContent('selection_changed', { selected_count: this.selectedSkus.size });
    void this.updatePageStats();
  }

  private selectedItems(): Array<{ wb_sku: string; wb_url: string }> {
    return Array.from(this.selectedSkus).map((sku) => ({ wb_sku: sku, wb_url: this.overlays.get(sku)?.wbUrl || '' }));
  }

  private clearSelection(removeSuccessfulOnly = false): void {
    const toClear = removeSuccessfulOnly ? Array.from(this.selectedSkus) : Array.from(this.overlays.keys());
    for (const sku of toClear) {
      if (!this.selectedSkus.has(sku)) continue;
      this.selectedSkus.delete(sku);
      const entry = this.overlays.get(sku);
      if (entry) { entry.selectElement.checked = false; entry.overlayElement.classList.remove('selected'); }
    }
    this.bulkActionsEl.style.display = 'none';
    this.selectedInfoEl.textContent = 'Bulk actions appear after selecting cards.';
  }

  private async openMenu(sku: string, trigger: HTMLButtonElement): Promise<void> {
    this.closeModal(); this.closeMenu();
    const menu = await this.buildMenu(sku);
    const rect = trigger.getBoundingClientRect();
    const pos = computeFloatingMenuPosition({ left: rect.left, bottom: rect.bottom, viewportWidth: window.innerWidth });
    menu.style.left = `${pos.left}px`; menu.style.top = `${pos.top}px`;
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

  async setOverlayPosition(position: OverlayPosition): Promise<void> {
    if (this.overlayPosition === position) return;
    this.overlayPosition = position;
    if (position !== 'auto') this.cardControlsSettings.placement = position;
    await logContent('overlay_position_setting_changed', { position });
    this.schedulePositionUpdate('position_setting_changed');
  }
  async refreshOverlayPositionSetting(): Promise<void> {
    try {
      const response = await sendMessage<{ ok: boolean; position: OverlayPosition }>({ type: 'getOverlayPosition' });
      if (response.position) {
        this.overlayPosition = response.position;
        if (response.position !== 'auto') this.cardControlsSettings.placement = response.position;
      }
    } catch { this.overlayPosition = 'top-left'; }
  }
  async refreshCardControlsSettings(): Promise<void> {
    try {
      const response = await sendMessage<{ ok: boolean; settings: CardControlsSettings }>({ type: 'getCardControlsSettings' });
      if (response.settings) this.cardControlsSettings = response.settings;
    } catch {}
  }
  async setCardControlsSettings(settings: CardControlsSettings): Promise<void> {
    this.cardControlsSettings = settings;
    await logContent('card_controls_position_setting_changed', settings);
    for (const entry of this.overlays.values()) {
      this.applyCardControlPosition(entry, 'settings_changed');
    }
  }
  schedulePositionUpdate(reason: string): void { if (this.updateQueued) return; this.updateQueued = true; requestAnimationFrame(() => { this.updateQueued = false; this.updatePositions(reason); }); }
  private applyCardControlPosition(entry: OverlayEntry, reason: string): void {
    const cardRect = entry.cardElement.getBoundingClientRect();
    if (cardRect.width <= 0 || cardRect.height <= 0) return;
    const docOrigin = toDocumentCoordinates({ top: cardRect.top, left: cardRect.left }, window.scrollX, window.scrollY);
    const controlsRect = entry.overlayElement.getBoundingClientRect();
    const placement = computeAbsoluteControlPlacement(
      this.cardControlsSettings.placement,
      { width: cardRect.width, height: cardRect.height },
      docOrigin,
      { width: controlsRect.width || 96, height: controlsRect.height || 28 },
      { x: this.cardControlsSettings.offsetX, y: this.cardControlsSettings.offsetY }
    );
    entry.overlayElement.style.left = `${Math.max(0, Math.round(placement.left))}px`;
    entry.overlayElement.style.top = `${Math.max(0, Math.round(placement.top))}px`;
    entry.overlayElement.classList.toggle('wb-asin-prefer-above', this.cardControlsSettings.preferAboveOverlays);
    requestAnimationFrame(() => {
      const nextRect = entry.overlayElement.getBoundingClientRect();
      if (!nextRect.width || !nextRect.height) return;
      const precise = computeAbsoluteControlPlacement(
        this.cardControlsSettings.placement,
        { width: cardRect.width, height: cardRect.height },
        docOrigin,
        { width: nextRect.width, height: nextRect.height },
        { x: this.cardControlsSettings.offsetX, y: this.cardControlsSettings.offsetY }
      );
      entry.overlayElement.style.left = `${Math.max(0, Math.round(precise.left))}px`;
      entry.overlayElement.style.top = `${Math.max(0, Math.round(precise.top))}px`;
      if (reason === 'initial_attach' || reason === 'settings_changed' || reason === 'position_setting_changed') {
        void logContent('card_controls_positioned', { sku: entry.sku, reason, top: Math.round(precise.top), left: Math.round(precise.left) });
      }
      this.logOcclusionIfNeeded(entry, nextRect, reason);
    });
  }

  private showToast(message: string, undoType?: 'link_created' | 'rejected_set' | 'deferred_set' | 'group_added' | 'group_removed'): void {
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

  private async addToGroup(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    await logContent('group_dialog_opened', { sku });
    await this.openGroupSearchDialog(sku, entry.wbUrl);
    await this.refreshCardState(sku, entry.statusElement);
  }

  private async manageGroups(sku: string): Promise<void> {
    const entry = this.overlays.get(sku); if (!entry) return;
    const groupsRes = await sendMessage<{ ok: boolean; groups: Array<{ group_id: string; name: string; icon: string; comment: string }> }>({ type: 'getGroupsForWbSku', wb_sku: sku });
    await logContent('group_dialog_opened', { sku, mode: 'manage' });
    await new Promise<void>((resolve) => {
      const body = document.createElement('div'); body.className = 'wb-amz-form';
      const list = document.createElement('div'); list.className = 'result-list';
      const render = () => {
        list.innerHTML = '';
        for (const group of groupsRes.groups) {
          const row = document.createElement('div'); row.className = 'result-row';
          row.textContent = `${group.icon || '≡'} ${group.name}${group.comment ? ` — ${group.comment}` : ''}`;
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
          remove.addEventListener('click', async () => {
            await sendMessage({ type: 'removeWbSkuFromGroup', wb_sku: sku, group_id: group.group_id });
            this.showToast('Removed from group', 'group_removed');
            await this.refreshCardState(sku, entry.statusElement);
            this.closeModal();
            resolve();
          });
          row.appendChild(remove);
          list.appendChild(row);
        }
      };
      render();
      body.append(list);
      this.openModal('Manage groups', body, [
        { label: 'Add to group', onClick: () => { this.closeModal(); void this.addToGroup(sku).then(() => resolve()); } },
        { label: 'Create group', onClick: () => { this.closeModal(); void this.openCreateGroupDialog(sku, entry.wbUrl).then(() => resolve()); } },
        { label: 'Close', primary: true, onClick: () => { this.closeModal(); resolve(); } }
      ]);
    });
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

  private openCreateGroupDialog(sku: string, wbUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const body = document.createElement('div'); body.className = 'wb-amz-form';
      const name = document.createElement('input'); name.placeholder = 'Name (required)';
      const icon = document.createElement('input'); icon.placeholder = 'Icon (optional)';
      const comment = document.createElement('input'); comment.placeholder = 'Comment (optional)';
      const groupType = document.createElement('input'); groupType.placeholder = 'Group type (optional)';
      body.append(name, icon, comment, groupType);
      const done = () => { this.closeModal(); resolve(); };
      this.openModal('Create group', body, [
        { label: 'Cancel', onClick: done },
        {
          label: 'Create',
          onClick: async () => {
            if (!name.value.trim()) return;
            await sendMessage({ type: 'createGroup', name: name.value.trim(), icon: icon.value.trim(), comment: comment.value.trim(), group_type: groupType.value.trim() });
            this.showToast('Group created');
            done();
          }
        },
        {
          label: 'Create and add product',
          primary: true,
          onClick: async () => {
            if (!name.value.trim()) return;
            const created = await sendMessage<{ ok: boolean; group: { group_id: string } }>({ type: 'createGroup', name: name.value.trim(), icon: icon.value.trim(), comment: comment.value.trim(), group_type: groupType.value.trim() });
            await sendMessage({ type: 'addWbSkuToGroup', wb_sku: sku, wb_url: wbUrl, group_id: created.group.group_id });
            this.showToast('Added to group', 'group_added');
            done();
          }
        }
      ]);
    });
  }

  private openGroupSearchDialog(sku: string, wbUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const body = document.createElement('div'); body.className = 'wb-amz-form';
      const search = document.createElement('input'); search.placeholder = 'Search groups';
      const list = document.createElement('div'); list.className = 'result-list';
      body.append(search, list);
      const load = async () => {
        const query = search.value.trim();
        await logContent('group_search_query', { sku, query });
        const reqType = query ? 'searchGroups' : 'listGroups';
        const groupsRes = await sendMessage<{ ok: boolean; groups: Array<{ group_id: string; name: string; icon: string; comment: string; product_count: number }> }>({ type: reqType as any, query });
        const current = await sendMessage<{ ok: boolean; groups: Array<{ group_id: string }> }>({ type: 'getGroupsForWbSku', wb_sku: sku });
        const inGroup = new Set(current.groups.map((g) => g.group_id));
        list.innerHTML = '';
        for (const group of groupsRes.groups) {
          const row = document.createElement('div'); row.className = 'result-row';
          const already = inGroup.has(group.group_id);
          row.textContent = `${group.icon || '≡'} ${group.name}${group.comment ? ` — ${group.comment}` : ''} (${group.product_count ?? 0})`;
          const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.textContent = already ? 'In group' : 'Add';
          addBtn.disabled = already;
          addBtn.addEventListener('click', async () => {
            const res = await sendMessage<{ ok: boolean; status?: string }>({ type: 'addWbSkuToGroup', wb_sku: sku, wb_url: wbUrl, group_id: group.group_id });
            if (res.status === 'already_in_group') this.showToast('Already in group');
            else this.showToast('Added to group', 'group_added');
            this.closeModal();
            resolve();
          });
          row.appendChild(addBtn);
          list.appendChild(row);
        }
      };
      search.addEventListener('input', () => { void load(); });
      this.openModal('Add product to group', body, [
        { label: 'Close', onClick: () => { this.closeModal(); resolve(); } },
        { label: '+ Create new group', onClick: () => { this.closeModal(); void this.openCreateGroupDialog(sku, wbUrl).then(resolve); } }
      ]);
      void logContent('group_search_opened', { sku });
      void load();
    });
  }

  private async buildMenu(sku: string): Promise<HTMLDivElement> {
    const entry = this.overlays.get(sku);
    const state = await sendMessage<{ ok: boolean; groupCount: number }>({ type: 'getCardState', wb_sku: sku });
    const menu = document.createElement('div'); menu.className = 'wb-amz-dropdown';
    const item = (label: string, fn: () => Promise<void>) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.closeMenu(); void fn(); }); return b; };
    menu.append(item('Link to active ASIN', async () => this.handleLinkClick(sku)), item('Add to ASIN...', async () => this.addToAsin(sku)), item('Add to group...', async () => this.addToGroup(sku)));
    if (state.groupCount > 0 || entry?.statusElement.textContent === '≡') menu.append(item('Manage groups', async () => this.manageGroups(sku)));
    menu.append(item('Copy WB URL', async () => this.copyWbUrl(sku)), item('Reject', async () => this.rejectCard(sku)), item('Defer / check later', async () => this.deferCard(sku)), item('Show context', async () => this.showContext(sku)), item('Show history', async () => this.showHistory(sku)));
    return menu;
  }

  private async showHistory(sku: string): Promise<void> {
    const res = await sendMessage<{ ok: boolean; events: Array<{ created_at: string; event_type: string; payload_json: string }>; hasMore: boolean }>({ type: 'getHistoryBySku', wb_sku: sku, limit: 100 });
    const body = document.createElement('div'); body.className = 'wb-amz-form';
    const list = document.createElement('div');
    for (const evt of res.events) {
      const row = document.createElement('div');
      let details = '';
      try { details = Object.entries(JSON.parse(evt.payload_json || '{}')).slice(0, 3).map(([k, v]) => `${k}:${String(v)}`).join(', '); } catch { details = ''; }
      row.textContent = `${new Date(evt.created_at).toLocaleString()} — ${evt.event_type}${details ? ` — ${details}` : ''}`;
      list.appendChild(row);
    }
    if (res.hasMore) { const note = document.createElement('div'); note.textContent = 'Showing latest 100 events.'; list.appendChild(note); }
    body.appendChild(list);
    this.openModal('Product history', body, [{ label: 'Close', primary: true, onClick: () => this.closeModal() }]);
  }

  private async handleActionTouch(sku: string, source: string): Promise<void> { const entry = this.overlays.get(sku); if (!entry) return; await sendMessage({ type: 'markCardTouched', wb_sku: sku, wb_url: entry.wbUrl, source }); }
  private async refreshCardState(sku: string, statusEl: HTMLSpanElement): Promise<void> {
    try {
      const state = await sendMessage<{ ok: boolean; linked: boolean; activeAsinLinked: boolean; seenStatus: string; rejected: boolean; deferred: boolean; conflictPotential: boolean; groupCount: number; groupPreview: string[] }>({ type: 'getCardState', wb_sku: sku });
      statusEl.textContent =
        state.activeAsinLinked ? 'A'
          : state.conflictPotential ? 'A!'
            : state.linked ? 'a'
              : state.rejected ? '×'
                : state.deferred ? '?'
                  : state.groupCount > 0 ? '≡'
                    : (state.seenStatus === 'seen' || state.seenStatus === 'touched') ? '👁' : '·';
      this.stateBySku.set(sku, state);
      const ctx = await sendMessage<{ ok: boolean; context: { active_links_count: number; active_links: Array<{ asin: string; link_type: string }>; rejected_reason: string; deferred_reason: string; seen_status: string } }>({ type: 'getCardContext', wb_sku: sku, wb_url: this.overlays.get(sku)?.wbUrl || '' });
      const titleParts = [
        `Links: ${ctx.context.active_links_count}`,
        ctx.context.active_links[0] ? `First: ${ctx.context.active_links[0].asin} (${ctx.context.active_links[0].link_type})` : '',
        state.groupCount > 0 ? `Groups: ${state.groupPreview.join(', ')}` : '',
        state.rejected ? `Rejected: ${ctx.context.rejected_reason || '-'}` : '',
        state.deferred ? `Deferred: ${ctx.context.deferred_reason || '-'}` : '',
        ctx.context.seen_status ? `Seen: ${ctx.context.seen_status}` : ''
      ].filter(Boolean);
      statusEl.title = titleParts.join('\n');
      const entry = this.overlays.get(sku);
      if (entry) this.applyCardControlPosition(entry, 'state_refresh');
      await this.updatePageStats();
    } catch { statusEl.textContent = '○'; }
  }

  private async refreshPanelContext(): Promise<void> {
    const popup = await sendMessage<{ ok: boolean; activeAsin: string; defaultLinkType: string; amazonCount: number }>({ type: 'getPopupState' });
    this.linkTypeSelect.value = popup.defaultLinkType || 'candidate';
    const active = popup.activeAsin ? await sendMessage<{ ok: boolean; results: SearchResult[] }>({ type: 'searchAsin', query: popup.activeAsin }) : { results: [] };
    const row = active.results[0];
    this.activeAsinEl.textContent = row ? `${row.asin} — ${row.title || ''} ${row.brand || ''} ${row.comment || ''} ${row.workflow_status || ''}` : 'No active ASIN';
  }

  private async searchActiveAsinAndSet(): Promise<void> {
    const q = this.activeAsinSearch.value.trim();
    if (!q) return;
    const res = await sendMessage<{ ok: boolean; results: SearchResult[] }>({ type: 'searchAsin', query: q });
    if (!res.results[0]) return;
    await sendMessage({ type: 'setActiveAsin', asin: res.results[0].asin });
    await this.refreshPanelContext();
    for (const [sku, entry] of this.overlays.entries()) await this.refreshCardState(sku, entry.statusElement);
  }

  async updatePageStats(): Promise<void> {
    const rows = Array.from(this.stateBySku.values());
    const stats = {
      total: this.overlays.size,
      unique: this.overlays.size,
      linkedActive: rows.filter((x) => x.activeAsinLinked).length,
      linkedOther: rows.filter((x) => !x.activeAsinLinked && x.linked).length,
      linkedTotal: rows.filter((x) => x.linked).length,
      groups: rows.filter((x) => x.groupCount > 0).length,
      rejected: rows.filter((x) => x.rejected).length,
      deferred: rows.filter((x) => x.deferred).length,
      seen: rows.filter((x) => x.seenStatus === 'seen' || x.seenStatus === 'touched').length
    };
    this.statsEl.textContent = `Cards: ${stats.total} | Unique: ${stats.unique} | Seen: ${stats.seen} | Linked(active): ${stats.linkedActive} | Linked(other): ${stats.linkedOther} | Linked(total): ${stats.linkedTotal} | Groups: ${stats.groups} | Rejected: ${stats.rejected} | Deferred: ${stats.deferred} | Selected: ${this.selectedSkus.size}`;
    await logContent('page_stats_updated', { ...stats, selected: this.selectedSkus.size });
  }

  private updatePositions(reason: string): void {
    if (document.body.lastElementChild !== this.cardControlsRoot) document.body.appendChild(this.cardControlsRoot);
    for (const [sku, entry] of this.overlays.entries()) {
      if (!entry.cardElement.isConnected || !entry.linkElement.isConnected) {
        entry.overlayElement.remove();
        this.overlays.delete(sku);
        void logContent('card_controls_removed', { sku, reason });
      } else if (reason === 'mutation' || reason === 'initial' || reason === 'interval' || reason === 'resize' || reason === 'position_setting_changed' || reason === 'popup_force_scan' || reason === 'scroll_end') {
        this.applyCardControlPosition(entry, reason);
      }
    }
  }
  private logOcclusionIfNeeded(entry: OverlayEntry, rect: DOMRect, reason: string): void {
    if (this.occlusionLogged >= 5) return;
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
    const stack = document.elementsFromPoint(x, y);
    const top = stack[0] as HTMLElement | undefined;
    if (!top || entry.overlayElement.contains(top) || top === entry.overlayElement) return;
    this.occlusionLogged += 1;
    void logContent('card_controls_occluded', { sku: entry.sku, reason, top_tag: top.tagName, top_class: top.className?.toString?.().slice(0, 120) || '' });
  }
  private ensureCardControlsRoot(): HTMLDivElement {
    const existing = document.getElementById('wb-asin-card-controls-root') as HTMLDivElement | null;
    if (existing) return existing;
    const root = document.createElement('div');
    root.id = 'wb-asin-card-controls-root';
    root.setAttribute('style', cardControlsRootStyle());
    document.body.appendChild(root);
    void logContent('card_controls_absolute_root_created', {});
    return root;
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
    style.textContent = `.overlay-layer,.dropdown-layer,.modal-layer{position:fixed;inset:0;pointer-events:none}.wb-amz-panel-button{position:fixed;right:12px;top:12px;z-index:2;border:1px solid #5f20d4;color:#fff;background:#7a38ff;border-radius:10px;padding:6px 10px;font-weight:700;pointer-events:auto}.wb-amz-panel{position:fixed;right:12px;top:50px;width:340px;max-height:75vh;overflow:auto;background:#fff;border:1px solid #ccbaff;border-radius:10px;padding:10px;display:none;pointer-events:auto;font:12px Arial,sans-serif}.wb-amz-panel.open{display:block}.wb-amz-panel h3{margin:0 0 8px}.wb-amz-panel .row{display:flex;gap:6px;align-items:center;margin:6px 0}.wb-amz-btn,.wb-amz-menu-btn,.wb-amz-modal button,.wb-amz-dropdown button,.wb-amz-panel button{border:1px solid #5f20d4;color:#fff;background:#7a38ff;font-size:12px;font-weight:700;line-height:1;border-radius:8px;padding:4px 7px;cursor:pointer}.wb-amz-menu-btn{padding:4px 6px}.wb-amz-status{color:#5f20d4;font-size:12px;font-weight:700;min-width:12px;text-align:center}.wb-amz-select{margin:0}.wb-amz-dropdown{position:fixed;min-width:180px;background:#fff;border:1px solid #c8b7ff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;flex-direction:column;pointer-events:auto}.wb-amz-dropdown button{border:none;background:#fff;color:#221;padding:8px 10px;text-align:left}.wb-amz-dropdown button:hover{background:#f5f0ff}.wb-amz-modal-backdrop{position:fixed;inset:0;background:rgba(20,12,36,.42);pointer-events:auto}.wb-amz-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(500px,95vw);max-height:85vh;overflow:auto;background:#fff;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;pointer-events:auto;font-family:Arial,sans-serif}.wb-amz-modal h3{margin:0;font-size:14px}.wb-amz-modal-actions{display:flex;justify-content:flex-end;gap:8px}.wb-amz-modal-actions .primary{background:#5f20d4}.wb-amz-form{display:flex;flex-direction:column;gap:8px;font-size:12px}.wb-amz-form input,.wb-amz-form textarea,.wb-amz-form select,.wb-amz-panel input,.wb-amz-panel select{border:1px solid #ccbaff;border-radius:8px;padding:8px;font-size:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chips button{background:#f5f0ff;color:#3f2679;border:1px solid #d9cbff}.chips button.sel{background:#7a38ff;color:#fff}.result-list{max-height:220px;overflow:auto;border:1px solid #ece4ff;border-radius:8px}.result-row{display:block;width:100%;text-align:left;border:none;background:#fff;color:#222;padding:8px;font-size:12px}.result-row.sel,.result-row:hover{background:#f4efff}.toast-layer{position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;pointer-events:none}.wb-amz-toast{pointer-events:auto;background:#1f1437;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;display:inline-flex;gap:8px;align-items:center}.wb-amz-toast button{border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;padding:2px 6px;cursor:pointer}`;
    this.ensureCardDomStyle();
    const header = document.createElement('h3'); header.textContent = 'WB ↔ Amazon';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => this.panel.classList.remove('open'));
    const headerRow = document.createElement('div'); headerRow.className = 'row'; headerRow.append(header, close);
    const asinRow = document.createElement('div'); asinRow.className = 'row'; asinRow.append(this.activeAsinSearch);
    const setRow = document.createElement('div'); setRow.className = 'row'; setRow.append(this.linkTypeSelect);
    const mk = (label: string, fn: () => Promise<void> | void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { void fn(); }); return b; };
    const linkActive = mk('Link to active ASIN', async () => { await logContent('bulk_action_started', { action: 'bulk_link_active', selected: this.selectedSkus.size }); const r = await sendMessage<{ ok: boolean; summary: { succeeded: number; skipped: number } }>({ type: 'bulkLinkToActiveAsin', items: this.selectedItems(), linkType: this.linkTypeSelect.value, conflictResolution: 'skip_conflicts', rejectedResolution: 'keep_rejected' }); this.showToast(`Bulk link: ${r.summary.succeeded} linked, ${r.summary.skipped} skipped`); this.clearSelection(true); });
    const linkSelected = mk('Link to selected ASIN...', async () => { const q = this.activeAsinSearch.value.trim(); if (!q) return; const results = await sendMessage<{ ok: boolean; results: SearchResult[] }>({ type: 'searchAsin', query: q }); if (!results.results[0]) return; const r = await sendMessage<{ ok: boolean; summary: { succeeded: number; skipped: number } }>({ type: 'bulkLinkToSelectedAsin', items: this.selectedItems(), asin: results.results[0].asin, linkType: this.linkTypeSelect.value, conflictResolution: 'skip_conflicts', rejectedResolution: 'keep_rejected' }); this.showToast(`Bulk link: ${r.summary.succeeded} linked, ${r.summary.skipped} skipped`); this.clearSelection(true); });
    const addGroup = mk('Add to group...', async () => { const groups = await sendMessage<{ ok: boolean; groups: Array<{ group_id: string; name: string }> }>({ type: 'listGroups' }); if (!groups.groups[0]) return; const r = await sendMessage<{ ok: boolean; summary: { succeeded: number; duplicates: number } }>({ type: 'bulkAddToGroup', items: this.selectedItems(), group_id: groups.groups[0].group_id }); this.showToast(`Added ${r.summary.succeeded} to ${groups.groups[0].name}. Skipped ${r.summary.duplicates}`); this.clearSelection(true); });
    const reject = mk('Reject', async () => { const r = await sendMessage<{ ok: boolean; summary: { succeeded: number } }>({ type: 'bulkReject', items: this.selectedItems(), reasonCode: 'bad_candidate', reasonText: '' }); this.showToast(`Rejected ${r.summary.succeeded}`); this.clearSelection(true); });
    const defer = mk('Defer', async () => { const r = await sendMessage<{ ok: boolean; summary: { succeeded: number } }>({ type: 'bulkDefer', items: this.selectedItems(), reasonCode: 'unsure_match', reasonText: '' }); this.showToast(`Deferred ${r.summary.succeeded}`); this.clearSelection(true); });
    const clear = mk('Clear selection', () => this.clearSelection());
    this.bulkActionsEl.append(linkActive, linkSelected, addGroup, reject, defer, clear);
    this.bulkActionsEl.style.display = 'none';
    this.panel.append(headerRow, asinRow, this.activeAsinEl, setRow, this.statsEl, this.selectedInfoEl, this.bulkActionsEl);
    this.shadow.append(style, this.layer, this.dropdownLayer, this.modalLayer, this.toastLayer, this.panelButton, this.panel);
  }
  private ensureCardDomStyle(): void {
    if (document.getElementById('wb-asin-card-controls-style')) return;
    const style = document.createElement('style');
    style.id = 'wb-asin-card-controls-style';
    style.textContent = `#wb-asin-card-controls-root{${cardControlsRootStyle()}}.wb-asin-card-controls{position:absolute !important;display:inline-flex !important;align-items:center !important;gap:4px !important;background:rgba(255,255,255,.97) !important;border:1px solid #7a38ff !important;border-radius:10px !important;padding:3px 6px !important;box-shadow:0 3px 10px rgba(30,20,60,.28) !important;pointer-events:none !important;z-index:2147483647 !important;font-family:Arial,sans-serif !important;box-sizing:border-box !important}.wb-asin-card-controls.wb-asin-prefer-above{box-shadow:0 4px 12px rgba(30,20,60,.36) !important;border-color:#5f20d4 !important;background:#fff !important}.wb-asin-card-controls button,.wb-asin-card-controls input,.wb-asin-card-controls [role="button"]{all:initial;pointer-events:auto !important;box-sizing:border-box !important;font-family:Arial,sans-serif !important}.wb-asin-card-controls .wb-amz-btn,.wb-asin-card-controls .wb-amz-menu-btn{border:1px solid #5f20d4;color:#fff;background:#7a38ff;font-size:12px;font-weight:700;line-height:1;border-radius:8px;padding:4px 7px;cursor:pointer}.wb-asin-card-controls .wb-amz-menu-btn{padding:4px 6px}.wb-asin-card-controls .wb-amz-status{all:initial;color:#5f20d4;font-size:12px;font-weight:700;min-width:12px;text-align:center;cursor:pointer;pointer-events:auto !important;font-family:Arial,sans-serif !important}.wb-asin-card-controls.selected{outline:2px solid #18a058}.wb-asin-card-controls .wb-amz-select{margin:0}`;
    document.head.appendChild(style);
    void logContent('card_controls_zindex_applied', { z_index: 2147483647 });
  }
}

if (!window[CONTENT_BOOT_FLAG]) { window[CONTENT_BOOT_FLAG] = true; void startContentScript(); }

async function startContentScript(): Promise<void> {
  const manager = new OverlayManager(); await manager.init(); await logContent('content_script_loaded', { url: location.href, ready_state: document.readyState });
  chrome.runtime.onMessage.addListener((message: { type?: string; position?: OverlayPosition; settings?: CardControlsSettings }, _sender, sendResponse) => {
    if (message.type === 'pingContentScript') { sendResponse({ ok: true }); return true; }
    if (message.type === 'forceScan') { const stats = scan(manager, 'popup_force_scan'); sendResponse({ ok: true, foundLinks: stats.linksFound, extractedSkus: stats.skuExtracted, injectedOverlays: stats.overlaysInjected }); return true; }
    if (message.type === 'overlayPositionSettingChanged' && message.position) { void manager.setOverlayPosition(message.position); sendResponse({ ok: true }); return true; }
    if (message.type === 'cardControlsSettingsChanged' && message.settings) { void manager.setCardControlsSettings(message.settings); sendResponse({ ok: true }); return true; }
    return false;
  });
  let pendingReason = 'initial'; let scanTimer: number | null = null;
  const scheduleScan = (reason: string): void => { pendingReason = reason === 'popup_force_scan' ? reason : pendingReason === 'popup_force_scan' ? pendingReason : reason; if (scanTimer !== null) return; scanTimer = window.setTimeout(() => { scan(manager, pendingReason); pendingReason = 'idle'; scanTimer = null; }, reason === 'popup_force_scan' ? 0 : 350); };
  const observer = new MutationObserver(() => scheduleScan('mutation')); observer.observe(document.documentElement, { childList: true, subtree: true });
  let scrollEndTimer: number | null = null;
  window.addEventListener('scroll', () => {
    if (scrollEndTimer !== null) window.clearTimeout(scrollEndTimer);
    scrollEndTimer = window.setTimeout(() => scheduleScan('scroll_end'), 200);
  }, { passive: true });
  window.addEventListener('resize', () => scheduleScan('resize')); setInterval(() => scheduleScan('interval'), 8000); scheduleScan('initial');
}

type ScanStats = { linksFound: number; skuExtracted: number; overlaysInjected: number; sampleSkus: string[] };
function getVisibleProductAnchors(): HTMLAnchorElement[] { const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/catalog/"][href*="detail.aspx"]')); return anchors.filter((anchor) => { const rect = anchor.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return false; const style = window.getComputedStyle(anchor); return style.visibility !== 'hidden' && style.display !== 'none'; }); }
function extractSkuFromAnchor(anchor: HTMLAnchorElement): { sku: string | null; absoluteUrl: string } { const rawHref = anchor.getAttribute('href') ?? ''; const absoluteUrl = new URL(rawHref || anchor.href, location.href).toString(); const match = absoluteUrl.match(SKU_REGEX); return { sku: match?.[1] ?? null, absoluteUrl }; }
function scan(manager: OverlayManager, reason: string): ScanStats { const stats: ScanStats = { linksFound: 0, skuExtracted: 0, overlaysInjected: 0, sampleSkus: [] }; const before = manager.getOverlayCount(); const links = getVisibleProductAnchors(); stats.linksFound = links.length; for (const link of links) { const { sku, absoluteUrl } = extractSkuFromAnchor(link); if (!sku) continue; stats.skuExtracted += 1; if (stats.sampleSkus.length < 8) stats.sampleSkus.push(sku); manager.upsertFromAnchor(link, sku, absoluteUrl); } stats.overlaysInjected = Math.max(0, manager.getOverlayCount() - before); manager.schedulePositionUpdate(reason); if (reason === 'popup_force_scan' || reason === 'initial' || reason === 'interval') void logContent('scan_samples', { reason, count: stats.skuExtracted, sample_skus: stats.sampleSkus }); return stats; }
async function logContent(action: string, details: Record<string, unknown>): Promise<void> { try { await sendMessage<{ ok: boolean }>({ type: 'logDebug', level: 'info', action, details: { ...details, source: 'content' } }); } catch {} }

export {};
