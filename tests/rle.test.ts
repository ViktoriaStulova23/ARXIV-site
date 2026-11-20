import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeRle, decodeRle } from '../core/rle.js';

describe('own RLE packet codec', () => {
  const samples = [Buffer.alloc(0), Buffer.from([0]), Buffer.from([255]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.alloc(5000, 0), Buffer.alloc(131, 255), Buffer.from('ab'.repeat(2000)), randomBytes(16384)];
  for (const [index, data] of samples.entries()) {
    it(`round-trips bytes of sample ${index}`, () => {
      const encoded = encodeRle(data);
      expect(decodeRle(encoded, data.length).equals(data)).toBe(true);
      expect(encoded.length).toBeLessThanOrEqual(data.length + Math.ceil(data.length / 128));
    });
  }
  it('encodes a run and a literal using the documented wire format', () => {
    expect(encodeRle(Buffer.from([7, 7, 7, 1, 2]))).toEqual(Buffer.from([128, 7, 1, 1, 2]));
    expect(encodeRle(Buffer.alloc(130, 3))).toEqual(Buffer.from([255, 3]));
  });
  it('round-trips boundaries and mixed literal/run blocks', () => {
    for (const n of [2, 3, 127, 128, 129, 130, 131, 132, 259, 260, 261]) {
      const data = Buffer.concat([randomBytes(n), Buffer.alloc(n, 5), randomBytes(n)]);
      expect(decodeRle(encodeRle(data), data.length).equals(data)).toBe(true);
    }
  });
  it('rejects truncated packets, overrun, underrun and unbounded results', () => {
    for (const [bytes, size] of [[Buffer.from([2, 1]), 3], [Buffer.from([128]), 3], [Buffer.from([255, 1]), 1], [Buffer.alloc(0), 1]] as const) {
      expect(() => decodeRle(bytes, size)).toThrow();
    }
    expect(() => decodeRle(Buffer.alloc(0), 104857601)).toThrow(/100 MiB/);
  });
});
