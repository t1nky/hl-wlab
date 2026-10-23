import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { candidates, readBSP } from '../src/engine/bsp.ts';
import { bits, RecordTable } from '../src/storage/records.ts';
import * as baseline from './helpers/reference-bsp.js';

const path = (s: string) => fileURLToPath(new URL(s, import.meta.url));
const words = (...floats: number[]) => new Uint32Array(Float32Array.from(floats).buffer);
const hasAssets = existsSync(path('../assets/de_inferno.bsp'));

test('cache keys are exact float32 bit patterns with -0 folded into +0', () => {
  assert.equal(bits(-0), 0);
  assert.equal(bits(0), 0);
  assert.equal(bits(1), 0x3f800000);
  assert.equal(bits(Math.fround(0.1)), bits(0.1), 'float64 inputs are rounded to float32 first');
  assert.notEqual(bits(1), bits(1 + 2 ** -23));
});

test('ramp coverage adds authored heights without losing any previous cacheable seed', {
  skip: !hasAssets,
}, () => {
  const buffer = Uint8Array.from(readFileSync(path('../assets/de_inferno.bsp'))).buffer,
    bsp = readBSP(buffer, { pixels: false });
  const target = [1088.574951171875, 302.201416015625, 260.03125],
    current = new Set([...candidates(bsp, 12, 8192, target)].map((p) => p.join(',')));
  const old = [...baseline.candidates(bsp, 12, 8192, target)];
  assert.ok(current.size > old.length);
  for (const p of old) assert.ok(current.has(p.join(',')), `lost previous seed ${p}`);
  const coarse = [...candidates(bsp, 24, 8192, target)];
  for (const p of coarse) assert.ok(current.has(p.join(',')), `unaligned nested seed ${p}`);
});

test('RecordTable finds every key through growth and reindexing, and only those keys', () => {
  const table = new RecordTable(6),
    expected = new Map();
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 20000; i++) {
    // Small ranges force colliding hashes and repeated keys.
    const key: [number, number, number, number] = [
        next() & 1,
        next() % 40,
        next() % 40,
        next() % 9,
      ],
      name = key.join();
    if (table.find(...key) >= 0) continue;
    const values = new Uint32Array([next(), next()]);
    table.append(...key, values, 0);
    expected.set(name, values);
  }
  assert.equal(table.size, expected.size);
  for (const [name, values] of expected) {
    const r = table.find(...(name.split(',').map(Number) as [number, number, number, number]));
    assert.ok(r >= 0, name);
    assert.deepEqual(table.words.subarray(r * 6 + 4, r * 6 + 6), values);
  }
  assert.equal(table.find(2, 0, 0, 0), -1);
  assert.equal(table.find(0, 40, 0, 0), -1);
});

test('RecordTable values stay bit-exact and survive a snapshot round trip', () => {
  const table = new RecordTable(4 + 3),
    source = new Uint32Array([0x7fc00001, 0x80000000, ...words(444.5)]);
  table.append(1, bits(-16), bits(32), bits(260.03125), source, 0);
  assert.equal(table.dirty, true);
  const reopened = new RecordTable(7, new Uint32Array(table.snapshot().buffer));
  assert.equal(reopened.dirty, false);
  const r = reopened.find(1, bits(-16), bits(32), bits(260.03125));
  assert.deepEqual(
    reopened.words.subarray(r * 7 + 4, r * 7 + 7),
    source,
    'NaN payload and -0 are copied as words',
  );
  assert.equal(reopened.floats[r * 7 + 6], 444.5);
  reopened.append(0, 1, 2, 3, source, 0);
  assert.equal(
    reopened.find(1, bits(-16), bits(32), bits(260.03125)),
    r,
    'growth keeps earlier records',
  );
});

test('geometry-only BSP reads validate the header like full reads', () => {
  assert.throws(() => readBSP(new ArrayBuffer(124), { pixels: false }), /v30/);
});

test('readBSP and flat-surface candidate vectors retain the original bit patterns on Inferno', {
  skip: !hasAssets,
}, () => {
  const buffer = Uint8Array.from(readFileSync(path('../assets/de_inferno.bsp'))).buffer;
  const current = readBSP(buffer),
    original = baseline.readBSP(buffer);
  // Baked lightmaps add display-only metadata. Every pre-existing field and all
  // scan-only geometry must still retain the original bit patterns.
  assert.deepStrictEqual(
    { ...current, faces: current.faces.map(({ lightmap: _, ...face }) => face) },
    original,
  );
  const geometry = readBSP(buffer, { pixels: false });
  assert.deepStrictEqual(geometry.faces, original.faces);
  assert.deepStrictEqual(
    geometry.textures.map((t) => t.name),
    original.textures.map((t) => t.name),
  );
  assert.ok(geometry.textures.every((t) => t.rgba === null));
  const target = [1159.721435546875, 288.6636047363281, 260.0310974121094];
  const cases: [number, number, number[]][] = [
    [12, 1536, target],
    [6, 1536, target],
    [7, 500, [-1000, 1500, 0]],
    [24, 384, [1428, 312, 196.03125]],
    [12, 384, [-640.25, 880.5, 64]],
  ];
  for (const [spacing, radius, at] of cases) {
    const flat = { ...geometry, faces: geometry.faces.filter((f) => Math.abs(f.normal[2]) === 1) },
      oldFlat = { ...original, faces: original.faces.filter((f) => Math.abs(f.normal[2]) === 1) };
    const a = [...candidates(flat, spacing, radius, at)],
      b = [...baseline.candidates(oldFlat, spacing, radius, at)];
    assert.equal(a.length, b.length);
    // Object.is keeps -0 distinct: the core receives the candidate as emitted.
    assert.ok(
      a.every((p, i) => p.every((v, j) => Object.is(v, b[i][j]))),
      `spacing ${spacing}: same points, order and zero signs`,
    );
  }
});
