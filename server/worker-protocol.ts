import type { Codec, Method } from '../core/types.js';

export interface ArchiveJob {
  operation: 'compress' | 'decompress';
  buffer: ArrayBuffer;
  offset: number;
  length: number;
  filename: string;
  method: Method;
}

export type ArchiveJobReply = {
  ok: true; buffer: ArrayBuffer; offset: number; length: number;
  filename: string; codec: Codec; originalSize: number;
} | {
  ok: false; code: string; message: string; statusCode: number;
};
