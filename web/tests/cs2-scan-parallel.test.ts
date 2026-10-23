import { Box3, Ray, Triangle, Vector3 } from 'three';
import { intersectRay } from 'three-mesh-bvh/src/core/utils/intersectUtils.js';
import { afterEach, expect, it, vi } from 'vitest';
import { CollisionMap } from '../cs2/collision';
import { RayBoxTester } from '../cs2/ray-box';
import { clearScanPlacementCache, type ScanRequestData, scanMap } from '../cs2/scan';
import { mergeScanParts, type SharedCollision, shareCollision } from '../cs2/scan-parallel';
import { ScanPool } from '../cs2/scan-pool';
import { triangleBoxIntersector } from '../cs2/triangle-box';
import { triangleRayIntersector } from '../cs2/triangle-ray';
import type { V3 } from '../cs2/types';
import { availableWorkers, CS2, GOLDSRC, validateScan } from '../src/games/contracts';
import { fixture } from './helpers/cs2-map';

const request: ScanRequestData = {
  target: [0, 0, 100],
  settings: { spacing: 16, radius: 128, workers: 1 },
};
const makeMap = () =>
  fixture([
    { center: [0, 0, -10], size: [1000, 1000, 20] },
    { center: [50, 0, 65], size: [70, 200, 10] },
    { center: [0, 100, 80], size: [1, 400, 160], rotationY: 0.2 },
  ]);
afterEach(() => vi.unstubAllGlobals());

it('offers actual isolated worker counts and bounds the fallback to one worker', () => {
  expect(availableWorkers(CS2, true)).toEqual([1, 2, 4]);
  expect(availableWorkers(CS2, false)).toEqual([1]);
  expect(availableWorkers(GOLDSRC, false)).toEqual(GOLDSRC.workers);
  expect(() => validateScan({ ...request.settings, workers: 8 }, CS2)).toThrow('workers');
});

