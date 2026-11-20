import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createArchiveExecutor } from './executor.js';
import { safeFilename } from '../core/format.js';
import { ArchiveError, MAX_ARCHIVE_SIZE, MAX_ORIGINAL_SIZE, type Method } from '../core/types.js';

export function contentDisposition(filename: string): string {
  const name = safeFilename(filename);
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function readUpload(request: FastifyRequest, operation: 'compress' | 'decompress') {
  if (!request.isMultipart()) throw new ArchiveError('MULTIPART_REQUIRED', 'Отправьте файл как multipart/form-data.');
  let file: Buffer | undefined;
  let filename = 'file.bin';
  let method: Method = 'auto';
  let hasMethod = false;
  const limit = operation === 'compress' ? MAX_ORIGINAL_SIZE : MAX_ARCHIVE_SIZE;
  for await (const part of request.parts({ limits: { fileSize: limit, files: 1, fields: 1, parts: 2, fieldSize: 32 } })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file' || file !== undefined) {
        part.file.resume();
        throw new ArchiveError('INVALID_FILE_FIELD', 'Нужен ровно один файл в поле file.');
      }
      filename = part.filename;
      file = await part.toBuffer();
      if (part.file.truncated) throw new ArchiveError('FILE_TOO_LARGE', `Превышен лимит ${operation === 'compress' ? 100 : 102} MiB.`, 413);
    } else {
      if (operation !== 'compress' || part.fieldname !== 'method' || hasMethod || part.valueTruncated ||
        typeof part.value !== 'string' || !['auto', 'rle', 'deflate', 'lz'].includes(part.value)) {
        throw new ArchiveError('INVALID_FIELD', 'Допустимо только поле method: auto, lz, rle или deflate (один раз).');
      }
      method = part.value as Method;
      hasMethod = true;
    }
  }
  if (file === undefined) throw new ArchiveError('FILE_REQUIRED', 'Выберите один файл в поле file.');
  return { file, filename, method };
}

/** тело — сырые байты */
function readRaw(request: FastifyRequest, operation: 'compress' | 'decompress'): Buffer {
  const body = request.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (!Buffer.isBuffer(body)) throw new ArchiveError('OCTET_STREAM_REQUIRED', 'Отправьте байты файла как application/octet-stream.', 415);
  const limit = operation === 'compress' ? MAX_ORIGINAL_SIZE : MAX_ARCHIVE_SIZE;
  if (body.length > limit) throw new ArchiveError('FILE_TOO_LARGE', `Превышен лимит ${operation === 'compress' ? 100 : 102} MiB.`, 413);
  return body;
}

function binaryReply(reply: FastifyReply, bytes: Buffer, filename: string) {
  return reply.type('application/octet-stream')
    .header('Content-Disposition', contentDisposition(filename))
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(bytes);
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/v1/health', async () => ({ status: 'ok' }));
  app.get('/api/health', async () => ({ status: 'ok', version: '1.0.0' }));

  // One upload/operation at a time bounds in-memory usage on a local server.
  await app.register(async operations => {
    const executor = createArchiveExecutor();
    operations.addHook('preClose', () => executor.close());
    let busy = false;
    const admitted = new WeakSet<FastifyRequest>();
    const controllers = new WeakMap<FastifyRequest, AbortController>();
    const tasks = new WeakMap<FastifyRequest, Promise<unknown>>();
    async function abortRequest(request: FastifyRequest) {
      controllers.get(request)?.abort();
      await tasks.get(request)?.catch(() => undefined);
      if (admitted.delete(request)) busy = false;
    }
    operations.addHook('onRequest', async (request, reply) => {
      if (busy) throw new ArchiveError('SERVER_BUSY', 'Сервер обрабатывает другой файл. Повторите запрос после завершения.', 503);
      busy = true;
      admitted.add(request);
      controllers.set(request, new AbortController());
      // IncomingMessage 'aborted' covers incomplete uploads. A client can also
      // disconnect after uploading while CPU work is still running.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) void abortRequest(request);
      });
    });
    operations.addHook('onResponse', async request => {
      if (admitted.delete(request)) busy = false;
    });
    operations.addHook('onRequestAbort', abortRequest);
    operations.post('/api/compress', async (request, reply) => {
      const { file, filename, method } = await readUpload(request, 'compress');
      const task = executor.run('compress', file, filename, method, controllers.get(request)!.signal);
      tasks.set(request, task);
      const result = await task;
      reply.header('X-Original-Size', result.originalSize)
        .header('X-Archive-Size', result.bytes.length).header('X-Codec', result.codec);
      return binaryReply(reply, result.bytes, `${safeFilename(result.filename, 250)}.sarc`);
    });
    operations.post('/api/decompress', async (request, reply) => {
      const { file } = await readUpload(request, 'decompress');
      const archiveSize = file.length;
      const task = executor.run('decompress', file, '', 'auto', controllers.get(request)!.signal);
      tasks.set(request, task);
      const result = await task;
      reply.header('X-Original-Size', result.originalSize).header('X-Archive-Size', archiveSize)
        .header('X-Codec', result.codec).header('X-Checksum-Verified', 'sha256');
      return binaryReply(reply, result.bytes, result.filename);
    });
    operations.post('/v1/compress', async (request, reply) => {
      const file = readRaw(request, 'compress');
      const task = executor.run('compress', file, '', 'auto', controllers.get(request)!.signal);
      tasks.set(request, task);
      const result = await task;
      reply.header('X-Original-Size', result.originalSize)
        .header('X-Archive-Size', result.bytes.length).header('X-Codec', result.codec);
      return binaryReply(reply, result.bytes, 'file.sarc');
    });
    operations.post('/v1/decompress', async (request, reply) => {
      const file = readRaw(request, 'decompress');
      const task = executor.run('decompress', file, '', 'auto', controllers.get(request)!.signal);
      tasks.set(request, task);
      const result = await task;
      reply.header('X-Original-Size', result.originalSize).header('X-Archive-Size', file.length)
        .header('X-Codec', result.codec).header('X-Checksum-Verified', 'sha256');
      return binaryReply(reply, result.bytes, result.filename);
    });
  });
}
