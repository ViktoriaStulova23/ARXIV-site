import { createHash } from 'node:crypto';
import { ArchiveError, checkOriginalSize, CODECS, MAX_ARCHIVE_SIZE, type Codec } from './types.js';

export const HEADER_SIZE = 44;
export const VERSION = 2;

export function safeFilename(name: string, maxBytes = 255): string {
  let result = Buffer.from(name).toString('utf8').normalize('NFC').split(/[\\/]/).at(-1) ?? '';
  result = result.replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, '').trim().replace(/[. ]+$/g, '');
  if (!result || /^\.+$/.test(result)) result = 'file.bin';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) result = `_${result}`;
  let truncated = '';
  let bytes = 0;
  for (const char of result) {
    const length = Buffer.byteLength(char);
    if (bytes + length > maxBytes) break;
    truncated += char;
    bytes += length;
  }
  return truncated.replace(/[. ]+$/g, '') || 'file.bin';
}

export function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function encodeHeader(original: Uint8Array, filename: string, codec: Codec): Buffer {
  checkOriginalSize(original.length);
  const name = Buffer.from(safeFilename(filename));
  const header = Buffer.alloc(HEADER_SIZE + name.length);
  header.write('SARC', 0, 'ascii');
  header[4] = VERSION;
  header[5] = CODECS.indexOf(codec);
  header.writeUInt32LE(original.length, 6);
  header.writeUInt16LE(name.length, 10);
  header.set(sha256(original), 12);
  header.set(name, HEADER_SIZE);
  return header;
}

export function parseArchive(bytes: Buffer): {
  codec: Codec; originalSize: number; filename: string; hash: Buffer; payload: Buffer;
} {
  if (bytes.length > MAX_ARCHIVE_SIZE) throw new ArchiveError('ARCHIVE_TOO_LARGE', 'Архив превышает лимит 102 MiB.', 413);
  if (bytes.length < 4) throw new ArchiveError('TRUNCATED_HEADER', 'Заголовок архива усечён.');
  if (bytes.toString('ascii', 0, 4) !== 'SARC' || !bytes.subarray(0, 4).equals(Buffer.from('SARC'))) {
    throw new ArchiveError('INVALID_MAGIC', 'Неизвестный формат. Требуется архив SARC.', 415);
  }
  if (bytes.length < HEADER_SIZE) throw new ArchiveError('TRUNCATED_HEADER', 'Заголовок архива усечён.');
  if (bytes[4] !== VERSION && bytes[4] !== 1) throw new ArchiveError('UNSUPPORTED_VERSION', 'Версия архива не поддерживается.', 415);
  const codec = CODECS[bytes[5]!];
  if (!codec || (bytes[4] === 1 && codec === 'LZ')) throw new ArchiveError('UNSUPPORTED_CODEC', 'Алгоритм архива не поддерживается.', 415);
  const originalSize = bytes.readUInt32LE(6);
  checkOriginalSize(originalSize);
  const nameSize = bytes.readUInt16LE(10);
  if (nameSize > 255 || HEADER_SIZE + nameSize > bytes.length) {
    throw new ArchiveError('INVALID_FILENAME', 'Некорректная длина имени в заголовке.');
  }
  let filename: string;
  try {
    filename = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(HEADER_SIZE, HEADER_SIZE + nameSize));
  } catch {
    throw new ArchiveError('INVALID_UTF8', 'Имя файла содержит некорректный UTF-8.');
  }
  return {
    codec, originalSize, filename: safeFilename(filename), hash: bytes.subarray(12, 44),
    payload: bytes.subarray(HEADER_SIZE + nameSize),
  };
}
