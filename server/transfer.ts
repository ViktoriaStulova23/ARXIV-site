import { isMarkedAsUntransferable } from 'node:worker_threads';

export function transferableView(bytes: Buffer): { buffer: ArrayBuffer; offset: number; length: number } {
  // Small pooled Node buffers cannot be transferred; copy only those buffers.
  if (bytes.buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(bytes.buffer)) {
    return { buffer: bytes.buffer, offset: bytes.byteOffset, length: bytes.byteLength };
  }
  const owned = Buffer.allocUnsafeSlow(bytes.byteLength);
  owned.set(bytes);
  return { buffer: owned.buffer as ArrayBuffer, offset: 0, length: bytes.byteLength };
}
