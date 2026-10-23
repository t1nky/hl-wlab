import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { Matrix4 } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { CollisionMap } from '../cs2/collision';
import {
  accelerationDigest,
  type NativeAcceleration,
  nativeAcceleration,
} from '../cs2/native-acceleration';
import { attachNativeScan, createNativeScan } from '../cs2/native-scan';
import { clearScanPlacementCache, type ScanRequestData, scanMap } from '../cs2/scan';
import { mergeScanParts, shareCollision } from '../cs2/scan-parallel';
import { required, type V3 } from '../cs2/types';
import type { TargetPose } from '../src/games/target';
import { fixture } from './helpers/cs2-map';

const wasm = readFileSync(new URL('../cs2/scan.wasm', import.meta.url));
const request: ScanRequestData = {
  target: [100, 0, 80],
  settings: { spacing: 16, radius: 128, workers: 1 },
};
const noop = () => {};
const never = () => false;
const makeMap = () =>
  fixture([
    { center: [0, 0, -10], size: [1000, 1000, 20] },
    { center: [60, 0, 80], size: [1, 300, 160] },
    { center: [0, 60, 80], size: [300, 1, 160], bullet: false },
    { center: [-70, 0, 42], size: [200, 250, 10], rotationY: 0.32 },
    { center: [100, -100, 90], size: [100, 100, 20], player: false },
  ]);
afterEach(() => vi.unstubAllGlobals());

it('native strict-f64 placement, grazing rays and tied sweep normals match JS', async () => {
  const map = makeMap();
  // Coincident mesh faces and mixed materials exercise stable original DFS ordering.
  map.metadata.shapes[1].kind = 'mesh';
  map.metadata.materials.push({
    name: 'wood',
    hash: 2,
    distanceModifier: 0.9,
    damageModifier: 0.6,
    gameMaterial: 'W',
  });
  for (let i = 0; i < map.data.materials.length; i++) map.data.materials[i] = i % 2;
  const native = await createNativeScan(map, wasm);
  let seed = 731902;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 600; i++) {
    const foot: V3 =
      i < 10
        ? [0, 0, i % 2 ? 0.05 : 80]
        : [random() * 500 - 250, random() * 500 - 250, random() * 160];
    const delta: V3 =
      i < 10
        ? [100, 100, -100]
        : [random() * 400 - 200, random() * 400 - 200, random() * 200 - 100];
    const height = i % 2 ? 54 : 72;
    expect(native.sweep(foot, height, delta)).toEqual(map.sweepPlayer(foot, height, delta));
    expect(native.fits(foot, height, !!(i % 3))).toBe(map.playerFits(foot, height, !!(i % 3)));
    const target: V3 =
      i % 5
        ? [random() * 600 - 300, random() * 600 - 300, random() * 200]
        : [foot[0], foot[1], foot[2] + 1];
    for (const kind of ['bullet', 'player'] as const) {
      const shot = map.trace(foot, target, kind);
      expect(native.trace(foot, target, kind)).toEqual([
        shot.damage ?? -1,
        ['clear', 'estimated-penetration', 'blocked', 'indeterminate'].indexOf(shot.status),
        shot.spans.length,
      ]);
    }
  }
  const expected = await scanMap(map, request, noop, never);
  clearScanPlacementCache(map);
  map.native = native;
  const cold = await scanMap(map, request, noop, never);
  const warm = await scanMap(map, request, noop, never);
  expect(cold.rows).toEqual(expected.rows);
  expect(warm.rows).toEqual(expected.rows);
  expect(cold.stats).toEqual(expected.stats);
  expect(cold.native?.fallbacks).toBe(0);
  map.metadata.weapon.damage = 20;
  const changed = await scanMap(map, request, noop, never);
  map.native = undefined;
  clearScanPlacementCache(map);
  expect(changed.rows).toEqual((await scanMap(map, request, noop, never)).rows);
  expect(changed.rows).not.toEqual(expected.rows);
  map.dispose();
  native.dispose();
  expect(() => native.column(0, 0)).toThrow('closed');
});

