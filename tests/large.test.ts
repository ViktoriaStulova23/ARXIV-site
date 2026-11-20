import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, expect, it } from 'vitest';
import { compress, decompress } from '../core/archive.js';
import { MAX_ARCHIVE_SIZE, MAX_ORIGINAL_SIZE, type Method } from '../core/types.js';
import { buildServer } from '../server/app.js';
import { multipartBody } from './helpers.js';

const app = await buildServer();
afterAll(() => app.close());

it('round-trips exactly 100 MiB with every method, including worst-case RLE literals', () => {
  const original = Buffer.allocUnsafe(MAX_ORIGINAL_SIZE);
  original.fill(Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
  for (const method of ['auto', 'rle', 'deflate', 'lz'] as Method[]) {
    const started = performance.now();
    const archive = compress(original, '100 MiB.bin', method);
    expect(archive.bytes.length).toBeLessThanOrEqual(MAX_ARCHIVE_SIZE);
    const restored = decompress(archive.bytes);
    expect(restored.bytes.equals(original)).toBe(true);
    console.info(JSON.stringify({ scenario: '100 MiB core', method, codec: archive.codec, archiveBytes: archive.bytes.length,
      roundTripMs: Math.round(performance.now() - started), peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
  }
});

it('round-trips 100 MiB of random data through real multipart handlers', async () => {
  const original = randomBytes(MAX_ORIGINAL_SIZE);
  const started = performance.now();
  const packed = await app.inject({ method: 'POST', url: '/api/compress',
    ...multipartBody([{ filename: 'random.bin', bytes: original }]) });
  expect(packed.statusCode).toBe(200);
  expect(packed.headers['x-codec']).toBe('STORE');
  const unpacked = await app.inject({ method: 'POST', url: '/api/decompress',
    ...multipartBody([{ filename: 'random.sarc', bytes: packed.rawPayload }]) });
  expect(unpacked.statusCode).toBe(200);
  expect(unpacked.rawPayload.equals(original)).toBe(true);
  expect(unpacked.headers['x-checksum-verified']).toBe('sha256');
  console.info(JSON.stringify({ scenario: '100 MiB random multipart round trip',
    roundTripMs: Math.round(performance.now() - started), peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
});

it('rejects a real upload of 100 MiB + 1 byte with 413 and keeps serving', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/compress',
    ...multipartBody([{ filename: 'too-large.bin', bytes: Buffer.alloc(MAX_ORIGINAL_SIZE + 1) }]) });
  expect(response.statusCode).toBe(413);
  expect(response.json().error.code).toBe('FILE_TOO_LARGE');
  expect((await app.inject('/api/health')).statusCode).toBe(200);
  console.info(JSON.stringify({ scenario: '100 MiB + 1 upload rejected', peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
});

it('rejects archive uploads over 102 MiB', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/decompress',
    ...multipartBody([{ filename: 'too-large.sarc', bytes: Buffer.alloc(MAX_ARCHIVE_SIZE + 1) }]) });
  expect(response.statusCode).toBe(413);
  expect((await app.inject('/api/health')).statusCode).toBe(200);
});
