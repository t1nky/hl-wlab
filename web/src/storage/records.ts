// Exact float32 identities without string keys. A key is four 32-bit words,
// e.g. stance and the float32 bit patterns of a candidate origin.
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);

// -0 and +0 are the same position, as in the original string keys.
export function bits(v: number) {
  f32[0] = v;
  return u32[0] === 0x80000000 ? 0 : u32[0];
}

function hash(a: number, b: number, c: number, d: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15) ^ c, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13) ^ d, 0x165667b1);
  return h ^ (h >>> 16);
}

// Append-only table of fixed-width 32-bit records: four key words, then
// values. Values are copied as raw words so float32 results stay bit-exact;
// `floats` views the same memory. `words` may be a persisted buffer; it is
// only copied when the table grows.
export class RecordTable {
  width: number;
  words!: Uint32Array;
  floats!: Float32Array;
  slots!: Int32Array;
  size: number;
  dirty: boolean;
  constructor(width: number, words = new Uint32Array(0)) {
    this.width = width;
    this.adopt(words);
    this.size = words.length / width;
    this.dirty = false;
    this.reindex(this.size * 2);
  }

  adopt(words: Uint32Array) {
    this.words = words;
    this.floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  }

  reindex(minimum: number) {
    let n = 64;
    while (n < minimum) n *= 2;
    this.slots = new Int32Array(n);
    for (let r = 0; r < this.size; r++) this.place(r);
  }

  // Slots hold record index + 1, so 0 marks an empty slot.
  place(r: number) {
    const w = this.words,
      o = r * this.width,
      mask = this.slots.length - 1;
    let s = hash(w[o], w[o + 1], w[o + 2], w[o + 3]) & mask;
    while (this.slots[s]) s = (s + 1) & mask;
    this.slots[s] = r + 1;
  }

  // Record index, or -1. Its values start at word index * width + 4.
  find(a: number, b: number, c: number, d: number) {
    const w = this.words,
      width = this.width,
      mask = this.slots.length - 1;
    for (let s = hash(a, b, c, d) & mask; ; s = (s + 1) & mask) {
      const r = this.slots[s];
      if (!r) return -1;
      const o = (r - 1) * width;
      if (w[o] === a && w[o + 1] === b && w[o + 2] === c && w[o + 3] === d) return r - 1;
    }
  }

  // Appends a key that find() reported absent; its values start zeroed.
  insert(a: number, b: number, c: number, d: number) {
    const r = this.size++;
    if (this.size * this.width > this.words.length) {
      const grown = new Uint32Array(Math.max(64, this.size * 2) * this.width);
      grown.set(this.words.subarray(0, r * this.width));
      this.adopt(grown);
    }
    const o = r * this.width;
    this.words[o] = a;
    this.words[o + 1] = b;
    this.words[o + 2] = c;
    this.words[o + 3] = d;
    if (this.size * 2 > this.slots.length) this.reindex(this.size * 2);
    else this.place(r);
    this.dirty = true;
    return r;
  }

  // Appends a key that find() reported absent with width - 4 value words
  // copied from source[at…].
  append(a: number, b: number, c: number, d: number, source: Uint32Array, at: number) {
    const r = this.insert(a, b, c, d);
    this.words.set(source.subarray(at, at + this.width - 4), r * this.width + 4);
  }

  snapshot() {
    return this.words.slice(0, this.size * this.width);
  }
}
