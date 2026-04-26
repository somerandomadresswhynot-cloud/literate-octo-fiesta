import { sendMessage } from '../lib/runtime.js';

const importInput = document.getElementById('import-csv') as HTMLInputElement;
const importStatus = document.getElementById('import-status') as HTMLDivElement;
const summaryEl = document.getElementById('summary') as HTMLPreElement;

(document.getElementById('import-btn') as HTMLButtonElement).addEventListener('click', async () => {
  const file = importInput.files?.[0];
  if (!file) {
    importStatus.textContent = 'Choose amazon_products.csv first';
    return;
  }
  const text = await file.text();
  const result = await sendMessage<{ ok: boolean; imported: number }>({ type: 'importAmazonCsv', csvText: text });
  importStatus.textContent = `Imported: ${result.imported}`;
  await refreshSummary();
});

(document.getElementById('export-btn') as HTMLButtonElement).addEventListener('click', async () => {
  const result = await sendMessage<{ ok: boolean; files: Record<string, string> }>({ type: 'exportState' });
  for (const [filename, content] of Object.entries(result.files || {})) {
    downloadText(filename, content);
  }
  await refreshSummary();
});

(document.getElementById('clear-btn') as HTMLButtonElement).addEventListener('click', async () => {
  await sendMessage<{ ok: boolean }>({ type: 'clearDb' });
  await refreshSummary();
});

void refreshSummary();

async function refreshSummary(): Promise<void> {
  const result = await sendMessage<{ ok: boolean; summary: Record<string, unknown> }>({ type: 'storageSummary' });
  summaryEl.textContent = JSON.stringify(result.summary, null, 2);
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export {};
