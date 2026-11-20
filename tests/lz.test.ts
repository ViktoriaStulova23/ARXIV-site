import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeLz, encodeLz, LZ_BLOCK_SIZE } from '../core/lz.js';
import { encodeRle } from '../core/rle.js';
import { compress } from '../core/archive.js';

describe('LZ77 + Huffman', () => {
  it('restores cross-block references, long matches and a raw tail', () => {
    const seed = randomBytes(65536);
    const original = Buffer.concat([...Array.from({ length: 33 }, () => seed), randomBytes(4096)]);
    const encoded = encodeLz(original);
    expect(decodeLz(encoded, original.length).equals(original)).toBe(true);
    expect(encoded.length).toBeLessThan(original.length / 10);
  });
  it('improves on RLE for text and uses a raw block for random data', () => {
    const text = Buffer.from('Повторяющиеся слова и фрагменты текста.\n'.repeat(1000));
    expect(encodeLz(text).length).toBeLessThan(encodeRle(text).length / 10);
    const random = randomBytes(8192);
    const encoded = encodeLz(random);
    expect(encoded[8]).toBe(0);
    expect(decodeLz(encoded, random.length).equals(random)).toBe(true);
    expect(decodeLz(encodeLz(Buffer.alloc(0)), 0).length).toBe(0);
  });
  it('rejects truncated and contradictory block framing', () => {
    const original = Buffer.alloc(2000, 7);
    const encoded = encodeLz(original);
    for (let size = 0; size < encoded.length; size++) expect(() => decodeLz(encoded.subarray(0, size), original.length)).toThrow();
    for (const [offset, value] of [[0, 0], [8, 2]] as const) {
      const broken = Buffer.from(encoded); broken[offset] = value;
      expect(() => decodeLz(broken, original.length)).toThrow();
    }
    const oversized = Buffer.from(encoded); oversized.writeUInt32LE(LZ_BLOCK_SIZE + 1, 0);
    expect(() => decodeLz(oversized, original.length)).toThrow();
  });
  it('rejects oversubscribed Huffman codes and references before the output', () => {
    for (const lengths of [Buffer.alloc(292, 1), Buffer.alloc(292)]) {
      if (!lengths[0]) { lengths[256] = 1; lengths[272] = 1; }
      const tree = encodeRle(lengths);
      const header = Buffer.alloc(11);
      header.writeUInt32LE(3, 0); header.writeUInt32LE(3 + tree.length, 4); header[8] = 1;
      header.writeUInt16LE(tree.length, 9);
      expect(() => decodeLz(Buffer.concat([header, tree, Buffer.from([0])]), 3)).toThrow();
    }
  });
  it('uses the new format version and retains the LZ method when explicitly requested', () => {
    const archive = compress(Buffer.from('small'), 'x', 'lz');
    expect(archive.codec).toBe('LZ');
    expect(archive.bytes[4]).toBe(2);
  });
});
