import { BitReader, BitWriter, canonicalCodes, decodeTable, huffmanLengths } from './huffman.js';
import { decodeRle, encodeRle } from './rle.js';
import { ArchiveError, checkOriginalSize } from './types.js';

export const LZ_BLOCK_SIZE = 1024 * 1024;
const WINDOW = 1 << 20;
const HASH_SIZE = 1 << 18;
const MAX_LENGTH = 65537;
const SYMBOLS = 272;
const DISTANCES = 20;
const invalid = () => new ArchiveError('INVALID_LZ', 'Повреждённые блоки LZ/Huffman.');

/** Own LZ77 + canonical Huffman. Block output keeps raw slices by reference. */
export function encodeLzChunks(input: Buffer, maximumSize = Infinity): { chunks: Buffer[]; length: number } | undefined {
  checkOriginalSize(input.length);
  if (!input.length) return { chunks: [], length: 0 };
  const heads = new Int32Array(HASH_SIZE).fill(-1);
  const previous = new Int32Array(WINDOW).fill(-1);
  const tokens = new Uint32Array(Math.min(input.length, LZ_BLOCK_SIZE));
  const workspace = Buffer.allocUnsafe(Math.min(input.length, LZ_BLOCK_SIZE));
  const chunks: Buffer[] = [];
  let total = 0;
  function hash(position: number) { return ((input[position]! * 251 + input[position + 1]!) * 251 + input[position + 2]!) & (HASH_SIZE - 1); }
  function insert(position: number) {
    if (position + 2 >= input.length) return;
    const key = hash(position);
    previous[position & (WINDOW - 1)] = heads[key]!;
    heads[key] = position;
  }
  let matchLength = 0;
  let matchDistance = 0;
  function find(position: number, end: number) {
    matchLength = 0; matchDistance = 0;
    if (position + 2 >= end) return;
    let candidate = heads[hash(position)]!;
    const oldest = Math.max(0, position - WINDOW + 1);
    const limit = Math.min(MAX_LENGTH, end - position);
    for (let attempt = 0; candidate >= oldest && attempt < 48; attempt++) {
      if (input[candidate] === input[position] && input[candidate + 1] === input[position + 1] &&
          input[candidate + 2] === input[position + 2] && input[candidate + matchLength] === input[position + matchLength]) {
        let length = 3;
        while (length < limit && input[candidate + length] === input[position + length]) length++;
        if (length > matchLength) {
          matchLength = length; matchDistance = position - candidate;
          if (length === limit || length >= 256) break;
        }
      }
      const next = previous[candidate & (WINDOW - 1)]!;
      if (next >= candidate) break;
      candidate = next;
    }
  }
  for (let start = 0; start < input.length; start += LZ_BLOCK_SIZE) {
    const end = Math.min(start + LZ_BLOCK_SIZE, input.length);
    const frequencies = new Uint32Array(SYMBOLS);
    const distances = new Uint32Array(DISTANCES);
    let count = 0;
    let extraBits = 0;
    for (let position = start; position < end;) {
      find(position, end);
      let length = matchLength;
      const distance = matchDistance;
      insert(position);
      if (length >= 3 && length < 64 && position + 3 < end) {
        find(position + 1, end);
        if (matchLength > length + 1) length = 0;
      }
      if (length >= 3) {
        const lengthClass = 31 - Math.clz32(length - 2);
        const distanceClass = 31 - Math.clz32(distance);
        const symbol = 256 + lengthClass;
        tokens[count++] = symbol;
        tokens[count++] = length - 2 - (1 << lengthClass);
        tokens[count++] = distance;
        frequencies[symbol] = frequencies[symbol]! + 1;
        distances[distanceClass] = distances[distanceClass]! + 1;
        extraBits += lengthClass + distanceClass;
        for (let i = 1; i < length; i++) insert(position + i);
        position += length;
      } else {
        const value = input[position++]!;
        tokens[count++] = value;
        frequencies[value] = frequencies[value]! + 1;
      }
    }
    const lengths = huffmanLengths(frequencies);
    const distanceLengths = huffmanLengths(distances);
    const tree = encodeRle(Buffer.concat([lengths, distanceLengths]));
    const prefixSize = tree.length + 2;
    let encodedSize = end - start;
    let compressed = false;
    let bitCount = extraBits;
    for (let i = 0; i < SYMBOLS; i++) bitCount += frequencies[i]! * lengths[i]!;
    for (let i = 0; i < DISTANCES; i++) bitCount += distances[i]! * distanceLengths[i]!;
    // Exact bit cost avoids encoding an entire incompressible block twice.
    if (prefixSize + Math.ceil(bitCount / 8) < encodedSize) {
      workspace.writeUInt16LE(tree.length, 0);
      workspace.set(tree, 2);
      const symbols = canonicalCodes(lengths).codes;
      const distanceCodes = canonicalCodes(distanceLengths).codes;
      const writer = new BitWriter(workspace.subarray(0, encodedSize), prefixSize);
      for (let i = 0; i < count && !writer.overflow;) {
        const symbol = tokens[i++]!;
        writer.write(symbols[symbol]!, lengths[symbol]!);
        if (symbol >= 256) {
          writer.write(tokens[i++]!, symbol - 256);
          const distance = tokens[i++]!;
          const distanceClass = 31 - Math.clz32(distance);
          writer.write(distanceCodes[distanceClass]!, distanceLengths[distanceClass]!);
          writer.write(distance - (1 << distanceClass), distanceClass);
        }
      }
      if (!writer.overflow) {
        const size = writer.finish();
        if (!writer.overflow && size < encodedSize) { encodedSize = size; compressed = true; }
      }
    }
    const header = Buffer.allocUnsafe(9);
    header.writeUInt32LE(end - start, 0);
    header.writeUInt32LE(encodedSize, 4);
    header[8] = compressed ? 1 : 0;
    total += 9 + encodedSize;
    if (total >= maximumSize) return undefined;
    chunks.push(header, compressed ? Buffer.from(workspace.subarray(0, encodedSize)) : input.subarray(start, end));
  }
  return { chunks, length: total };
}

