export const MAX_ORIGINAL_SIZE = 100 * 1024 * 1024;
// 2 MiB covers worst-case literal RLE overhead (ceil(n / 128)) and header.
export const MAX_ARCHIVE_SIZE = 102 * 1024 * 1024;
export const CODECS = ['STORE', 'RLE', 'DEFLATE', 'LZ'] as const;
export type Codec = (typeof CODECS)[number];
export type Method = 'auto' | 'rle' | 'deflate' | 'lz';

export class ArchiveError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export function checkOriginalSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ORIGINAL_SIZE) {
    throw new ArchiveError('FILE_TOO_LARGE', 'Исходный файл превышает лимит 100 MiB.', 413);
  }
}
