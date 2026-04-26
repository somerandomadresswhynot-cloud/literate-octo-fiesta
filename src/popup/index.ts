import { sendMessage } from '../lib/runtime.js';

const countEl = document.getElementById('amazon-count') as HTMLSpanElement;
const activeEl = document.getElementById('active-asin') as HTMLSpanElement;
const searchInput = document.getElementById('asin-search') as HTMLInputElement;
const listEl = document.getElementById('asin-results') as HTMLUListElement;

type PopupStateResponse = { ok: boolean; amazonCount: number; activeAsin: string };
type SearchResponse = { ok: boolean; results: Array<{ asin: string; title: string }> };

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

searchInput.addEventListener('input', () => {
  void search();
});

void boot();

export {};
