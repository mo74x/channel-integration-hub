import { safeCompare } from './safe-compare.js';

describe('safeCompare', () => {
  it('returns true when strings are identical', () => {
    expect(safeCompare('secret_key_123', 'secret_key_123')).toBe(true);
    expect(safeCompare('a', 'a')).toBe(true);
  });

  it('returns false when strings differ', () => {
    expect(safeCompare('secret_key_123', 'secret_key_456')).toBe(false);
    expect(safeCompare('secret_key_123', 'secret_key_12')).toBe(false);
    expect(safeCompare('short', 'much_longer_string_here')).toBe(false);
  });

  it('returns false when either value is null, undefined, or empty', () => {
    expect(safeCompare('', '')).toBe(false);
    expect(safeCompare('key', '')).toBe(false);
    expect(safeCompare('', 'key')).toBe(false);
    expect(safeCompare(null as any, 'key')).toBe(false);
    expect(safeCompare('key', undefined as any)).toBe(false);
  });
});
