import { sendMessage } from '../lib/runtime.js';
import { toLinkTypeHint, toLinkTypeLabel, toWorkflowStatusLabel } from '../content/ui-labels.js';

const countEl = document.getElementById('amazon-count') as HTMLSpanElement;
const activeEl = document.getElementById('active-asin') as HTMLSpanElement;
const searchInput = document.getElementById('asin-search') as HTMLInputElement;
const listEl = document.getElementById('asin-results') as HTMLUListElement;
const forceScanBtn = document.getElementById('force-scan-btn') as HTMLButtonElement;
const scanStatusEl = document.getElementById('scan-status') as HTMLSpanElement;
const overlayPositionEl = document.getElementById('overlay-position') as HTMLSelectElement;
const defaultLinkTypeEl = document.getElementById('default-link-type') as HTMLSelectElement;
const cardOffsetXEl = document.getElementById('card-offset-x') as HTMLInputElement;
const cardOffsetYEl = document.getElementById('card-offset-y') as HTMLInputElement;
const preferAboveOverlaysEl = document.getElementById('prefer-above-overlays') as HTMLInputElement;

type PopupStateResponse = { ok: boolean; amazonCount: number; activeAsin: string; defaultLinkType: string; linkTypes: string[] };
type SearchResponse = { ok: boolean; results: Array<{ asin: string; title: string; brand: string; comment: string; workflow_status: string }>; activeAsin: string; linkTypes: string[] };
type ForceScanResponse = { ok: boolean; foundLinks: number; extractedSkus: number; injectedOverlays: number };
type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'auto';
type CardControlsSettings = { placement: Exclude<OverlayPosition, 'auto'>; offsetX: number; offsetY: number; preferAboveOverlays: boolean };

async function boot(): Promise<void> {
  const state = await sendMessage<PopupStateResponse>({ type: 'getPopupState' });
  const overlay = await sendMessage<{ ok: boolean; position: OverlayPosition }>({ type: 'getOverlayPosition' });
  const cardControls = await sendMessage<{ ok: boolean; settings: CardControlsSettings }>({ type: 'getCardControlsSettings' });
  countEl.textContent = String(state.amazonCount ?? 0);
  activeEl.textContent = state.activeAsin || '—';
  overlayPositionEl.value = overlay.position || 'top-left';
  cardOffsetXEl.value = String(cardControls.settings?.offsetX ?? 8);
  cardOffsetYEl.value = String(cardControls.settings?.offsetY ?? 8);
  preferAboveOverlaysEl.checked = cardControls.settings?.preferAboveOverlays ?? true;
  defaultLinkTypeEl.innerHTML = '';
  for (const lt of state.linkTypes || []) {
    const opt = document.createElement('option');
    opt.value = lt;
    opt.textContent = toLinkTypeLabel(lt);
    opt.title = toLinkTypeHint(lt);
    defaultLinkTypeEl.appendChild(opt);
  }
  defaultLinkTypeEl.value = state.defaultLinkType || 'candidate';
  await search();
}

async function search(): Promise<void> {
  const response = await sendMessage<SearchResponse>({ type: 'searchAsin', query: searchInput.value });
  listEl.innerHTML = '';
  for (const product of response.results ?? []) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'result-item';
    const bits = [`${product.asin}`, product.title || '(no title)', product.brand || '', toWorkflowStatusLabel(product.workflow_status || ''), product.comment || ''].filter(Boolean);
    button.textContent = bits.join(' — ');
    button.addEventListener('click', async () => {
      await sendMessage<{ ok: boolean }>({ type: 'setActiveAsin', asin: product.asin });
      activeEl.textContent = product.asin;
    });
    li.appendChild(button);
    listEl.appendChild(li);
  }
}

