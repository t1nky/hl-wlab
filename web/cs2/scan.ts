import { Vector3 } from 'three';
import { aimAnchor } from '../src/engine/aims';
import {
  CS2,
  type DamageView,
  type PointData,
  type ScanSettings,
  type SelectedSample,
  validateScan,
} from '../src/games/contracts';
import type { TargetPose } from '../src/games/target';
import type { CollisionMap } from './collision';
import { type DamageWeapon, targetDamage } from './damage';
import { yieldScan } from './scan-yield';
import { targetIntersector } from './target-intersection';
import type { Shot, V3 } from './types';

// [stance, feet xyz, eye z, then damage/status/walls/hitgroup for chest/head/pelvis].
export const CS2_ROW = 17;
const statuses: Shot['status'][] = ['clear', 'estimated-penetration', 'blocked', 'indeterminate'];
export interface ScanStats {
  cells: number;
  total: number;
  floors: number;
  noFloor: number;
  rejectedHull: number;
  standing: number;
  crouching: number;
}
export interface ScanRequestData {
  target: V3;
  settings: ScanSettings;
  pose?: TargetPose;
  profile?: boolean;
  /** Internal row striping; merging restores the original y/x/floor/stance order. */
  partition?: { index: number; count: number };
}

interface PlacementColumn {
  floors: number;
  rejectedHull: number;
  origins: { crouched: number; foot: V3 }[];
}
// Geometry and player collision flags are immutable for a loaded map. Keep only a bounded
// LRU of exact XY columns, independent of target pose, weapon, damage view and grid spacing.
export const SCAN_PLACEMENT_VERSION = 2;
const COLUMN_LIMIT = 65536;
const placementCaches = new WeakMap<CollisionMap, Map<string, PlacementColumn>>();
export function clearScanPlacementCache(map: CollisionMap) {
  placementCaches.delete(map);
  map.clearQueryCache();
}
function placementColumn(map: CollisionMap, x: number, y: number): PlacementColumn {
  const floors = floorCandidates(map, x, y);
  const column: PlacementColumn = { floors: floors.length, rejectedHull: 0, origins: [] };
  if (!floors.length) return column;
  const seen: number[][] = [[], []];
  return map.withPlacementColumn(x, y, () => {
    for (const z of floors)
      for (const crouched of [0, 1]) {
        const foot = placeHull(map, x, y, z, crouched ? 54 : 72);
        if (!foot) {
          column.rejectedHull++;
          continue;
        }
        if (seen[crouched].some((v) => Math.abs(v - foot[2]) < 1)) continue;
        seen[crouched].push(foot[2]);
        column.origins.push({ crouched, foot });
      }
    return column;
  });
}