it.each([2, 4])(
  'shares one actual WASM.Memory across %i disjoint contexts, merging exact output',
  async (count) => {
    const map = makeMap();
    const serial = await scanMap(map, request, noop, never);
    const native = await createNativeScan(map, wasm);
    const shared = shareCollision(map, native.shared);
    expect(shared.data.positions.buffer).toBe(native.shared.memory.buffer);
    expect(shared.bytes).toBe(
      native.shared.bytes +
        shared.cache.roots.reduce((sum, root) => sum + root.byteLength, 0) +
        required(shared.cache.indirectBuffer).buffer.byteLength,
    );
    const maps = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const copy = structuredClone(shared);
        const part = new CollisionMap(copy.data, copy.metadata, copy.cache);
        part.native = await attachNativeScan(required(copy.native), i + 1, copy.metadata);
        return part;
      }),
    );
    const parts = await Promise.all(
      maps.map((part, index) =>
        scanMap(part, { ...request, partition: { index, count } }, noop, never),
      ),
    );
    const merged = mergeScanParts(parts);
    expect(merged.rows).toEqual(serial.rows);
    expect(merged.stats).toEqual(serial.stats);
    expect(merged.native?.fallbacks).toBe(0);
    // Closing one instance must leave other contexts and immutable geometry usable.
    const closed = required(maps[0].native);
    maps[0].dispose();
    expect(() => closed.trace([0, 0, 50], [100, 0, 50])).toThrow('closed');
    expect(required(maps[1].native).column(200, 200)).toBeDefined();
    for (const part of maps) part.dispose();
    native.dispose();
    map.dispose();
  },
);

it.each(['open', 'sky', 'unknown', 'blockbullets', 'glass', 'range', 'no-penetration'])(
  'retains full-far uncertainty/material semantics for %s geometry',
  async (variant) => {
    let map = fixture([{ center: [20, 0, 50], size: [10, 200, 200] }]);
    map.metadata.shapes[0].kind = 'mesh';
    if (variant === 'open') {
      const original = map;
      // Remove one complete face; all remaining faces (including beyond target) stay indexed.
      map = new CollisionMap(
        {
          ...original.data,
          indices: original.data.indices.slice(6),
          shapes: original.data.shapes.slice(2),
          materials: original.data.materials.slice(2),
        },
        original.metadata,
      );
      original.dispose();
    }
    if (variant === 'sky') map.metadata.shapes[0].tags = ['sky'];
    if (variant === 'unknown') map.metadata.materials[0].distanceModifier = null;
    if (variant === 'blockbullets' || variant === 'glass') map.metadata.materials[0].name = variant;
    if (variant === 'range') map.metadata.weapon.range = 10;
    if (variant === 'no-penetration') map.metadata.weapon.penetration = 0;
    const native = await createNativeScan(map, wasm);
    for (const [source, target] of [
      [
        [0, 0, 50],
        [10, 0, 50],
      ], // target before remote first crossing
      [
        [20, 0, 50],
        [21, 0, 50],
      ], // start inside, remote exit
      [
        [0, 0, 50],
        [20, 0, 50],
      ], // target inside
      [
        [0, 0, 50],
        [100, 0, 50],
      ],
      [
        [100, 0, 50],
        [0, 0, 50],
      ],
      [
        [0, 100, 50],
        [100, 100, 50],
      ], // coincident edge crossings
    ] as [V3, V3][]) {
      for (const kind of ['bullet', 'player'] as const) {
        const shot = map.trace(source, target, kind);
        expect(native.trace(source, target, kind)).toEqual([
          shot.damage ?? -1,
          ['clear', 'estimated-penetration', 'blocked', 'indeterminate'].indexOf(shot.status),
          shot.spans.length,
        ]);
      }
    }
    native.dispose();
    map.dispose();
  },
);

