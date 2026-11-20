import { Worker } from 'node:worker_threads';
import { ArchiveError, type Method } from '../core/types.js';
import { transferableView } from './transfer.js';
import type { ArchiveJob, ArchiveJobReply } from './worker-protocol.js';

export function createArchiveExecutor() {
  const workers = new Set<Worker>();
  let closed = false;
  function run(operation: ArchiveJob['operation'], bytes: Buffer, filename: string, method: Method, signal: AbortSignal) {
    if (closed) throw new ArchiveError('SERVER_CLOSING', 'Сервер завершает работу.', 503);
    if (signal.aborted) throw new ArchiveError('REQUEST_ABORTED', 'Загрузка прервана.');
    const view = transferableView(bytes);
    const job: ArchiveJob = { operation, ...view, filename, method };
    // Production workers use compiled JS and have no dependency on tsx or tests.
    // During development tsImport registers TypeScript support inside the worker.
    const entry = import.meta.url.endsWith('.ts') ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};` +
      `await tsImport(${JSON.stringify(new URL('./archive-worker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)});`,
    )}`) : new URL('./archive-worker.js', import.meta.url);
    const worker = new Worker(entry, { workerData: job, transferList: [view.buffer], execArgv: [] });
    workers.add(worker);
    return new Promise<{ bytes: Buffer; filename: string; codec: string; originalSize: number }>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new ArchiveError('PROCESSING_TIMEOUT', 'Превышено время обработки файла.', 503)), 120_000);
      timeout.unref();
      const abort = () => finish(new ArchiveError('REQUEST_ABORTED', 'Запрос прерван.'));
      function finish(error?: Error, reply?: Extract<ArchiveJobReply, { ok: true }>) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        void worker.terminate().then(() => {
          workers.delete(worker);
          if (error) reject(error);
          else if (reply) resolve({ bytes: Buffer.from(reply.buffer, reply.offset, reply.length),
            filename: reply.filename, codec: reply.codec, originalSize: reply.originalSize });
        }, reject);
      }
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (reply: ArchiveJobReply) => {
        if (reply.ok) finish(undefined, reply);
        else finish(new ArchiveError(reply.code, reply.message, reply.statusCode));
      });
      worker.once('error', error => finish(error));
      worker.once('exit', () => {
        if (!settled) finish(new ArchiveError(closed ? 'SERVER_CLOSING' : 'WORKER_FAILED',
          closed ? 'Сервер завершает работу.' : 'Обработка файла неожиданно завершилась.', closed ? 503 : 500));
      });
      if (signal.aborted) abort();
    });
  }
  return {
    run,
    async close() {
      closed = true;
      await Promise.all([...workers].map(worker => worker.terminate()));
    },
  };
}
