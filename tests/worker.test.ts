import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { buildServer } from '../server/app.js';
import { multipartBody } from './helpers.js';

it('releases the operation slot when a client disconnects after the upload', async () => {
  const app = await buildServer();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let uploaded!: () => void;
  const uploadFinished = new Promise<void>(resolve => { uploaded = resolve; });
  app.server.on('request', request => {
    if (request.url === '/api/compress') request.once('end', uploaded);
  });
  const body = multipartBody([{ filename: 'large.bin', bytes: randomBytes(4 * 1024 * 1024) }], [['method', 'lz']]);
  const request = http.request(`${address}/api/compress`, { method: 'POST', headers: body.headers });
  request.on('error', () => undefined);
  try {
    request.end(body.payload);
    await uploadFinished;
    await setTimeout(50);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    request.destroy();
    const started = performance.now();
    let status = 503;
    while (status === 503 && performance.now() - started < 2000) {
      await setTimeout(20);
      const response = await app.inject({ method: 'POST', url: '/api/compress',
        ...multipartBody([{ filename: 'x', bytes: Buffer.from('abc') }]) });
      status = response.statusCode;
    }
    expect(status).toBe(200);
  } finally {
    request.destroy();
    await app.close();
  }
});
