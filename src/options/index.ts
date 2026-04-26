import { sendMessage } from '../lib/runtime.js';

const importInput = document.getElementById('import-files') as HTMLInputElement;
const importStatus = document.getElementById('import-status') as HTMLPreElement;
const exportStatus = document.getElementById('export-status') as HTMLDivElement;
const summaryEl = document.getElementById('summary') as HTMLPreElement;

(document.getElementById('import-btn') as HTMLButtonElement).addEventListener('click', async () => {
  await runImport('import');
});

(document.getElementById('restore-btn') as HTMLButtonElement).addEventListener('click', async () => {
  await runImport('restore');
});

(document.getElementById('export-btn') as HTMLButtonElement).addEventListener('click', async () => {
  await exportAll();
});

(document.getElementById('backup-btn') as HTMLButtonElement).addEventListener('click', async () => {
  await exportAll();
});

(document.getElementById('clear-btn') as HTMLButtonElement).addEventListener('click', async () => {
  const shouldProceed = confirm('This will clear local IndexedDB. Export backup first. Continue?');
  if (!shouldProceed) return;
  await sendMessage<{ ok: boolean }>({ type: 'clearDb' });
  await refreshSummary();
  importStatus.textContent = 'Local database cleared.';
});

void refreshSummary();

async function runImport(mode: 'import' | 'restore'): Promise<void> {
  const files = await readSelectedFiles();
  if (Object.keys(files).length === 0) {
    importStatus.textContent = 'Select at least one supported file first.';
    return;
  }

  const result = await sendMessage<{ ok: boolean; summary: Record<string, unknown> }>({
    type: 'importStateFiles',
    files,
    mode
  });
  importStatus.textContent = JSON.stringify(result.summary, null, 2);
  await refreshSummary();
}

async function exportAll(): Promise<void> {
  const result = await sendMessage<{ ok: boolean; files: Record<string, string>; backupName: string }>({ type: 'exportState' });
  for (const [filename, content] of Object.entries(result.files || {})) {
    downloadText(`${result.backupName}-${filename}`, content);
  }
  exportStatus.textContent = `Exported ${Object.keys(result.files || {}).length} files (${result.backupName})`;
  await refreshSummary();
}

async function readSelectedFiles(): Promise<Record<string, string>> {
  const selected = Array.from(importInput.files ?? []);
  const supported = new Set(['amazon_products.csv', 'wb_products.csv', 'asin_links.csv', 'groups.csv', 'group_members.csv', 'events.csv', 'meta.json']);
  const entries = await Promise.all(selected
    .filter((file) => supported.has(file.name))
    .map(async (file) => [file.name, await file.text()] as const));
  return Object.fromEntries(entries);
}

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
