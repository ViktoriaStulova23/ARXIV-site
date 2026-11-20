import { ArchiveError } from './types.js';

const MAX_BITS = 15;
const invalid = () => new ArchiveError('INVALID_LZ', 'Повреждённый поток LZ/Huffman.');

export function huffmanLengths(frequencies: Uint32Array): Uint8Array {
  const size = frequencies.length;
  const weights = Array.from(frequencies);
  const left: number[] = [];
  const right: number[] = [];
  const heap: number[] = [];
  function push(node: number) {
    let i = heap.length;
    heap.push(node);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (weights[heap[parent]!]! <= weights[node]!) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = node;
  }
  function pop(): number {
    const root = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && weights[heap[child + 1]!]! < weights[heap[child]!]!) child++;
        if (weights[last]! <= weights[heap[child]!]!) break;
        heap[i] = heap[child]!;
        i = child;
      }
      heap[i] = last;
    }
    return root;
  }
  for (let i = 0; i < size; i++) if (frequencies[i]) push(i);
  const lengths = new Uint8Array(size);
  const active = [...heap];
  if (!heap.length) return lengths;
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    const parent = weights.length;
    weights.push(weights[a]! + weights[b]!);
    left[parent] = a;
    right[parent] = b;
    push(parent);
  }
  const stack: [number, number][] = [[heap[0]!, 0]];
  let maximum = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node < size) {
      lengths[node] = Math.max(1, depth);
      maximum = Math.max(maximum, lengths[node]!);
    } else {
      stack.push([left[node]!, depth + 1], [right[node]!, depth + 1]);
    }
  }
  // Rare highly skewed trees use bounded uniform codes instead of unsafe depths.
  if (maximum > MAX_BITS) for (const symbol of active) lengths[symbol] = Math.max(1, Math.ceil(Math.log2(active.length)));
  return lengths;
}

export function canonicalCodes(lengths: Uint8Array) {
  const counts = new Uint16Array(MAX_BITS + 1);
  let maximum = 0;
  for (const length of lengths) {
    if (length > MAX_BITS) throw invalid();
    if (length) { counts[length] = counts[length]! + 1; maximum = Math.max(maximum, length); }
  }
  let available = 1;
  for (let i = 1; i <= MAX_BITS; i++) {
    available = available * 2 - counts[i]!;
    if (available < 0) throw invalid();
  }
  const next = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let i = 1; i <= MAX_BITS; i++) { code = (code + counts[i - 1]!) * 2; next[i] = code; }
  const codes = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (length) { codes[i] = next[length]!; next[length] = next[length]! + 1; }
  }
  return { codes, maximum };
}

export class BitWriter {
  private accumulator = 0;
  private bits = 0;
  overflow = false;
  constructor(private readonly bytes: Buffer, public position = 0) {}
  write(value: number, count: number) {
    if (this.overflow) return;
    this.accumulator = (this.accumulator << count) | value;
    this.bits += count;
    while (this.bits >= 8) {
      this.bits -= 8;
      if (this.position >= this.bytes.length) { this.overflow = true; return; }
      this.bytes[this.position++] = (this.accumulator >>> this.bits) & 255;
    }
    this.accumulator &= (1 << this.bits) - 1;
  }
  finish() {
    if (this.bits) this.write(0, 8 - this.bits);
    return this.position;
  }
}

export class BitReader {
  private accumulator = 0;
  private bits = 0;
  private position = 0;
  constructor(private readonly bytes: Buffer) {}
  private fill(count: number) {
    while (this.bits < count && this.position < this.bytes.length) {
      this.accumulator = (this.accumulator << 8) | this.bytes[this.position++]!;
      this.bits += 8;
    }
  }
  private consume(count: number) {
    this.bits -= count;
    this.accumulator &= (1 << this.bits) - 1;
  }
  read(count: number): number {
    this.fill(count);
    if (this.bits < count) throw invalid();
    const value = (this.accumulator >>> (this.bits - count)) & ((1 << count) - 1);
    this.consume(count);
    return value;
  }
  symbol(table: Uint16Array, maximum: number): number {
    if (!maximum) throw invalid();
    this.fill(maximum);
    const index = this.bits >= maximum ? this.accumulator >>> (this.bits - maximum) : this.accumulator << (maximum - this.bits);
    const entry = table[index & (table.length - 1)]!;
    const length = entry & 15;
    if (!length || length > this.bits) throw invalid();
    this.consume(length);
    return entry >>> 4;
  }
  finish() {
    if (this.position !== this.bytes.length || this.bits >= 8 || this.accumulator !== 0) throw invalid();
  }
}

export function decodeTable(lengths: Uint8Array) {
  const { codes, maximum } = canonicalCodes(lengths);
  const table = new Uint16Array(1 << maximum);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (!length) continue;
    const start = codes[symbol]! << (maximum - length);
    table.fill((symbol << 4) | length, start, start + (1 << (maximum - length)));
  }
  return { table, maximum };
}
