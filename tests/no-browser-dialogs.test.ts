import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

describe('content normal flow avoids browser dialogs', () => {
  test('no window.prompt/alert/confirm in content script', () => {
    const text = readFileSync('src/content/index.ts', 'utf8');
    expect(text.includes('window.prompt')).toBe(false);
    expect(text.includes('window.alert')).toBe(false);
    expect(text.includes('window.confirm')).toBe(false);
  });
});
