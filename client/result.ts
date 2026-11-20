import { CODECS, MAX_ARCHIVE_SIZE, MAX_ORIGINAL_SIZE } from '../core/types.js';

export type Operation = 'compress' | 'decompress';

/** Validate the response contract before offering a downloaded file. */
export function parseResultMetadata(
  getHeader: (name: string) => string | null,
  operation: Operation,
  uploadedSize: number,
  responseSize: number,
) {
  const invalid = () => new Error('Сервер вернул некорректные метаданные результата.');
  function sizeHeader(name: string, maximum: number): number {
    const value = getHeader(name);
    if (value === null || !/^\d+$/.test(value)) throw invalid();
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size > maximum) throw invalid();
    return size;
  }
  const originalSize = sizeHeader('X-Original-Size', MAX_ORIGINAL_SIZE);
  const archiveSize = sizeHeader('X-Archive-Size', MAX_ARCHIVE_SIZE);
  const codec = CODECS.find(candidate => candidate === getHeader('X-Codec'));
  if (!codec || archiveSize < 44 ||
      (operation === 'compress' && (originalSize !== uploadedSize || archiveSize !== responseSize)) ||
      (operation === 'decompress' && (archiveSize !== uploadedSize || originalSize !== responseSize))) {
    throw invalid();
  }
  if (operation === 'decompress' && getHeader('X-Checksum-Verified') !== 'sha256') {
    throw new Error('Сервер не подтвердил проверку SHA-256.');
  }
  return { originalSize, archiveSize, codec };
}