it('shared snapshots preserve backing stores, offsets, uint16 indirect indices and full traces', () => {
  const original = makeMap();
  const shared = shareCollision(original);
  const copy = structuredClone(shared);
  expect(copy.data.positions.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect(copy.cache.roots[0]).toBeInstanceOf(SharedArrayBuffer);
  expect(copy.cache.indirectBuffer?.constructor).toBe(shared.cache.indirectBuffer?.constructor);
  const restored = new CollisionMap(copy.data, copy.metadata, copy.cache);
  expect(() => new CollisionMap(copy.data, copy.metadata, { ...copy.cache, version: 99 })).toThrow(
    'version/layout',
  );
  for (const source of [
    [0, 0, 100],
    [300, 50, 100],
    [0, 100, 80],
  ] as V3[]) {
    const stable = (map: CollisionMap) => {
      const { ms: _, ...shot } = map.trace(source, [100, 300, 20]);
      return shot;
    };
    expect(stable(restored)).toEqual(stable(original));
  }
  expect(shared.bytes).toBeLessThan(100000);
  original.dispose();
  restored.dispose();
});

it.each([2, 4])(
  'merges %i striped partitions byte-for-byte in original order with exact counts',
  async (count) => {
    const map = makeMap();
    const serial = await scanMap(
      map,
      request,
      () => {},
      () => false,
    );
    const parts = [];
    for (let index = 0; index < count; index++) {
      clearScanPlacementCache(map);
      parts.push(
        await scanMap(
          map,
          { ...request, partition: { index, count } },
          () => {},
          () => false,
        ),
      );
    }
    const merged = mergeScanParts(parts);
    expect(new Uint8Array(merged.rows.buffer)).toEqual(new Uint8Array(serial.rows.buffer));
    expect(merged.stats).toEqual(serial.stats);
    expect(merged.rowCounts).toEqual(serial.rowCounts);
    expect(merged.placementCache.limit).toBe(65536);
    map.dispose();
  },
);

it('column broad phase preserves placement/sweep results and cleans up after exceptions', () => {
  const map = makeMap();
  for (let y = -120; y <= 120; y += 24)
    for (let x = -120; x <= 120; x += 24)
      for (const height of [54, 72])
        for (const z of [0.025, 4, 18, 60, 70.025, 100]) {
          const foot: V3 = [x, y, z];
          const expected = {
            fit: map.playerFits(foot, height, true),
            sweep: map.sweepPlayer(foot, height, [0, 0, -18]),
          };
          expect(
            map.withPlacementColumn(x, y, () => ({
              fit: map.playerFits(foot, height, true),
              sweep: map.sweepPlayer(foot, height, [0, 0, -18]),
            })),
          ).toEqual(expected);
        }
  expect(() =>
    map.withPlacementColumn(0, 0, () => {
      throw Error('abort');
    }),
  ).toThrow('abort');
  expect(map.playerFits([300, -300, 0.025], 72)).toBe(true);
  map.dispose();
});

it('warm placement never replays weapon damage and compact traces retain uncertainty/spans', async () => {
  const map = makeMap();
  const first = await scanMap(
    map,
    request,
    () => {},
    () => false,
  );
  map.metadata.weapon.damage = 20;
  const warm = await scanMap(
    map,
    request,
    () => {},
    () => false,
  );
  expect(warm.placementCache.misses).toBe(0);
  expect(warm.stats).toEqual(first.stats);
  expect(warm.rows).not.toEqual(first.rows);
  for (const source of [
    [0, 0, 100],
    [50, 0, 65],
    [-200, 50, 100],
  ] as V3[]) {
    const full = map.trace(source, [100, 100, 100]);
    const compact = map.trace(source, [100, 100, 100], 'bullet', false);
    const { contacts: _contacts, ms: _ms, ...expected } = full;
    const { contacts: _, ms: __, ...actual } = compact;
    expect(actual).toEqual(expected);
  }
  map.dispose();
});

it('SAT, reciprocal ray slabs and bounded triangle cache match upstream at edges and random rays', () => {
  const map = makeMap(),
    boxTest = new RayBoxTester();
  const intersect = triangleRayIntersector(map.data);
  let seed = 77231;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const vector = () => new Vector3(rand() * 1000 - 500, rand() * 1000 - 500, rand() * 200 - 50);
  for (let i = 0; i < 5000; i++) {
    const box = new Box3(vector(), vector());
    if (i % 5) {
      const min = box.min.clone().min(box.max);
      box.max.max(box.min);
      box.min.copy(min);
    }
    const triangle = new Triangle(vector(), vector(), vector());
    if (!(i % 7)) triangle.a.copy(box.min);
    expect(triangleBoxIntersector(box)(triangle)).toBe(box.intersectsTriangle(triangle));
    const ray = new Ray(vector(), i % 3 ? vector().normalize() : new Vector3(i % 2 ? -0 : 0, 0, 1));
    const bounds = Float32Array.from([...box.min.toArray(), ...box.max.toArray()]);
    boxTest.set(ray, 0.001, 2000);
    expect(boxTest.intersects(0, bounds)).toBe(intersectRay(0, bounds, ray, 0.001, 2000));
    const index = i % map.data.shapes.length,
      offset = index * 3;
    triangle.a.fromArray(map.data.positions, map.data.indices[offset] * 3);
    triangle.b.fromArray(map.data.positions, map.data.indices[offset + 1] * 3);
    triangle.c.fromArray(map.data.positions, map.data.indices[offset + 2] * 3);
    const point = new Vector3(),
      normal = new Vector3();
    const upstream = ray.intersectTriangle(
      triangle.a,
      triangle.b,
      triangle.c,
      false,
      new Vector3(),
    );
    expect(intersect(index, ray, point, normal)).toBe(upstream !== null);
    if (upstream) {
      expect(point).toEqual(upstream);
      expect(normal).toEqual(Triangle.getNormal(triangle.a, triangle.b, triangle.c, new Vector3()));
    }
  }
  map.dispose();
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  static errorNext = false;
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  onerror?: (event: { message: string }) => void;
  onmessageerror?: () => void;
  terminated = false;
  map?: CollisionMap;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(data: {
    op: string;
    shared: SharedCollision;
    request: ScanRequestData;
    cancel: Int32Array;
  }) {
    queueMicrotask(async () => {
      if (this.terminated) return;
      if (FakeWorker.errorNext) {
        FakeWorker.errorNext = false;
        this.onmessage?.({ data: { kind: 'error', error: 'injected worker error' } });
        return;
      }
      if (data.op === 'init') {
        const shared = structuredClone(data.shared);
        this.map = new CollisionMap(shared.data, shared.metadata, shared.cache);
        this.onmessage?.({ data: { kind: 'ready' } });
      } else {
        const result = await scanMap(
          this.map as CollisionMap,
          data.request,
          (stats) => this.onmessage?.({ data: { kind: 'progress', stats } }),
          () => Atomics.load(data.cancel, 0) !== 0,
        );
        this.onmessage?.({ data: { kind: 'result', result } });
      }
    });
  }
  terminate() {
    this.terminated = true;
    this.map?.dispose();
  }
}
it('pool uses requested workers, reuses them, cancels during startup and disposes/retries after failure', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.instances = [];
  const map = makeMap(),
    pool = new ScanPool(shareCollision(map));
  const serial = await scanMap(
    map,
    request,
    () => {},
    () => false,
  );
  let previous = 0;
  const result = await pool.scan(2, request, (stats) => {
    expect(stats.cells).toBeGreaterThanOrEqual(previous);
    previous = stats.cells;
  });
  expect(result.workersUsed).toBe(2);
  expect(result.rows).toEqual(serial.rows);
  await pool.scan(2, request, () => {});
  expect(FakeWorker.instances).toHaveLength(2);
  const cancel = pool.scan(4, request, () => {});
  pool.cancel();
  await expect(pool.scan(4, request, () => {})).rejects.toThrow('already running');
  expect((await cancel).cancelled).toBe(true);
  expect(FakeWorker.instances.slice(0, 2).every((worker) => worker.terminated)).toBe(true);
  pool.dispose();
  FakeWorker.errorNext = true;
  await expect(pool.scan(2, request, () => {})).rejects.toThrow('injected');
  expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  expect((await pool.scan(2, request, () => {})).rows).toEqual(serial.rows);
  pool.dispose();
  const post = vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementationOnce(() => {
    throw Error('injected clone failure');
  });
  await expect(pool.scan(2, request, () => {})).rejects.toThrow('clone failure');
  post.mockRestore();
  expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  map.dispose();
});
