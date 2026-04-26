import { describe, expect, test } from 'vitest';
import { parseCsv, toCsv } from '../src/lib/csv.js';

describe('csv utils', () => {
  test('parseCsv handles basic rows', () => {
    const rows = parseCsv('asin,title\nB001,Test');
    expect(rows).toEqual([{ asin: 'B001', title: 'Test' }]);
  });

  test('toCsv escapes commas and quotes', () => {
    const out = toCsv([{ a: 'x,y', b: '"z"' }], ['a', 'b']);
    expect(out).toBe('a,b\n"x,y","""z"""');
  });
});
