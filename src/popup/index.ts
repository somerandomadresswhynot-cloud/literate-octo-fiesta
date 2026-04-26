import { sendMessage } from '../lib/runtime.js';

const countEl = document.getElementById('amazon-count') as HTMLSpanElement;
const activeEl = document.getElementById('active-asin') as HTMLSpanElement;
const searchInput = document.getElementById('asin-search') as HTMLInputElement;
const listEl = document.getElementById('asin-results') as HTMLUListElement;
const forceScanBtn = document.getElementById('force-scan-btn') as HTMLButtonElement;
const scanStatusEl = document.getElementById('scan-status') as HTMLSpanElement;

type PopupStateResponse = { ok: boolean; amazonCount: number; activeAsin: string };
type SearchResponse = { ok: boolean; results: Array<{ asin: string; title: string }> };
type ForceScanResponse = { ok: boolean; foundLinks: number; extractedSkus: number; injectedOverlays: number };

async function boot(): Promise<void> {
  const state = await sendMessage<PopupStateResponse>({ type: 'getPopupState' });
  countEl.textContent = String(state.amazonCount ?? 0);
  activeEl.textContent = state.activeAsin || '—';
  await search();
}

async function search(): Promise<void> {
  const response = await sendMessage<SearchResponse>({ type: 'searchAsin', query: searchInput.value });
  listEl.innerHTML = '';
  for (const product of response.results ?? []) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'result-item';
    button.textContent = `${product.asin} — ${product.title || '(no title)'}`;
    button.addEventListener('click', async () => {
      await sendMessage<{ ok: boolean }>({ type: 'setActiveAsin', asin: product.asin });
      activeEl.textContent = product.asin;
    });
    li.appendChild(button);
    listEl.appendChild(li);
  }
}

async function forceScanCurrentTab(): Promise<void> {
  scanStatusEl.textContent = 'Sending...';
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  await logPopup('force_scan_requested', { tab_url: activeTab?.url ?? '', tab_id: activeTab?.id ?? null });

  if (!activeTab?.id || !activeTab.url) {
    scanStatusEl.textContent = 'No active tab';
    return;
  }

  if (!isWildberriesUrl(activeTab.url)) {
    scanStatusEl.textContent = 'Open a wildberries.ru tab first';
    return;
  }

  try {
    const response = await sendMessageToTab<ForceScanResponse>(activeTab.id, { type: 'forceScan' });
    scanStatusEl.textContent = `Scan OK: links=${response.foundLinks}, skus=${response.extractedSkus}, injected=${response.injectedOverlays}`;
    await logPopup('force_scan_retry_result', { result: 'initial_success', ...response });
    return;
  } catch (error) {
    const message = String(error);
    await logPopup('force_scan_send_failed', { error: message });
    if (!message.includes('Receiving end does not exist')) {
      scanStatusEl.textContent = `Error: ${message}`;
      return;
    }
  }

  await executeContentScriptFallback(activeTab.id);
  await logPopup('content_script_injected_fallback', { tab_id: activeTab.id });

  try {
    const retry = await sendMessageToTab<ForceScanResponse>(activeTab.id, { type: 'forceScan' });
    scanStatusEl.textContent = `Scan OK: links=${retry.foundLinks}, skus=${retry.extractedSkus}, injected=${retry.injectedOverlays}`;
    await logPopup('force_scan_retry_result', { result: 'retry_success', ...retry });
  } catch (error) {
    scanStatusEl.textContent = `Retry failed: ${String(error)}`;
    await logPopup('force_scan_retry_result', { result: 'retry_failed', error: String(error) });
  }
}

async function executeContentScriptFallback(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/index.js']
    }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function isWildberriesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.wildberries.ru' || parsed.hostname === 'wildberries.ru';
  } catch {
    return false;
  }
}

function sendMessageToTab<T>(tabId: number, message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as T);
    });
  });
}

async function logPopup(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await sendMessage<{ ok: boolean }>({ type: 'logDebug', level: 'info', action, details: { ...details, source: 'popup' } });
  } catch {
    // ignore
  }
}

searchInput.addEventListener('input', () => {
  void search();
});

forceScanBtn.addEventListener('click', () => {
  void forceScanCurrentTab();
});

void boot();

export {};
