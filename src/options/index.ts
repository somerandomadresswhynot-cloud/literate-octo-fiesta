import { sendMessage } from '../lib/runtime.js';
import { createAllInOneBackup, createDiagnosticSnapshot } from './payloads.js';
import type { AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from '../lib/types.js';

const LOG_PREFIX = '[WB-ASIN Options]';

const importInput = document.getElementById('import-files') as HTMLInputElement;
const importStatus = document.getElementById('import-status') as HTMLPreElement;
const exportStatus = document.getElementById('export-status') as HTMLPreElement;
const summaryEl = document.getElementById('summary') as HTMLPreElement;

const lastActionEl = document.getElementById('status-last-action') as HTMLDivElement;
const lastSuccessEl = document.getElementById('status-last-success') as HTMLDivElement;
const lastErrorEl = document.getElementById('status-last-error') as HTMLDivElement;
const lastFileEl = document.getElementById('status-last-file') as HTMLDivElement;
const verboseLoggingEl = document.getElementById('verbose-logging') as HTMLInputElement;

(document.getElementById('import-btn') as HTMLButtonElement).addEventListener('click', async () => runImport('import'));
(document.getElementById('restore-btn') as HTMLButtonElement).addEventListener('click', async () => runImport('restore'));
(document.getElementById('restore-json-btn') as HTMLButtonElement).addEventListener('click', async () => runAllInOneRestore());
(document.getElementById('csv-export-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('csv_state', exportCsvStateFiles));
(document.getElementById('debug-export-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('debug_log', exportDebugLog));
(document.getElementById('snapshot-export-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('diagnostic_snapshot', exportDiagnosticSnapshot));
(document.getElementById('json-backup-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('all_in_one_backup', exportAllInOneBackup));
(document.getElementById('validate-state-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('validate_local_state', validateStateNow));
(document.getElementById('repair-links-btn') as HTMLButtonElement).addEventListener('click', async () => runExportAction('repair_duplicate_links', repairDuplicateLinksNow));

(document.getElementById('clear-btn') as HTMLButtonElement).addEventListener('click', async () => {
  const shouldProceed = confirm('This will clear local IndexedDB. Export backup first. Continue?');
  if (!shouldProceed) return;
  await sendMessage<{ ok: boolean }>({ type: 'clearDb' });
  await refreshSummary();
  importStatus.textContent = 'Local database cleared.';
});

void (async () => {
  await refreshSummary();
  const verbose = await sendMessage<{ ok: boolean; enabled: boolean }>({ type: 'getVerboseLogging' });
  verboseLoggingEl.checked = verbose.enabled;
})();

verboseLoggingEl.addEventListener('change', () => {
  void sendMessage({ type: 'setVerboseLogging', enabled: verboseLoggingEl.checked });
});

async function runImport(mode: 'import' | 'restore'): Promise<void> {
  const files = await readSelectedFiles();
  if (Object.keys(files).length === 0) {
    importStatus.textContent = 'Select at least one supported file first.';
    return;
  }

  const result = await sendMessage<{ ok: boolean; summary: Record<string, unknown> }>({ type: 'importStateFiles', files, mode });
  importStatus.textContent = JSON.stringify(result.summary, null, 2);
  await refreshSummary();
}

async function runAllInOneRestore(): Promise<void> {
  const selected = Array.from(importInput.files ?? []).find((file) => file.name.endsWith('.json'));
  if (!selected) {
    importStatus.textContent = 'Select an all-in-one JSON backup file first.';
    return;
  }
  const payload = JSON.parse(await selected.text());
  const validation = await sendMessage<{ ok: boolean; fatalErrors: string[]; warnings: string[]; summary: Record<string, unknown> }>({ type: 'validateAllInOneBackup', payload });
  importStatus.textContent = `Dry run summary:\n${JSON.stringify(validation.summary, null, 2)}`;
  if (validation.fatalErrors.length > 0) return;
  const confirmed = confirm('Restore will replace local IndexedDB state. Continue?');
  if (!confirmed) return;
  const restored = await sendMessage<{ ok: boolean; restored: boolean; summary: Record<string, unknown> }>({ type: 'restoreAllInOneBackup', payload });
  importStatus.textContent = `Restore completed:\n${JSON.stringify(restored.summary, null, 2)}`;
  updateStatusPanel({ action: 'restore_all_in_one_json', filename: selected.name });
  await refreshSummary();
}

async function exportCsvStateFiles(): Promise<void> {
  setExportStatus('started: generating CSV state file downloads');
  const result = await sendMessage<{ ok: boolean; files: Record<string, string>; backupName: string }>({ type: 'exportState' });
  const entries = Object.entries(result.files || {});
  const filenames = entries.map(([name]) => `${result.backupName}-${name}`);
  if (entries.length > 1) {
    setExportStatus('started: multiple downloads; Brave may ask to allow multiple downloads.');
  }
  for (const [filename, content] of entries) {
    triggerDownload(`${result.backupName}-${filename}`, content, 'text/plain');
  }
  setExportStatus(`success: downloaded ${entries.length} files\nfilenames: ${filenames.join(', ')}`);
}

async function exportDebugLog(): Promise<void> {
  const data = await sendMessage<{ ok: boolean; data: ExportDataPayload }>({ type: 'getExportData' });
  const filename = `wb-asin-debug-log-${timestampSafe()}.json`;
  triggerDownload(filename, JSON.stringify(data.data.debug_log, null, 2), 'application/json');
  setExportStatus(`success: downloaded ${filename}`);
}

async function exportDiagnosticSnapshot(): Promise<void> {
  const data = await sendMessage<{ ok: boolean; data: ExportDataPayload }>({ type: 'getExportData' });
  const summary = await sendMessage<{ ok: boolean; summary: Record<string, unknown> }>({ type: 'storageSummary' });
  const validation = await sendMessage<{ ok: boolean; validation_warnings: string[]; validation_errors: string[]; duplicate_active_link_count: number }>({ type: 'validateLocalState' });
  const payload = createDiagnosticSnapshot({
    generated_at: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version,
    active_asin: data.data.meta.active_asin,
    storage_summary: summary.summary,
    meta: data.data.meta,
    debug_logs: data.data.debug_log,
    events: data.data.events,
    wb_products: data.data.wb_products,
    asin_links: data.data.asin_links,
    validation_warnings: validation.validation_warnings,
    validation_errors: validation.validation_errors,
    duplicate_active_link_count: validation.duplicate_active_link_count,
    debug_log_count: data.data.debug_log_count,
    verbose_logging_enabled: data.data.verbose_logging_enabled
  });
  const filename = `wb-asin-diagnostic-snapshot-${timestampSafe()}.json`;
  triggerDownload(filename, JSON.stringify(payload, null, 2), 'application/json');
  setExportStatus(`success: downloaded ${filename}`);
}

async function exportAllInOneBackup(): Promise<void> {
  const data = await sendMessage<{ ok: boolean; data: ExportDataPayload }>({ type: 'getExportData' });
  const payload = createAllInOneBackup({
    generated_at: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version,
    amazon_products: data.data.amazon_products,
    wb_products: data.data.wb_products,
    asin_links: data.data.asin_links,
    groups: data.data.groups,
    group_members: data.data.group_members,
    events: data.data.events,
    meta: data.data.meta,
    debug_logs: data.data.debug_log,
    validation_warnings: data.data.validation_warnings,
    validation_errors: data.data.validation_errors,
    duplicate_active_link_count: data.data.duplicate_active_link_count,
    debug_log_count: data.data.debug_log_count,
    verbose_logging_enabled: data.data.verbose_logging_enabled
  });
  const filename = `wb-asin-all-in-one-backup-${timestampSafe()}.json`;
  triggerDownload(filename, JSON.stringify(payload, null, 2), 'application/json');
  setExportStatus(`success: downloaded ${filename}`);
}


async function validateStateNow(): Promise<void> {
  const result = await sendMessage<{ ok: boolean; validation_warnings: string[]; validation_errors: string[]; duplicate_active_link_count: number }>({ type: 'validateLocalState' });
  setExportStatus(`success: validation completed\nwarnings=${result.validation_warnings.length}, errors=${result.validation_errors.length}, duplicate_active_link_count=${result.duplicate_active_link_count}`);
}

async function repairDuplicateLinksNow(): Promise<void> {
  const result = await sendMessage<{ ok: boolean; repaired_count: number; touched_links: string[] }>({ type: 'repairDuplicateActiveLinks' });
  setExportStatus(`success: repaired duplicates=${result.repaired_count}\nlinks=${result.touched_links.join(', ')}`);
}

async function runExportAction(action: string, operation: () => Promise<void>): Promise<void> {
  updateStatusPanel({ action, error: '' });
  console.log(`${LOG_PREFIX} export button clicked`, { action });
  try {
    await operation();
    const successTs = new Date().toISOString();
    updateStatusPanel({ action, success: successTs, error: '' });
  } catch (error) {
    const err = error instanceof Error ? error.stack || error.message : String(error);
    setExportStatus(`failed: ${err}`);
    updateStatusPanel({ action, error: err });
    console.error(`${LOG_PREFIX} error details`, { action, error: err });
    await sendMessage({ type: 'logDebug', level: 'error', action: 'export_error', details: { source: 'options', export_action: action, error: err } });
  }
}

function triggerDownload(filename: string, content: string, contentType: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  console.log(`${LOG_PREFIX} generated filename`, filename);
  console.log(`${LOG_PREFIX} blob size`, blob.size);
  a.click();
  console.log(`${LOG_PREFIX} download triggered`, filename);
  updateStatusPanel({ filename });
  URL.revokeObjectURL(url);
}

async function readSelectedFiles(): Promise<Record<string, string>> {
  const selected = Array.from(importInput.files ?? []);
  const supported = new Set(['amazon_products.csv', 'wb_products.csv', 'asin_links.csv', 'groups.csv', 'group_members.csv', 'events.csv', 'meta.json', 'debug_log.json']);
  const entries = await Promise.all(selected.filter((file) => supported.has(file.name)).map(async (file) => [file.name, await file.text()] as const));
  return Object.fromEntries(entries);
}

async function refreshSummary(): Promise<void> {
  const result = await sendMessage<{ ok: boolean; summary: Record<string, unknown> }>({ type: 'storageSummary' });
  summaryEl.textContent = JSON.stringify(result.summary, null, 2);
}

function setExportStatus(value: string): void {
  exportStatus.textContent = value;
}

function updateStatusPanel(update: { action?: string; success?: string; error?: string; filename?: string }): void {
  if (update.action) lastActionEl.textContent = update.action;
  if (update.success) lastSuccessEl.textContent = update.success;
  if (update.error !== undefined) lastErrorEl.textContent = update.error || '-';
  if (update.filename) lastFileEl.textContent = update.filename;
}

function timestampSafe(date = new Date()): string {
  return date.toISOString().replace(/:/g, '-');
}

type ExportDataPayload = {
  amazon_products: Record<string, string>[];
  wb_products: WbProduct[];
  asin_links: AsinLink[];
  groups: Record<string, string>[];
  group_members: Record<string, string>[];
  events: EventRecord[];
  meta: MetaRecord;
  debug_log: DebugEntry[];
  validation_warnings: string[];
  validation_errors: string[];
  duplicate_active_link_count: number;
  verbose_logging_enabled: boolean;
  debug_log_count: number;
};

export {};
