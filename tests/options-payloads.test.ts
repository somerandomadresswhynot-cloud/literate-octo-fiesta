import { describe, expect, test } from 'vitest';
import { createAllInOneBackup, createDiagnosticSnapshot } from '../src/options/payloads.js';

describe('options export payloads', () => {
  test('debug log payload shape remains array of entries', () => {
    const snapshot = createDiagnosticSnapshot({
      generated_at: '2026-01-01T00:00:00Z',
      extension_version: '0.1.0',
      active_asin: 'A1',
      storage_summary: { amazon: 1 },
      meta: { schema_version: '1', data_revision: '1', active_asin: 'A1', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '' },
      debug_logs: [{ ts: 't', level: 'info', action: 'x' }],
      events: [],
      wb_products: [],
      asin_links: [],
      validation_warnings: [],
      validation_errors: [],
      duplicate_active_link_count: 0,
      debug_log_count: 1,
      verbose_logging_enabled: false
    });
    expect(Array.isArray(snapshot.recent_debug_logs)).toBe(true);
  });

  test('diagnostic snapshot payload shape', () => {
    const snapshot = createDiagnosticSnapshot({
      generated_at: '2026-01-01T00:00:00Z',
      extension_version: '0.1.0',
      active_asin: 'A1',
      storage_summary: { amazon: 1 },
      meta: { schema_version: '1', data_revision: '1', active_asin: 'A1', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '' },
      debug_logs: new Array(250).fill(0).map((_, i) => ({ ts: `${i}`, level: 'info', action: 'x' })),
      events: new Array(120).fill(0).map((_, i) => ({ event_id: `${i}`, operation_id: 'o', event_type: 't', wb_sku: 'w', asin: 'a', group_id: '', payload_json: '{}', created_at: 'n', client_id: 'c' })),
      wb_products: new Array(200).fill(0).map((_, i) => ({ wb_sku: `${i}`, wb_url: 'u', seen_status: 'seen', first_seen_at: '', last_seen_at: '', last_touched_at: '', rejected: 'false', rejected_reason: '', deferred: 'false', deferred_reason: '', created_at: '', updated_at: '', deleted_at: '' })),
      asin_links: new Array(250).fill(0).map((_, i) => ({ link_id: `${i}`, wb_sku: 'w', asin: 'a', link_type: 'candidate', is_active: 'true', comment: '', created_at: '', updated_at: '', deleted_at: '', created_by_action: 'A+' })),
      validation_warnings: ['w'],
      validation_errors: ['e'],
      duplicate_active_link_count: 2,
      debug_log_count: 250,
      verbose_logging_enabled: true
    });
    expect(snapshot).toHaveProperty('generated_at');
    expect((snapshot.recent_debug_logs as unknown[]).length).toBe(200);
    expect((snapshot.recent_events as unknown[]).length).toBe(100);
    expect((snapshot.sample_wb_products as unknown[]).length).toBe(50);
    expect((snapshot.sample_asin_links as unknown[]).length).toBe(100);
  });

  test('all-in-one backup payload shape', () => {
    const backup = createAllInOneBackup({
      generated_at: '2026-01-01T00:00:00Z',
      extension_version: '0.1.0',
      amazon_products: [],
      wb_products: [],
      asin_links: [],
      groups: [],
      group_members: [],
      events: [],
      meta: { schema_version: '1', data_revision: '1', active_asin: '', default_link_type: 'candidate', overlay_position: 'top-left', last_imported_at: '', last_exported_at: '' },
      debug_logs: [],
      validation_warnings: [],
      validation_errors: [],
      duplicate_active_link_count: 0,
      debug_log_count: 0,
      verbose_logging_enabled: false
    });
    expect(backup).toHaveProperty('amazon_products');
    expect(backup).toHaveProperty('debug_logs');
  });
});