export function encodeLz(input: Buffer): Buffer {
  const result = encodeLzChunks(input)!;
  return Buffer.concat(result.chunks, result.length);
}

export function decodeLz(input: Buffer, expectedSize: number): Buffer {
  checkOriginalSize(expectedSize);
  // Validate block framing before allocating the full output.
  let framedSize = 0;
  for (let i = 0; i < input.length;) {
    if (i + 9 > input.length) throw invalid();
    const size = input.readUInt32LE(i);
    const stored = input.readUInt32LE(i + 4);
    const mode = input[i + 8]!;
    if (!size || size > LZ_BLOCK_SIZE || framedSize + size > expectedSize || mode > 1 ||
        i + 9 + stored > input.length || (mode === 0 && size !== stored) || (mode === 1 && stored < 3)) throw invalid();
    framedSize += size;
    i += 9 + stored;
  }
  if (framedSize !== expectedSize) throw invalid();
  const output = Buffer.allocUnsafeSlow(expectedSize);
  let target = 0;
  for (let position = 0; position < input.length;) {
    const size = input.readUInt32LE(position);
    const stored = input.readUInt32LE(position + 4);
    const mode = input[position + 8]!;
    position += 9;
    const block = input.subarray(position, position + stored);
    position += stored;
    if (!mode) { output.set(block, target); target += size; continue; }
    const treeSize = block.readUInt16LE(0);
    if (treeSize + 2 >= block.length) throw invalid();
    const lengths = decodeRle(block.subarray(2, 2 + treeSize), SYMBOLS + DISTANCES);
    const symbols = decodeTable(lengths.subarray(0, SYMBOLS));
    const distances = decodeTable(lengths.subarray(SYMBOLS));
    const reader = new BitReader(block.subarray(2 + treeSize));
    const end = target + size;
    while (target < end) {
      const symbol = reader.symbol(symbols.table, symbols.maximum);
      if (symbol < 256) { output[target++] = symbol; continue; }
      const lengthClass = symbol - 256;
      const length = 2 + (1 << lengthClass) + reader.read(lengthClass);
      const distanceClass = reader.symbol(distances.table, distances.maximum);
      const distance = (1 << distanceClass) + reader.read(distanceClass);
      if (length > MAX_LENGTH || distance >= WINDOW || distance > target || target + length > end) throw invalid();
      if (distance === 1) { output.fill(output[target - 1]!, target, target + length); target += length; continue; }
      const start = target;
      let copied = Math.min(distance, length);
      output.copy(output, target, target - distance, target - distance + copied);
      target += copied;
      while (copied < length) {
        const next = Math.min(copied, length - copied);
        output.copy(output, target, start, start + next);
        target += next; copied += next;
      }
    }
    reader.finish();
  }
  return output;
}
