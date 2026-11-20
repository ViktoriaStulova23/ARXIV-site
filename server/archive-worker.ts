import { parentPort, workerData } from 'node:worker_threads';
import { compress, decompress } from '../core/archive.js';
import { ArchiveError } from '../core/types.js';
import { transferableView } from './transfer.js';
import type { ArchiveJob, ArchiveJobReply } from './worker-protocol.js';

if (!parentPort) throw new Error('Archive worker requires a parent port');
try {
  const job = workerData as ArchiveJob;
  const input = Buffer.from(job.buffer, job.offset, job.length);
  const result = job.operation === 'compress' ? compress(input, job.filename, job.method) : decompress(input);
  const view = transferableView(result.bytes);
  const reply: ArchiveJobReply = { ok: true, ...view, filename: result.filename, codec: result.codec, originalSize: result.originalSize };
  parentPort.postMessage(reply, [view.buffer]);
} catch (cause) {
  if (!(cause instanceof ArchiveError)) console.error(cause);
  const reply: ArchiveJobReply = cause instanceof ArchiveError ?
    { ok: false, code: cause.code, message: cause.message, statusCode: cause.statusCode } :
    { ok: false, code: 'INTERNAL_ERROR', message: 'Не удалось обработать файл.', statusCode: 500 };
  parentPort.postMessage(reply);
}
parentPort.close();
