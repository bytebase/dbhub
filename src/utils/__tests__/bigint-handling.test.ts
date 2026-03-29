import { describe, it, expect } from 'vitest';
import { bigIntReplacer, createToolSuccessResponse } from '../response-formatter.js';

describe('BigInt handling', () => {
  describe('bigIntReplacer', () => {
    it('should convert safe BigInt values to Number', () => {
      expect(bigIntReplacer('id', BigInt(42))).toBe(42);
      expect(bigIntReplacer('id', BigInt(0))).toBe(0);
      expect(bigIntReplacer('id', BigInt(-100))).toBe(-100);
      expect(bigIntReplacer('id', BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
      expect(bigIntReplacer('id', BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    });

    it('should convert unsafe BigInt values to string', () => {
      const largeValue = BigInt('2033735037361704962');
      expect(bigIntReplacer('id', largeValue)).toBe('2033735037361704962');

      const beyondMax = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
      expect(bigIntReplacer('id', beyondMax)).toBe(beyondMax.toString());

      const belowMin = BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1);
      expect(bigIntReplacer('id', belowMin)).toBe(belowMin.toString());
    });

    it('should pass through non-BigInt values unchanged', () => {
      expect(bigIntReplacer('key', 42)).toBe(42);
      expect(bigIntReplacer('key', 'hello')).toBe('hello');
      expect(bigIntReplacer('key', null)).toBe(null);
      expect(bigIntReplacer('key', true)).toBe(true);
    });
  });

  describe('JSON serialization with BigInt', () => {
    it('should serialize query results with mixed BigInt values correctly', () => {
      const rows = [
        { id: BigInt('2033735037361704962'), name: 'test', count: BigInt(42) },
      ];
      const response = createToolSuccessResponse({ rows, count: 1 });
      const parsed = JSON.parse(response.content[0].text);

      // Large BigInt should become string
      expect(parsed.data.rows[0].id).toBe('2033735037361704962');
      // Safe BigInt should become number
      expect(parsed.data.rows[0].count).toBe(42);
      // Regular values unchanged
      expect(parsed.data.rows[0].name).toBe('test');
    });
  });
});