it('bounded native hit overflow falls back to full JS rather than dropping geometry', async () => {
  const map = fixture([
    { center: [0, 0, -10], size: [1000, 1000, 20] },
    ...Array.from({ length: 2300 }, (_, i) => ({
      center: [i * 0.01, 0, 80] as V3,
      size: [1, 200, 160] as V3,
      player: false,
    })),
  ]);
  const expected = await scanMap(
    map,
    { ...request, target: [100, 0, 80], settings: { spacing: 16, radius: 128, workers: 1 } },
    noop,
    never,
  );
  const native = await createNativeScan(map, wasm);
  expect(native.trace([-100, 0, 80], [100, 0, 80])[1]).toBe(-1);
  clearScanPlacementCache(map);
  map.native = native;
  const result = await scanMap(
    map,
    { ...request, target: [100, 0, 80], settings: { spacing: 16, radius: 128, workers: 1 } },
    noop,
    never,
  );
  expect(result.rows).toEqual(expected.rows);
  expect(result.rows.length).toBeGreaterThan(0);
  expect(result.native?.fallbacks).toBeGreaterThan(0);
  map.dispose();
});

it('versioned acceleration cache rejects changed collision flags and corrupt escapes', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const map = makeMap();
  map.metadata.binarySha256 = 'a'.repeat(64);
  expect((await nativeAcceleration(map, 'sah', 8)).timing.cached).toBe(false);
  expect((await nativeAcceleration(map, 'sah', 8)).timing.cached).toBe(true);
  map.metadata.shapes[1].player = false;
  expect((await nativeAcceleration(map, 'sah', 8)).timing.cached).toBe(false);
  const db = await new Promise<IDBDatabase>((resolve) => {
    const r = indexedDB.open('wallbang-cs2-native', 1);
    r.onsuccess = () => resolve(r.result);
  });
  const corrupt = (change: (value: { version: number; roots: ArrayBuffer[] }) => void) =>
    new Promise<void>((resolve) => {
      const tx = db.transaction('acceleration', 'readwrite'),
        store = tx.objectStore('acceleration');
      const r = store.openCursor();
      r.onsuccess = () => {
        const cursor = required(r.result);
        const value = cursor.value;
        change(value);
        cursor.update(value);
      };
      tx.oncomplete = () => resolve();
    });
  await corrupt((value) => {
    value.version = 99;
  });
  expect((await nativeAcceleration(map, 'sah', 8)).timing.cached).toBe(false);
  await corrupt((value) => {
    const root = new Uint32Array(value.roots[0]);
    root[7] = 3;
    root[6] = 0;
  });
  expect((await nativeAcceleration(map, 'sah', 8)).timing.cached).toBe(false);
  db.close();
  map.dispose();
});

