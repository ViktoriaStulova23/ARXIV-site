import { ArchiveError, checkOriginalSize } from './types.js';

/** Literal: control 0..127 followed by control+1 bytes.
 * Repeat: control 128..255 followed by one byte, repeated control-128+3 times.
 * This is a custom PackBits-style format, not the TIFF PackBits wire format. */
function scanRle(input: Uint8Array, output?: Buffer): number {
  let source = 0;
  let target = 0;
  while (source < input.length) {
    let run = 1;
    while (run < 130 && source + run < input.length && input[source + run] === input[source]) run++;
    if (run >= 3) {
      if (output) { output[target] = 128 + run - 3; output[target + 1] = input[source]!; }
      target += 2;
      source += run;
    } else {
      const start = source;
      // Stop before a run of at least three or at the literal block limit.
      do {
        source++;
      } while (source < input.length && source - start < 128 &&
        !(source + 2 < input.length && input[source] === input[source + 1] && input[source] === input[source + 2]));
      if (output) { output[target] = source - start - 1; output.set(input.subarray(start, source), target + 1); }
      target++;
      target += source - start;
    }
  }
  return target;
}

export function rleEncodedSize(input: Uint8Array): number {
  checkOriginalSize(input.length);
  return scanRle(input);
}

export function writeRle(input: Uint8Array, output: Buffer): void {
  const written = scanRle(input, output);
  if (written !== output.length) throw new Error('Incorrect RLE output allocation');
}

export function encodeRle(input: Uint8Array): Buffer {
  const output = Buffer.allocUnsafeSlow(rleEncodedSize(input));
  writeRle(input, output);
  return output;
}

export function decodeRle(input: Uint8Array, expectedSize: number): Buffer {
  checkOriginalSize(expectedSize);
  // Validate the entire packet stream before allocating the output.
  let size = 0;
  for (let i = 0; i < input.length;) {
    const control = input[i++]!;
    const literal = control < 128;
    const length = literal ? control + 1 : control - 128 + 3;
    const consumed = literal ? length : 1;
    if (i + consumed > input.length || size + length > expectedSize) {
      throw new ArchiveError('INVALID_RLE', 'Повреждённые или усечённые блоки RLE.');
    }
    i += consumed;
    size += length;
  }
  if (size !== expectedSize) throw new ArchiveError('SIZE_MISMATCH', 'Размер RLE не совпадает с заголовком.');
  const output = Buffer.allocUnsafeSlow(expectedSize);
  let target = 0;
  for (let i = 0; i < input.length;) {
    const control = input[i++]!;
    if (control < 128) {
      const length = control + 1;
      output.set(input.subarray(i, i + length), target);
      i += length;
      target += length;
    } else {
      const length = control - 128 + 3;
      output.fill(input[i++]!, target, target + length);
      target += length;
    }
  }
  return output;
}
