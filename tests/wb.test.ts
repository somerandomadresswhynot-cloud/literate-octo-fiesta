import { describe, expect, test } from 'vitest';
import { extractWbSkuFromUrl } from '../src/lib/wb.js';

describe('extractWbSkuFromUrl', () => {
  test('extracts SKU from canonical WB URL', () => {
    expect(extractWbSkuFromUrl('https://www.wildberries.ru/catalog/12345678/detail.aspx')).toBe('12345678');
  });

  test('returns null for non-product URL', () => {
    expect(extractWbSkuFromUrl('https://www.wildberries.ru/catalog/abc')).toBeNull();
  });
});