export function floorCandidates(map: CollisionMap, x: number, y: number): number[] {
  const bounds = map.geometry.boundingBox;
  if (!bounds || x < bounds.min.x || x > bounds.max.x || y < bounds.min.y || y > bounds.max.y)
    return [];
  const levels: number[] = [];
  for (const hit of map.floorHits(x, y, bounds.max.z + 1).sort((a, b) => a.distance - b.distance)) {
    if (-hit.facing < 0.7 || map.metadata.shapes[hit.shape].tags.includes('sky')) continue;
    const height = hit.z as number;
    if (!levels.some((z) => Math.abs(z - height) < 0.1)) levels.push(height);
  }
  return levels;
}
/** Uses the same swept AABB as walking; sloped floors need not have four equal corner heights. */
export function placeHull(
  map: CollisionMap,
  x: number,
  y: number,
  z: number,
  height: number,
): V3 | null {
  for (const lift of [0.05, 2, 4, 8, 18]) {
    const start: V3 = [x, y, z + lift];
    if (!map.playerFits(start, height)) continue;
    const hit = map.sweepPlayer(start, height, [0, 0, -(lift + 18)]);
    if (!hit || hit.normal[2] < 0.7) return null;
    const foot: V3 = [x, y, start[2] - (lift + 18) * hit.fraction + 0.025];
    if (map.playerFits(foot, height, true)) return foot;
  }
  return null;
}
export async function scanMap(
  map: CollisionMap,
  request: ScanRequestData,
  progress: (stats: ScanStats) => void,
  cancelled: () => boolean,
) {
  validateScan(request.settings, CS2);
  const profile = {
    placementMs: 0,
    targetMs: 0,
    bulletTraceMs: 0,
    waitMs: 0,
    yields: 0,
    totalMs: 0,
    otherMs: 0,
  };
  const scanStarted = performance.now();
  const native = map.native;
  native?.setWeapon(map.metadata.weapon);
  native?.resetCounters();
  let nativeFallbacks = 0;
  const { spacing, radius } = request.settings;
  const n = Math.floor(radius / spacing);
  const stats: ScanStats = {
    cells: 0,
    total: (2 * n + 1) ** 2,
    floors: 0,
    noFloor: 0,
    rejectedHull: 0,
    standing: 0,
    crouching: 0,
  };
  let cache = placementCaches.get(map);
  if (!cache) {
    cache = new Map();
    placementCaches.set(map, cache);
  }
  const columnLimit = Math.ceil(COLUMN_LIMIT / (request.partition?.count ?? 1));
  let cacheHits = 0,
    cacheMisses = 0;
  const intersect = request.pose ? targetIntersector(request.pose) : undefined;
  let rows = new Float32Array(CS2_ROW * 4096),
    used = 0;
  const pendingOffsets = new Uint32Array(1024);
  let pendingCount = 0;
  const flush = () => {
    if (!native || !pendingCount) return;
    const before = request.profile ? performance.now() : 0;
    const results = native.traceBatch(pendingCount);
    for (let i = 0; i < pendingCount; i++) {
      const offset = pendingOffsets[i];
      let damage = results[i * 3],
        status = results[i * 3 + 1],
        walls = results[i * 3 + 2];
      if (status < 0) {
        nativeFallbacks++;
        const job = native.jobs.subarray(i * 6, i * 6 + 6);
        const shot = map.trace([job[0], job[1], job[2]], [job[3], job[4], job[5]], 'bullet', false);
        damage = shot.damage ?? -1;
        status = statuses.indexOf(shot.status);
        walls = shot.spans.length;
      }
      for (let copy = 0; copy < (request.pose ? 1 : 3); copy++) {
        rows[offset + copy * 4] = damage;
        rows[offset + copy * 4 + 1] = status;
        rows[offset + copy * 4 + 2] = walls;
      }
    }
    pendingCount = 0;
    if (request.profile) profile.bulletTraceMs += performance.now() - before;
  };
  const rowCounts = new Uint32Array(2 * n + 1);
  const partition = request.partition ?? { index: 0, count: 1 };
  if (
    !Number.isInteger(partition.count) ||
    partition.count < 1 ||
    !Number.isInteger(partition.index) ||
    partition.index < 0 ||
    partition.index >= partition.count
  )
    throw Error('Invalid scan partition');
  let yielded = performance.now();
  for (let y = -n; y <= n && !cancelled(); y++) {
    if ((y + n) % partition.count !== partition.index) continue;
    const rowStart = used;
    for (let x = -n; x <= n && !cancelled(); x++) {
      stats.cells++;
      if ((x * spacing) ** 2 + (y * spacing) ** 2 > radius ** 2) continue;
      const fx = request.target[0] + x * spacing,
        fy = request.target[1] + y * spacing;
      const key = `${fx},${fy}`;
      let column = cache.get(key);
      if (column) {
        cacheHits++;
        cache.delete(key);
      } else {
        cacheMisses++;
        const before = request.profile ? performance.now() : 0;
        column = native?.column(fx, fy);
        if (!column) {
          if (native) nativeFallbacks++;
          column = placementColumn(map, fx, fy);
        }
        if (request.profile) profile.placementMs += performance.now() - before;
      }
      cache.set(key, column);
      if (cache.size > columnLimit) cache.delete(cache.keys().next().value as string);
      if (!column.floors) stats.noFloor++;
      stats.floors += column.floors;
      stats.rejectedHull += column.rejectedHull;
      for (const { crouched, foot } of column.origins) {
        if (pendingCount > 1020) flush();
        const eye: V3 = [foot[0], foot[1], foot[2] + (crouched ? 46 : 64)];
        const anchors = request.pose?.aims ?? [request.target];
        const row = [crouched, ...foot, eye[2]];
        for (let anchor = 0; anchor < 3; anchor++) {
          if (!request.pose && anchor) {
            row.push(...row.slice(5, 9));
            continue;
          }
          const aim = anchors[anchor] ?? anchors[0];
          const beforeTarget = request.profile ? performance.now() : 0;
          const hit = intersect ? intersect(eye, aim) : null;
          if (request.profile) profile.targetMs += performance.now() - beforeTarget;
          if (request.pose && (!hit || hit.distance < 0.1)) {
            row.push(0, 2, 0, 0);
            continue;
          }
          if (new Vector3(...eye).distanceTo(new Vector3(...aim)) < 0.1) {
            row.push(0, 2, 0, 0);
            continue;
          }
          if (native) {
            native.jobs.set([...eye, ...(hit?.point ?? aim)], pendingCount * 6);
            pendingOffsets[pendingCount++] = used + 5 + anchor * 4;
            row.push(0, 2, 0, hit?.group ?? 0);
            continue;
          }
          const beforeTrace = request.profile ? performance.now() : 0;
          const shot = map.trace(eye, hit?.point ?? aim, 'bullet', false);
          if (request.profile) profile.bulletTraceMs += performance.now() - beforeTrace;
          row.push(
            shot.damage ?? -1,
            statuses.indexOf(shot.status),
            shot.spans.length,
            hit?.group ?? 0,
          );
        }
        if (used + CS2_ROW > rows.length) {
          const expanded = new Float32Array(rows.length * 2);
          expanded.set(rows);
          rows = expanded;
        }
        rows.set(row, used);
        used += CS2_ROW;
        stats[crouched ? 'crouching' : 'standing']++;
      }
      if (performance.now() - yielded > 16) {
        flush();
        progress({ ...stats });
        const beforeWait = performance.now();
        await yieldScan();
        if (request.profile) {
          profile.waitMs += performance.now() - beforeWait;
          profile.yields++;
        }
        yielded = performance.now();
      }
    }
    rowCounts[y + n] = (used - rowStart) / CS2_ROW;
  }
  flush();
  progress({ ...stats });
  profile.totalMs = performance.now() - scanStarted;
  profile.otherMs =
    profile.totalMs -
    profile.placementMs -
    profile.targetMs -
    profile.bulletTraceMs -
    profile.waitMs;
  return {
    native: native ? { counters: native.counters(), fallbacks: nativeFallbacks } : undefined,
    profile: request.profile ? profile : undefined,
    rowCounts,
    rows: rows.slice(0, used),
    stats,
    cancelled: cancelled(),
    placementCache: {
      hits: cacheHits,
      misses: cacheMisses,
      entries: cache.size,
      limit: columnLimit,
    },
  };
}
export function cs2Sample(
  rows: Float32Array,
  index: number,
  pose: TargetPose,
  view: DamageView,
  weapon: DamageWeapon,
): SelectedSample {
  const r = rows.subarray(index * CS2_ROW, (index + 1) * CS2_ROW);
  const fixed = aimAnchor(view.aimPoint);
  let anchor = fixed ?? 0;
  const hp = (a: number) => targetDamage(r[5 + a * 4], r[8 + a * 4], view, weapon);
  if (fixed == null) for (let a = 1; a < 3; a++) if (hp(a) > hp(anchor)) anchor = a;
  const offset = 5 + anchor * 4;
  return {
    crouched: !!r[0],
    origin: [r[1], r[2], r[3]],
    eye: [r[1], r[2], r[4]],
    aim: pose.aims[anchor],
    anchor,
    hp: hp(anchor),
    status: statuses[r[offset + 1]],
    walls: r[offset + 2],
    group: r[offset + 3],
  };
}
export function classifyCs2(
  rows: Float32Array,
  pose: TargetPose,
  view: DamageView,
  weapon: DamageWeapon,
): PointData {
  const count = rows.length / CS2_ROW,
    positions = new Float32Array(count * 3),
    hp = new Float32Array(count),
    kind = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = cs2Sample(rows, i, pose, view, weapon);
    positions.set([s.origin[0], s.origin[1], s.origin[2] + 1], i * 3);
    hp[i] = s.hp;
    kind[i] =
      (s.hp > 0 ? (s.status === 'clear' ? 1 : s.status === 'estimated-penetration' ? 2 : 0) : 0) +
      (s.crouched ? 3 : 0);
  }
  return { positions, hp, kind };
}
