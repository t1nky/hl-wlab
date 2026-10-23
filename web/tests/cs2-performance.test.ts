import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CollisionMap, unionSpans } from '../cs2/collision';
import { clearScanPlacementCache, scanMap } from '../cs2/scan';
import { targetIntersector } from '../cs2/target-intersection';
import { collisionRaycaster } from '../cs2/trace-ray';
import { decodeMap, type Metadata, type Span, type V3 } from '../cs2/types';
import { CS2 } from '../src/games/contracts';
import {
  intersectTarget,
  type PlayerPackage,
  playerPose,
  type TargetPose,
} from '../src/games/target';
import { fixture } from './helpers/cs2-map';

function random(seed = 93487) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function compareRays(map: CollisionMap, count: number, origin: V3, size: number) {
  const cast = collisionRaycaster(map.bvh, map.data, map.metadata);
  const rand = random();
  for (let i = 0; i < count; i++) {
    const source = new Vector3(...origin).add(
      new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(size),
    );
    // Includes axis-parallel rays and rays starting well outside map bounds.
    const direction =
      i % 5
        ? new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
        : new Vector3(0, 0, i % 2 ? -1 : 1);
    for (const kind of ['bullet', 'player'] as const) {
      const far = i % 3 ? map.far : size / 10;
      const expected = map.hits(source, direction, kind, far).map((hit) => {
        const triangle = hit.faceIndex as number;
        return {
          distance: hit.distance,
          facing: hit.face?.normal.dot(direction),
          material: map.data.materials[triangle],
          shape: map.data.shapes[triangle],
        };
      });
      expect(cast(source, direction, kind, far)).toEqual(expected);
    }
  }
}

describe('CS2 collision performance equivalence', () => {
  it('retains exact crossing order, distances, materials and normals against upstream raycast', () => {
    const map = fixture([
      { center: [0, 0, -10], size: [1000, 1000, 20] },
      { center: [70, 0, 80], size: [0.05, 1000, 160], bullet: false },
      { center: [-40, 30, 90], size: [35, 25, 70], rotationY: 0.4 },
      { center: [30, 80, 50], size: [75, 100, 100], player: false },
    ]);
    compareRays(map, 300, [0, 0, 50], 600);
    map.dispose();
  });
  it('restores slim snapshots without a cloned index and preserves exact position bounds', () => {
    const map = fixture([{ center: [0.1, 0.2, 0.3], size: [10.3, 20.4, 40.7] }]);
    const snapshot = structuredClone(map.cacheSnapshot());
    expect(snapshot.index.byteLength).toBe(0);
    const restored = new CollisionMap(map.data, map.metadata, snapshot);
    expect(restored.geometry.boundingBox).toEqual(map.geometry.boundingBox);
    const stable = (m: CollisionMap) => {
      const { ms: _ms, ...shot } = m.trace([-40, 0, 0], [40, 0, 0]);
      return shot;
    };
    expect(stable(restored)).toEqual(stable(map));
    compareRays(restored, 100, [0, 0, 0], 100);
    map.dispose();
    restored.dispose();
  });
  it('keeps interval union stable with nested spans, tied modifiers and near-coincident endpoints', () => {
    const map = fixture([{ center: [0, 0, 0], size: [10, 10, 10] }]);
    map.metadata.materials.push({ ...map.metadata.materials[0], distanceModifier: null });
    const rand = random();
    for (let trial = 0; trial < 100; trial++) {
      const spans: Span[] = Array.from({ length: 30 }, (_, i) => {
        const enter = Math.floor(rand() * 10) + (i % 4 ? 0 : 1e-7);
        return {
          enter,
          exit: enter + rand() * 20,
          material: i % 2,
          exitMaterial: i % 2,
          shape: i,
          startInside: !i,
        };
      });
      const points = [...new Set(spans.flatMap((s) => [s.enter, s.exit]))].sort((a, b) => a - b);
      const expected: Span[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i],
          b = points[i + 1];
        if (b - a < 0.01) continue;
        const winner = spans
          .filter((s) => s.enter <= a + 1e-6 && s.exit >= b - 1e-6)
          .sort(
            (x, y) =>
              (map.metadata.materials[x.material].distanceModifier ?? -1) -
              (map.metadata.materials[y.material].distanceModifier ?? -1),
          )[0];
        if (!winner) continue;
        const previous = expected.at(-1);
        if (
          previous &&
          previous.shape === winner.shape &&
          previous.material === winner.material &&
          Math.abs(previous.exit - a) < 0.01
        )
          previous.exit = b;
        else expected.push({ ...winner, enter: a, exit: b });
      }
      expect(unionSpans(spans, map.metadata)).toEqual(expected);
    }
    map.dispose();
  });
  it('reuses exact columns across grids, preserves both postures, and clears on demand', async () => {
    const map = fixture([
      { center: [0, 0, -10], size: [1000, 1000, 20] },
      { center: [50, 0, 65], size: [70, 200, 10] },
      { center: [0, 100, 80], size: [1, 400, 160], rotationY: 0.2 },
    ]);
    const sweep = vi.spyOn(map, 'sweepPlayer');
    const request = {
      target: [0, 0, 100] as V3,
      settings: { spacing: 24, radius: 120, workers: 1 },
    };
    const cold = await scanMap(
      map,
      request,
      () => {},
      () => false,
    );
    expect(cold.stats.crouching).toBeGreaterThan(cold.stats.standing);
    sweep.mockClear();
    const warm = await scanMap(
      map,
      request,
      () => {},
      () => false,
    );
    expect(warm.rows).toEqual(cold.rows);
    expect(warm.stats).toEqual(cold.stats);
    expect(sweep).not.toHaveBeenCalled();
    expect(warm.placementCache.misses).toBe(0);
    const denser = {
      ...request,
      target: [24, 0, 100] as V3,
      settings: { spacing: 12, radius: 120, workers: 1 },
    };
    const reused = await scanMap(
      map,
      denser,
      () => {},
      () => false,
    );
    expect(reused.placementCache.hits).toBeGreaterThan(0);
    clearScanPlacementCache(map);
    const uncached = await scanMap(
      map,
      denser,
      () => {},
      () => false,
    );
    expect(uncached.rows).toEqual(reused.rows);
    expect(uncached.stats).toEqual(reused.stats);
    map.dispose();
  });
  it('yields monotonic progress and supports cancellation even with no floor/origins', async () => {
    const map = fixture([{ center: [0, 0, -10], size: [10000, 10000, 20] }]);
    let stopped = false,
      previous = -1;
    const result = await scanMap(
      map,
      { target: [0, 0, 80], settings: { spacing: 12, radius: 1800, workers: 1 } },
      (stats) => {
        expect(stats.cells).toBeGreaterThanOrEqual(previous);
        previous = stats.cells;
        stopped = true;
      },
      () => stopped,
    );
    expect(result.cancelled).toBe(true);
    expect(result.stats.cells).toBeLessThan(result.stats.total);
    const noFloor = await scanMap(
      map,
      { target: [100000, 100000, 80], settings: { spacing: 24, radius: 120, workers: 1 } },
      () => {},
      () => false,
    );
    expect(noFloor.rows.length).toBe(0);
    expect(noFloor.stats.noFloor).toBeGreaterThan(0);
    map.dispose();
  });
  it('bounds placement cache growth and isolates separate map instances', async () => {
    const map = fixture([{ center: [0, 0, -10], size: [100, 100, 20] }]);
    const request = {
      target: [100000, 100000, 80] as V3,
      settings: { spacing: 12, radius: 1800, workers: 1 },
    };
    const result = await scanMap(
      map,
      request,
      () => {},
      () => false,
    );
    expect(result.placementCache.misses).toBeGreaterThan(result.placementCache.limit);
    expect(result.placementCache.entries).toBe(result.placementCache.limit);
    const other = fixture([{ center: [0, 0, 10], size: [100, 100, 20] }]);
    const fresh = await scanMap(
      other,
      { ...request, settings: { ...request.settings, radius: 64 } },
      () => {},
      () => false,
    );
    expect(fresh.placementCache.hits).toBe(0);
    map.dispose();
    other.dispose();
  });
});

