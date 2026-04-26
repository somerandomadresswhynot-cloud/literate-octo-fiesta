import { describe, expect, test } from 'vitest';
import { parseCsv, toCsv } from '../src/lib/csv.js';

describe('csv utils', () => {
  test('parseCsv handles basic rows', () => {
    const rows = parseCsv('asin,title\nB001,Test');
    expect(rows).toEqual([{ asin: 'B001', title: 'Test' }]);
  });

  test('parseCsv handles UTF-8 BOM', () => {
    const rows = parseCsv('\ufeffasin,title\nB001,Test');
    expect(rows[0].asin).toBe('B001');
  });

  test('toCsv escapes commas, quotes, and newlines', () => {
    const out = toCsv([{ a: 'x,y', b: '"z"', c: 'line1\nline2' }], ['a', 'b', 'c']);
    expect(out).toBe('a,b,c\n"x,y","""z""","line1\nline2"');
  });
});
