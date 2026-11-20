import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ArchiveError, MAX_ARCHIVE_SIZE } from '../core/types.js';
import { registerRoutes } from './routes.js';

export async function buildServer(options: { logger?: boolean; staticRoot?: string } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_ARCHIVE_SIZE + 64 * 1024, requestTimeout: 120_000 });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ArchiveError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const known = error as { code?: string; statusCode?: number };
    if (known.code === 'FST_REQ_FILE_TOO_LARGE' || known.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'Превышен лимит: файл 100 MiB, архив 102 MiB.' } });
    }
    if ((known.code?.startsWith('FST_') && known.statusCode && known.statusCode < 500) ||
        known.code === 'ERR_STREAM_PREMATURE_CLOSE' || known.code === 'ECONNRESET' ||
        (error instanceof Error && /multipart|boundary|Unexpected end of form/i.test(error.message))) {
      return reply.code(known.statusCode === 415 ? 415 : 400).send({
        error: { code: 'INVALID_REQUEST', message: 'Некорректный запрос. Нужен один файл file и допустимые поля multipart.' },
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера. Повторите операцию.' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.' } }));
  // CORS
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Expose-Headers', 'X-Original-Size, X-Archive-Size, X-Codec, X-Checksum-Verified, Content-Disposition');
    if (request.method === 'OPTIONS') {
      return reply.code(204)
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] ?? '*')
        .header('Access-Control-Allow-Private-Network', 'true')
        .header('Access-Control-Max-Age', '600')
        .send();
    }
  });
  // Протокол арены v1: тело запроса — сырые байты файла или архива.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  await app.register(multipart, { limits: { fileSize: MAX_ARCHIVE_SIZE, files: 1, fields: 1, parts: 2 } });
  await registerRoutes(app);
  if (options.staticRoot) await app.register(fastifyStatic, { root: options.staticRoot, index: 'index.html' });
  return app;
}
