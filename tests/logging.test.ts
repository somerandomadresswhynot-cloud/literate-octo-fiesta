import { describe, expect, test } from 'vitest';
import { shouldPersistDebug } from '../src/lib/logging.js';

describe('debug logging mode filter', () => {
  test('quiet mode suppresses verbose scan logs', () => {
    expect(shouldPersistDebug('scan_samples', false)).toBe(false);
    expect(shouldPersistDebug('sku_extracted', false)).toBe(false);
    expect(shouldPersistDebug('link_created', false)).toBe(true);
  });

  test('verbose mode allows scan logs', () => {
    expect(shouldPersistDebug('scan_samples', true)).toBe(true);
    expect(shouldPersistDebug('sku_extracted', true)).toBe(true);
  });
});
