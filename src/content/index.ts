import { sendMessage } from '../lib/runtime.js';
import { extractWbSkuFromUrl, getVisibleProductLinks } from '../lib/wb.js';

const CLASS_NAME = 'wb-amz-overlay';

function ensureInjected(link: HTMLAnchorElement): void {
  const sku = extractWbSkuFromUrl(link.href);
  if (!sku) return;
  const card = link.closest('article, li, .product-card, [class*="product"]') as HTMLElement | null;
  if (!card) return;
  if (card.querySelector(`.${CLASS_NAME}`)) return;

  if (getComputedStyle(card).position === 'static') {
    card.style.position = 'relative';
  }

  const wrap = document.createElement('div');
  wrap.className = CLASS_NAME;
  const status = document.createElement('span');
  status.className = 'wb-amz-status';
  status.textContent = '·';

  const btn = document.createElement('button');
  btn.className = 'wb-amz-btn';
  btn.textContent = 'A+';
  btn.title = `Link WB ${sku} to active ASIN`;
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await sendMessage<{ ok: boolean }>({ type: 'linkSku', wb_sku: sku, wb_url: link.href });
      status.textContent = 'A';
    } catch {
      status.textContent = '!';
    }
  });

  wrap.append(status, btn);
  card.appendChild(wrap);
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

function scan(): void {
  getVisibleProductLinks().forEach(ensureInjected);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('scroll', () => scan(), { passive: true });
scan();

export {};