it.each(['empty-leaves', 'duplicate-triangle', 'overlap', 'mask', 'escape', 'bounds', 'digest'])(
  'rebuilds %s cache corruption and preserves the exact wall hit',
  async (variant) => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const map = fixture([{ center: [0, 0, 0], size: [20, 200, 200] }]);
    map.metadata.binarySha256 = 'b'.repeat(64);
    const first = await createNativeScan(map, wasm);
    const expected = first.trace([-100, 0, 0], [100, 0, 0]);
    first.dispose();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('wallbang-cs2-native', 1);
      r.onsuccess = () => resolve(r.result);
    });
    const { key, value } = await new Promise<{ key: IDBValidKey; value: NativeAcceleration }>(
      (resolve) => {
        const r = db.transaction('acceleration').objectStore('acceleration').openCursor();
        r.onsuccess = () => {
          const c = required(r.result);
          resolve({ key: c.key, value: c.value });
        };
      },
    );
    const root = new Uint32Array(value.roots[0]);
    const leaf =
      Array.from({ length: root.length / 8 }, (_, i) => i).find((i) => root[i * 8 + 7] & 8) ?? 0;
    if (variant === 'empty-leaves')
      for (let n = 0; n < root.length / 8; n++) if (root[n * 8 + 7] & 8) root[n * 8 + 7] &= 255;
    if (variant === 'duplicate-triangle') value.indirect[0] = value.indirect[1];
    if (variant === 'overlap') root[leaf * 8 + 7] += 256;
    if (variant === 'mask') root[leaf * 8 + 7] &= ~3;
    if (variant === 'escape') {
      root[7] = 3;
      root[6] = 0;
    }
    if (variant === 'bounds') new Float32Array(value.roots[0])[0] += 1;
    // Structural cases must fail even with a freshly recomputed checksum. Bounds
    // remain finite/ordered and are protected by the stored cryptographic digest.
    if (variant !== 'bounds') value.digest = await accelerationDigest(value);
    if (variant === 'digest') value.digest = '0'.repeat(64);
    await new Promise<void>((resolve) => {
      const tx = db.transaction('acceleration', 'readwrite');
      tx.objectStore('acceleration').put(value, key);
      tx.oncomplete = () => resolve();
    });
    db.close();
    const repaired = await createNativeScan(map, wasm);
    expect(repaired.shared.acceleration.cached).toBe(false);
    expect(repaired.trace([-100, 0, 0], [100, 0, 0])).toEqual(expected);
    expect(expected).toEqual([75.09251727222156, 1, 1]);
    repaired.dispose();
    map.dispose();
  },
);

it('native batches yield to cancellation and keep progress monotonic', async () => {
  const map = fixture([{ center: [0, 0, -10], size: [6000, 6000, 20] }]);
  map.native = await createNativeScan(map, wasm);
  let cancel = false,
    previous = 0,
    calls = 0;
  const timer = setTimeout(() => {
    cancel = true;
  }, 0);
  const result = await scanMap(
    map,
    { ...request, settings: { spacing: 16, radius: 2048, workers: 1 } },
    (stats) => {
      expect(stats.cells).toBeGreaterThanOrEqual(previous);
      previous = stats.cells;
      calls++;
    },
    () => cancel,
  );
  clearTimeout(timer);
  expect(result.cancelled).toBe(true);
  expect(result.stats.cells).toBeLessThan(result.stats.total);
  expect(calls).toBeGreaterThan(0);
  expect(map.trace([0, 0, 100], [100, 0, 100]).status).toBeDefined();
  map.dispose();
});

it('warm placement retraces changed posed anchors and grid, and failed native initialization leaves JS usable', async () => {
  const map = makeMap();
  await expect(createNativeScan(map, new Uint8Array([0]))).rejects.toThrow();
  expect(map.native).toBeUndefined();
  const native = await createNativeScan(map, wasm);
  map.native = native;
  const pose: TargetPose = {
    origin: request.target,
    aims: [request.target, [100, 0, 90], [100, 0, 70]],
    label: 'test',
    shapes: [
      {
        kind: 'box',
        name: 'head',
        group: 1,
        min: [-8, -8, -12],
        max: [8, 8, 12],
        radius: 0,
        matrix: new Matrix4().makeTranslation(...request.target).toArray(),
      },
    ],
  };
  await scanMap(map, { ...request, pose }, noop, never);
  const changed: TargetPose = {
    ...pose,
    aims: [
      [100, 50, 80],
      [100, 50, 90],
      [100, 50, 70],
    ],
    shapes: pose.shapes.map((shape) => ({
      ...shape,
      matrix: new Matrix4().makeTranslation(100, 50, 80).toArray(),
    })),
  };
  const current = { ...request, pose: changed, settings: { ...request.settings, spacing: 32 } };
  const result = await scanMap(map, current, noop, never);
  expect(result.placementCache.misses).toBe(0);
  map.native = undefined;
  clearScanPlacementCache(map);
  expect(result.rows).toEqual((await scanMap(map, current, noop, never)).rows);
  native.dispose();
  expect(() => native.shared).toThrow('closed');
  expect(native.jobs.length).toBe(0);
  map.dispose();
});
