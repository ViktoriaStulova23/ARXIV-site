import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compress, decompress } from '../core/archive.js';
import { encodeHeader, HEADER_SIZE, parseArchive, safeFilename } from '../core/format.js';
import { encodeRle } from '../core/rle.js';
import { encodeLz } from '../core/lz.js';
import { MAX_ORIGINAL_SIZE, type Method } from '../core/types.js';

const samples = {
  empty: Buffer.alloc(0), one: Buffer.from([255]), all: Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  runs: Buffer.alloc(10000, 0), alternating: Buffer.from('ab'.repeat(1500)), random: randomBytes(32768),
  text: Buffer.from('Архиватор без потерь!\n'.repeat(200)), csv: Buffer.from('id,name\n1,Иван\n2,Анна\n'.repeat(100)),
  json: Buffer.from(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, active: true })))),
  png: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(8192)]),
  jpeg: Buffer.concat([Buffer.from([255, 216, 255, 224]), randomBytes(8192), Buffer.from([255, 217])]),
};

describe.each<Method>(['auto', 'rle', 'deflate', 'lz'])('SARC %s', method => {
  for (const [name, bytes] of Object.entries(samples)) {
    it(`restores ${name} byte for byte and verifies SHA-256`, () => {
      const archive = compress(bytes, `${name}.bin`, method);
      const result = decompress(archive.bytes);
      expect(result.bytes.equals(bytes)).toBe(true);
      expect(result.verified).toBe(true);
      expect(archive.bytes.subarray(12, 44)).toEqual(createHash('sha256').update(bytes).digest());
    });
  }
});

describe('format and adaptive choice', () => {
  it('selects the actual smallest representation including header and prefers STORE on ties', () => {
    for (const bytes of Object.values(samples)) {
      const result = compress(bytes, 'данные.bin');
      const candidates = [bytes.length, encodeRle(bytes).length, encodeLz(bytes).length, deflateRawSync(bytes, { level: 6 }).length];
      expect(result.bytes.length).toBe(HEADER_SIZE + Buffer.byteLength('данные.bin') + Math.min(...candidates));
      expect(result.codec).toBe(['STORE', 'RLE', 'LZ', 'DEFLATE'][candidates.indexOf(Math.min(...candidates))]);
    }
    expect(compress(Buffer.alloc(0), 'x').codec).toBe('STORE');
    expect(compress(Buffer.alloc(3, 7), 'x').codec).toBe('RLE');
    expect(compress(Buffer.from([1]), 'x').codec).toBe('STORE');
  });
  it.each(['Отчёт 2026 📦.txt', '../evil', '..\\evil', 'CON', 'nul.txt', 'a\u0000b\u202ec', '.', 'имя'.repeat(200), 'a'.repeat(500)])('handles filename %s', name => {
    const result = decompress(compress(Buffer.from('x'), name).bytes);
    expect(result.filename).toBe(safeFilename(name));
    expect(Buffer.byteLength(result.filename)).toBeLessThanOrEqual(255);
    expect(result.filename).not.toMatch(/[\\/\p{Cc}\p{Cf}]/u);
  });
  it('normalizes untrusted archive filenames during decoding too', () => {
    const original = Buffer.from('x');
    const header = encodeHeader(original, '1234567', 'STORE');
    header.write('../evil', 44);
    expect(decompress(Buffer.concat([header, original])).filename).toBe('evil');
  });
  it('refuses unknown methods', () => {
    expect(() => compress(Buffer.alloc(0), 'x', 'store' as Method)).toThrow();
  });
  it('rejects header corruption, bad UTF-8, hashes and sizes', () => {
    const archive = compress(Buffer.from('some data'), 'x', 'rle').bytes;
    for (const [offset, value] of [[0, 0], [4, 99], [5, 4], [10, 255], [11, 1], [12, 99], [44, 255], [6, 99]] as const) {
      const broken = Buffer.from(archive);
      broken[offset] = value;
      expect(() => decompress(broken)).toThrow();
    }
    for (let length = 0; length < archive.length; length++) expect(() => decompress(archive.subarray(0, length))).toThrow();
    const tooLarge = Buffer.from(archive);
    tooLarge.writeUInt32LE(MAX_ORIGINAL_SIZE + 1, 6);
    expect(() => decompress(tooLarge)).toThrow(/100 MiB/);
  });
  it.each<Method>(['auto', 'rle', 'deflate'])('rejects payload corruption and trailing data for %s', method => {
    const archive = compress(Buffer.from('abcdefg'), 'x', method).bytes;
    const broken = Buffer.from(archive);
    // Mutate an actual data bit, not unused DEFLATE padding in the last byte.
    broken[HEADER_SIZE + 2]! ^= 8;
    expect(() => decompress(broken)).toThrow();
    expect(() => decompress(Buffer.concat([archive, Buffer.from([0])]))).toThrow();
  });
  it('bounds a DEFLATE bomb by the declared output size', () => {
    const bomb = Buffer.concat([encodeHeader(Buffer.from('x'), 'x', 'DEFLATE'), deflateRawSync(Buffer.alloc(1024 * 1024))]);
    expect(() => decompress(bomb)).toThrow(/DEFLATE/);
  });
  it('reads the documented little-endian header fields', () => {
    const archive = compress(Buffer.from('hello'), 'a', 'rle').bytes;
    expect(archive.toString('ascii', 0, 4)).toBe('SARC');
    expect(archive[4]).toBe(2);
    expect(archive[5]).toBe(1);
    expect(archive.readUInt32LE(6)).toBe(5);
    expect(archive.readUInt16LE(10)).toBe(1);
    expect(parseArchive(archive).payload).toEqual(encodeRle(Buffer.from('hello')));
  });
  it('reads legacy SARC v1 archives', () => {
    for (const method of ['auto', 'rle', 'deflate'] as const) {
      const original = Buffer.from('legacy file');
      const archive = compress(original, 'old.txt', method).bytes;
      archive[4] = 1;
      expect(decompress(archive).bytes.equals(original)).toBe(true);
    }
  });
});
