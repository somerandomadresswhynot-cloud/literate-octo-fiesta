import type { AsinLink, DebugEntry, EventRecord, MetaRecord, WbProduct } from '../lib/types.js';

type DiagnosticInput = {
  generated_at: string;
  extension_version: string;
  active_asin: string;
  storage_summary: Record<string, unknown>;
  meta: MetaRecord;
  debug_logs: DebugEntry[];
  events: EventRecord[];
  wb_products: WbProduct[];
  asin_links: AsinLink[];
  validation_warnings: string[];
  validation_errors: string[];
  duplicate_active_link_count: number;
  debug_log_count: number;
  verbose_logging_enabled: boolean;
};

export function createDiagnosticSnapshot(input: DiagnosticInput): Record<string, unknown> {
  return {
    generated_at: input.generated_at,
    extension_version: input.extension_version,
    active_asin: input.active_asin,
    storage_summary: input.storage_summary,
    meta: input.meta,
    recent_debug_logs: input.debug_logs.slice(-200),
    recent_events: input.events.slice(-100),
    sample_wb_products: sampleFirstLast(input.wb_products, 50),
    sample_asin_links: sampleFirstLast(input.asin_links, 100),
    validation_warnings: input.validation_warnings,
    validation_errors: input.validation_errors,
    duplicate_active_link_count: input.duplicate_active_link_count,
    debug_log_count: input.debug_log_count,
    verbose_logging_enabled: input.verbose_logging_enabled
  };
}

export function createAllInOneBackup(input: {
  generated_at: string;
  extension_version: string;
  amazon_products: Record<string, string>[];
  wb_products: WbProduct[];
  asin_links: AsinLink[];
  groups: Record<string, string>[];
  group_members: Record<string, string>[];
  events: EventRecord[];
  meta: MetaRecord;
  debug_logs: DebugEntry[];
  validation_warnings: string[];
  validation_errors: string[];
  duplicate_active_link_count: number;
  debug_log_count: number;
  verbose_logging_enabled: boolean;
}): Record<string, unknown> {
  return {
    generated_at: input.generated_at,
    extension_version: input.extension_version,
    amazon_products: input.amazon_products,
    wb_products: input.wb_products,
    asin_links: input.asin_links,
    groups: input.groups,
    group_members: input.group_members,
    events: input.events,
    meta: input.meta,
    debug_logs: input.debug_logs,
    validation_warnings: input.validation_warnings,
    validation_errors: input.validation_errors,
    duplicate_active_link_count: input.duplicate_active_link_count,
    debug_log_count: input.debug_log_count,
    verbose_logging_enabled: input.verbose_logging_enabled
  };
}

function sampleFirstLast<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows;
  const half = Math.floor(cap / 2);
  return [...rows.slice(0, half), ...rows.slice(rows.length - half)];
}
