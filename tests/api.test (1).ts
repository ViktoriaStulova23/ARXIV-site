import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildServer } from '../server/app.js';
import { compress } from '../core/archive.js';
import { contentDisposition } from '../server/routes.js';
import { multipartBody } from './helpers.js';

const app = await buildServer();
afterAll(() => app.close());

describe('HTTP API', () => {
  it('reports arena health directly without a redirect', async () => {
    const response = await app.inject({ url: '/v1/health', headers: {
      authorization: 'Bearer test-token', 'x-arena-mode': 'check', 'x-arena-spec': 'v1',
      'x-arena-run': 'test-run', 'x-arena-seq': '0',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers.location).toBeUndefined();
  });
  it('reports health', async () => {
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '1.0.0' });
  });
  it.each(['auto', 'rle', 'deflate', 'lz'])('round-trips multipart binary using %s', async method => {
    const bytes = randomBytes(10000);
    const packed = await app.inject({ method: 'POST', url: '/api/compress', ...multipartBody([{ filename: 'Отчёт 1.bin', bytes }], [['method', method]]) });
    expect(packed.statusCode).toBe(200);
    expect(packed.headers['content-type']).toBe('application/octet-stream');
    expect(packed.headers['x-original-size']).toBe('10000');
    expect(packed.headers['x-archive-size']).toBe(String(packed.rawPayload.length));
    expect(['STORE', 'RLE', 'DEFLATE', 'LZ']).toContain(packed.headers['x-codec']);
    expect(packed.headers['content-disposition']).toContain("filename*=UTF-8''");
    const unpacked = await app.inject({ method: 'POST', url: '/api/decompress', ...multipartBody([{ filename: 'anything.dat', bytes: packed.rawPayload }]) });
    expect(unpacked.statusCode).toBe(200);
    expect(unpacked.rawPayload.equals(bytes)).toBe(true);
    expect(unpacked.headers['x-checksum-verified']).toBe('sha256');
    expect(unpacked.headers['content-disposition']).toBe(contentDisposition('Отчёт 1.bin'));
  });
  it('accepts empty uploads and defaults to AUTO', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/compress', ...multipartBody([{ filename: 'empty', bytes: Buffer.alloc(0) }]) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-codec']).toBe('STORE');
  });
  it('preserves .sarc suffix for a maximum-length Unicode filename', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/compress',
      ...multipartBody([{ filename: 'я'.repeat(127), bytes: Buffer.from('x') }]) });
    expect(response.statusCode).toBe(200);
    const encoded = String(response.headers['content-disposition']).split("filename*=UTF-8''")[1]!;
    const name = decodeURIComponent(encoded);
    expect(name.endsWith('.sarc')).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  });
  it('rejects missing files, extra files, wrong fields, duplicate/invalid method and malformed multipart', async () => {
    const file = { filename: 'x', bytes: Buffer.from('abc') };
    for (const body of [multipartBody([]), multipartBody([file, file]), multipartBody([{ ...file, name: 'other' }]),
      multipartBody([file], [['method', 'unknown']]), multipartBody([file], [['method', 'auto'], ['method', 'rle']]),
      multipartBody([file], [['other', 'auto']]), { payload: '--broken', headers: { 'content-type': 'multipart/form-data' } }]) {
      const response = await app.inject({ method: 'POST', url: '/api/compress', ...body });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBeTypeOf('string');
      expect(response.json()).not.toHaveProperty('stack');
    }
  });
  it('supports method after file and rejects unexpected fields during decompression', async () => {
    const boundary = 'test-order';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\naaa\r\n--${boundary}\r\nContent-Disposition: form-data; name="method"\r\n\r\nrle\r\n--${boundary}--\r\n`);
    const response = await app.inject({ method: 'POST', url: '/api/compress', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-codec']).toBe('RLE');
    const invalid = await app.inject({ method: 'POST', url: '/api/decompress', ...multipartBody([{ filename: 'x.sarc', bytes: response.rawPayload }], [['method', 'auto']]) });
    expect(invalid.statusCode).toBe(400);
  });
  it('returns controlled errors for broken archives, unknown formats and oversized declared output', async () => {
    const archive = compress(Buffer.from('abc'), 'x').bytes;
    archive[12]! ^= 1;
    for (const [bytes, status] of [[archive, 400], [Buffer.from('not a sarc'), 415]] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/decompress', ...multipartBody([{ filename: 'x.sarc', bytes }]) });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBeTypeOf('string');
    }
    archive.writeUInt32LE(104857601, 6);
    const response = await app.inject({ method: 'POST', url: '/api/decompress', ...multipartBody([{ filename: 'x', bytes: archive }]) });
    expect(response.statusCode).toBe(413);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
  it('returns uniform JSON for wrong content type and unknown API route', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/compress', payload: '{}' });
    expect([400, 415]).toContain(response.statusCode);
    expect(response.json()).toHaveProperty('error.code');
    expect((await app.inject('/api/unknown')).json().error.code).toBe('NOT_FOUND');
  });
  it('escapes Unicode, quotes, controls and reserved names in download headers', () => {
    expect(contentDisposition('../CON\r\n.txt')).not.toMatch(/[\r\n]/);
    expect(contentDisposition('тест (1).txt')).toContain('%28');
  });
});

describe('Протокол арены v1 (сырые байты)', () => {
  const raw = (url: string, payload: Buffer) => app.inject({ method: 'POST', url,
    headers: { 'content-type': 'application/octet-stream', 'x-arena-mode': 'check' }, payload });
  it.each([
    ['текст', Buffer.from('Шалом, архиватор! '.repeat(200))],
    ['случайные байты', randomBytes(4096)],
    ['нули', Buffer.alloc(100000)],
    ['пустой файл', Buffer.alloc(0)],
    ['один байт', Buffer.from([7])],
  ])('%s: сжатие и распаковка дают исходные байты, архив в пределах лимита', async (_name, bytes) => {
    const packed = await raw('/v1/compress', bytes);
    expect(packed.statusCode).toBe(200);
    expect(packed.rawPayload.length).toBeLessThanOrEqual(2 * bytes.length + 1024);
    const unpacked = await raw('/v1/decompress', packed.rawPayload);
    expect(unpacked.statusCode).toBe(200);
    expect(unpacked.rawPayload.equals(bytes)).toBe(true);
  });
  it('битый архив: ответ 4xx с JSON-ошибкой, сервис не падает', async () => {
    const response = await raw('/v1/decompress', randomBytes(64));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.json()).toHaveProperty('error.code');
    expect((await app.inject('/v1/health')).statusCode).toBe(200);
  });
  it('CORS: preflight пропускает браузерную песочницу', async () => {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/compress', headers: {
      origin: 'https://arena.projectset.ru', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true',
    } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
    const packed = await raw('/v1/compress', Buffer.from('abc'));
    expect(packed.headers['access-control-allow-origin']).toBe('*');
  });
});
