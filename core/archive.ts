import { timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { decodeRle, rleEncodedSize, writeRle } from './rle.js';
import { decodeLz, encodeLzChunks } from './lz.js';
import { encodeHeader, parseArchive, safeFilename, sha256 } from './format.js';
import { ArchiveError, checkOriginalSize, type Codec, type Method } from './types.js';

/** Independent of HTTP. AUTO compares actual payloads; headers have equal length. */
export function compress(bytes: Buffer, filename: string, method: Method = 'auto') {
  checkOriginalSize(bytes.length);
  if (!['auto', 'rle', 'deflate', 'lz'].includes(method)) {
    throw new ArchiveError('INVALID_METHOD', 'Метод должен быть auto, lz, rle или deflate.');
  }
  let payloadSize = bytes.length;
  let chunks: Buffer[] = [bytes];
  let codec: Codec = 'STORE';
  if (method === 'rle' || method === 'auto') {
    const size = rleEncodedSize(bytes);
    if (method === 'rle' || size < payloadSize) {
      payloadSize = size;
      chunks = [];
      codec = 'RLE';
    }
  }
  if (method === 'lz' || method === 'auto') {
    const candidate = encodeLzChunks(bytes, method === 'auto' ? payloadSize : Infinity);
    if (candidate && (method === 'lz' || candidate.length < payloadSize)) {
      payloadSize = candidate.length;
      chunks = candidate.chunks;
      codec = 'LZ';
    }
  }
  if (method === 'deflate' || method === 'auto') {
    if (method === 'deflate' || payloadSize > 0) {
      try {
        const candidate = deflateRawSync(bytes, { level: 6, windowBits: 15, memLevel: 8,
          ...(method === 'auto' ? { maxOutputLength: payloadSize } : {}) });
        if (method === 'deflate' || candidate.length < payloadSize) {
          payloadSize = candidate.length;
          chunks = [candidate];
          codec = 'DEFLATE';
        }
      } catch (error) {
        if (method !== 'auto' || (error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw error;
      }
    }
  }
  const name = safeFilename(filename);
  const header = encodeHeader(bytes, name, codec);
  const archive = Buffer.allocUnsafeSlow(header.length + payloadSize);
  archive.set(header);
  if (codec === 'RLE') writeRle(bytes, archive.subarray(header.length));
  else {
    let offset = header.length;
    for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length; }
  }
  return { bytes: archive, filename: name, codec, originalSize: bytes.length };
}

export function decompress(archiveBytes: Buffer) {
  const { codec, originalSize, filename, hash, payload } = parseArchive(archiveBytes);
  let bytes: Buffer;
  if (codec === 'STORE') {
    bytes = payload;
  } else if (codec === 'RLE') {
    bytes = decodeRle(payload, originalSize);
  } else if (codec === 'LZ') {
    bytes = decodeLz(payload, originalSize);
  } else {
    try {
      // @types/node 22 omits the info:true return overload; Node returns this object.
      const result = inflateRawSync(payload, { maxOutputLength: Math.max(1, originalSize), info: true }) as unknown as {
        buffer: Buffer; engine: { bytesWritten: number };
      };
      // Node accepts trailing input by default. SARC requires exactly one payload.
      if (result.engine.bytesWritten !== payload.length) throw new Error('Trailing payload');
      bytes = result.buffer;
    } catch {
      throw new ArchiveError('INVALID_DEFLATE', 'Повреждённый DEFLATE или превышен размер из заголовка.');
    }
  }
  if (bytes.length !== originalSize) throw new ArchiveError('SIZE_MISMATCH', 'Восстановленный размер не совпадает с заголовком.');
  if (!timingSafeEqual(sha256(bytes), hash)) throw new ArchiveError('CHECKSUM_MISMATCH', 'Проверка SHA-256 не пройдена: архив повреждён.');
  return { bytes, filename, codec, originalSize, verified: true as const };
}