function compareTarget(pose: TargetPose, count: number) {
  const intersect = targetIntersector(pose),
    rand = random();
  for (let i = 0; i < count; i++) {
    const source = pose.origin.map((n) => n + (rand() - 0.5) * 2000) as V3;
    const aim =
      i % 3 ? pose.aims[i % pose.aims.length] : (source.map((n) => n + (rand() - 0.5) * 100) as V3);
    expect(intersect(source, aim)).toEqual(intersectTarget(source, aim, pose));
  }
}
it('compiled target preserves box/capsule/sphere hits, first-hitgroups and inside/grazing rays', () => {
  const matrix = new Matrix4().makeRotationZ(0.4).setPosition(10, 20, 30).toArray();
  const pose: TargetPose = {
    origin: [10, 20, 30],
    label: 'test',
    aims: [
      [10, 20, 35],
      [10, 20, 50],
    ],
    shapes: ['box', 'capsule', 'sphere'].map((kind, i) => ({
      kind: kind as 'box' | 'capsule' | 'sphere',
      name: kind,
      group: i + 1,
      min: [-5, -5, i * 10],
      max: [5, 5, i * 10 + 10],
      radius: 7,
      matrix,
    })),
  };
  compareTarget(pose, 1000);
  const intersect = targetIntersector(pose);
  for (const source of [
    [10, 20, 30],
    [17, 20, 45],
    [0, 0, 0],
  ] as V3[])
    for (const aim of [...pose.aims, source])
      expect(intersect(source, aim)).toEqual(intersectTarget(source, aim, pose));
});

const local = fileURLToPath(new URL('../../.local/cs2/de_inferno/', import.meta.url));
it.skipIf(!existsSync(`${local}map.json`) || !existsSync(`${local}player.json`))(
  'installed Inferno randomized rays and frozen pose equivalence',
  () => {
    const metadata: Metadata = JSON.parse(readFileSync(`${local}map.json`, 'utf8'));
    const bytes = readFileSync(`${local}map.cs2map`);
    const map = new CollisionMap(
      decodeMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      metadata,
    );
    compareRays(map, 1000, CS2.target.defaults.p, 6000);
    const player: PlayerPackage = JSON.parse(readFileSync(`${local}player.json`, 'utf8'));
    for (const frame of [0, 1])
      compareTarget(playerPose(player, CS2.target.defaults.p, frame * 51, 0, frame), 1000);
    map.dispose();
  },
);