// keep existing methods
async function forceScanCurrentTab(): Promise<void> { /* unchanged below */
  scanStatusEl.textContent = 'Sending...';
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  await logPopup('force_scan_requested', { tab_url: activeTab?.url ?? '', tab_id: activeTab?.id ?? null });
  if (!activeTab?.id || !activeTab.url) { scanStatusEl.textContent = 'No active tab'; return; }
  if (!isWildberriesUrl(activeTab.url)) { scanStatusEl.textContent = 'Open a wildberries.ru tab first'; return; }
  let pingOk = false;
  try { await sendMessageToTab<{ ok: boolean }>(activeTab.id, { type: 'pingContentScript' }); pingOk = true; } catch (error) {
    const message = String(error); await logPopup('force_scan_send_failed', { stage: 'initial_ping', error: message });
    if (!message.includes('Receiving end does not exist')) { scanStatusEl.textContent = `Error: ${message}`; return; }
  }
  if (!pingOk) {
    await executeContentScriptFallback(activeTab.id);
    await logPopup('content_script_injected_fallback', { tab_id: activeTab.id, file: 'content.js' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    try { await sendMessageToTab<{ ok: boolean }>(activeTab.id, { type: 'pingContentScript' }); pingOk = true; } catch (error) { scanStatusEl.textContent = `Retry ping failed: ${String(error)}`; await logPopup('force_scan_retry_result', { result: 'retry_ping_failed', error: String(error) }); return; }
  }
  const scanResponse = await sendMessageToTab<ForceScanResponse>(activeTab.id, { type: 'forceScan' });
  scanStatusEl.textContent = `Scan OK: links=${scanResponse.foundLinks}, skus=${scanResponse.extractedSkus}, injected=${scanResponse.injectedOverlays}`;
  await logPopup('force_scan_retry_result', { result: pingOk ? 'scan_success' : 'scan_unknown', ...scanResponse });
}
async function executeContentScriptFallback(tabId: number): Promise<void> { await new Promise<void>((resolve, reject) => { chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => { if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; } resolve(); }); }); }
function isWildberriesUrl(url: string): boolean { try { const parsed = new URL(url); return parsed.hostname === 'www.wildberries.ru' || parsed.hostname === 'wildberries.ru'; } catch { return false; } }
function sendMessageToTab<T>(tabId: number, message: unknown): Promise<T> { return new Promise((resolve, reject) => { chrome.tabs.sendMessage(tabId, message, (response) => { if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; } resolve(response as T); }); }); }
async function logPopup(action: string, details: Record<string, unknown>): Promise<void> { try { await sendMessage<{ ok: boolean }>({ type: 'logDebug', level: 'info', action, details: { ...details, source: 'popup' } }); } catch {} }

searchInput.addEventListener('input', () => { void search(); });
forceScanBtn.addEventListener('click', () => { void forceScanCurrentTab().catch((error: unknown) => { scanStatusEl.textContent = `Error: ${String(error)}`; }); });
overlayPositionEl.addEventListener('change', () => { void (async () => { const position = overlayPositionEl.value as OverlayPosition; await sendMessage<{ ok: boolean }>({ type: 'setOverlayPosition', position }); const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); if (tabs[0]?.id) { try { await sendMessageToTab<{ ok: boolean }>(tabs[0].id, { type: 'overlayPositionSettingChanged', position }); } catch {} } syncCardControlsSettings(); })(); });
const syncCardControlsSettings = (): void => {
  void (async () => {
    const settings: CardControlsSettings = {
      placement: (overlayPositionEl.value === 'auto' ? 'top-left' : overlayPositionEl.value) as Exclude<OverlayPosition, 'auto'>,
      offsetX: Math.max(0, Math.min(36, Number(cardOffsetXEl.value) || 0)),
      offsetY: Math.max(0, Math.min(36, Number(cardOffsetYEl.value) || 0)),
      preferAboveOverlays: preferAboveOverlaysEl.checked
    };
    await sendMessage<{ ok: boolean }>({ type: 'setCardControlsSettings', settings });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      try { await sendMessageToTab<{ ok: boolean }>(tabs[0].id, { type: 'cardControlsSettingsChanged', settings }); } catch {}
    }
  })();
};
cardOffsetXEl.addEventListener('change', syncCardControlsSettings);
cardOffsetYEl.addEventListener('change', syncCardControlsSettings);
preferAboveOverlaysEl.addEventListener('change', syncCardControlsSettings);
defaultLinkTypeEl.addEventListener('change', () => { void sendMessage({ type: 'setDefaultLinkType', linkType: defaultLinkTypeEl.value }); });

void boot();
export {};
