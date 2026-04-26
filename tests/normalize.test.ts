import { describe, expect, test } from 'vitest';
import { isActiveLink, isDeleted, parseBooleanLike } from '../src/lib/normalize.js';

describe('boolean normalization helpers', () => {
  test('"true" and true are parsed as true', () => {
    expect(parseBooleanLike('true')).toBe(true);
    expect(parseBooleanLike(true)).toBe(true);
  });

  test('"false", false, empty string are parsed as false', () => {
    expect(parseBooleanLike('false')).toBe(false);
    expect(parseBooleanLike(false)).toBe(false);
    expect(parseBooleanLike('')).toBe(false);
  });

  test('deleted_at marks row as deleted and inactive', () => {
    expect(isDeleted({ deleted_at: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(isActiveLink({ is_active: 'true', deleted_at: '2026-01-01T00:00:00.000Z' } as any)).toBe(false);
    expect(isActiveLink({ is_active: true, deleted_at: '' } as any)).toBe(true);
  });
});
