import { describe, expect, it } from 'vitest';
import { parseResultMetadata } from '../client/result.js';

function headers(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = {
    'X-Original-Size': '3', 'X-Archive-Size': '48', 'X-Codec': 'STORE', 'X-Checksum-Verified': 'sha256', ...overrides,
  };
  return (name: string) => values[name] ?? null;
}

describe('client result validation', () => {
  it('accepts consistent compression and decompression responses', () => {
    expect(parseResultMetadata(headers(), 'compress', 3, 48)).toEqual({ originalSize: 3, archiveSize: 48, codec: 'STORE' });
    expect(parseResultMetadata(headers(), 'decompress', 48, 3).codec).toBe('STORE');
  });
  it('accepts an empty original with a nonempty archive', () => {
    const getHeader = headers({ 'X-Original-Size': '0' });
    expect(parseResultMetadata(getHeader, 'compress', 0, 48).originalSize).toBe(0);
    expect(parseResultMetadata(getHeader, 'decompress', 48, 0).originalSize).toBe(0);
  });
  it.each([null, '', '-1', '1.5', 'NaN', 'Infinity', ' 3 ', '9007199254740992', '104857601'])(
    'rejects missing or invalid original size %s', value => {
      expect(() => parseResultMetadata(headers({ 'X-Original-Size': value }), 'compress', 3, 48)).toThrow(/метаданные/);
    },
  );
  it.each([null, '', '0', '43', '106954753'])(
    'rejects missing or impossible archive size %s', value => {
      expect(() => parseResultMetadata(headers({ 'X-Archive-Size': value }), 'compress', 3, 48)).toThrow(/метаданные/);
    },
  );
  it('rejects unknown codecs and inconsistent upload/response lengths', () => {
    expect(() => parseResultMetadata(headers({ 'X-Codec': 'ZIP' }), 'compress', 3, 48)).toThrow(/метаданные/);
    expect(() => parseResultMetadata(headers(), 'compress', 2, 48)).toThrow(/метаданные/);
    expect(() => parseResultMetadata(headers(), 'compress', 3, 47)).toThrow(/метаданные/);
    expect(() => parseResultMetadata(headers(), 'decompress', 47, 3)).toThrow(/метаданные/);
    expect(() => parseResultMetadata(headers(), 'decompress', 48, 2)).toThrow(/метаданные/);
  });
  it('requires successful integrity verification for decompression', () => {
    expect(() => parseResultMetadata(headers({ 'X-Checksum-Verified': null }), 'decompress', 48, 3)).toThrow(/SHA-256/);
  });
});
