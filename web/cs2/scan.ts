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
import { intersectTarget, type TargetPose } from '../src/games/target';
import type { CollisionMap } from './collision';
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
}

export function floorCandidates(map: CollisionMap, x: number, y: number): number[] {
  const bounds = map.geometry.boundingBox;
  if (!bounds || x < bounds.min.x || x > bounds.max.x || y < bounds.min.y || y > bounds.max.y)
    return [];
  const levels: number[] = [];
  for (const hit of map
    .hits(new Vector3(x, y, bounds.max.z + 1), new Vector3(0, 0, -1), 'player')
    .sort((a, b) => a.distance - b.distance)) {
    if (
      !hit.face ||
      hit.face.normal.z < 0.7 ||
      hit.faceIndex == null ||
      map.metadata.shapes[map.data.shapes[hit.faceIndex]].tags.includes('sky')
    )
      continue;
    if (!levels.some((z) => Math.abs(z - hit.point.z) < 0.1)) levels.push(hit.point.z);
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
  const values: number[] = [];
  let yielded = performance.now();
  for (let y = -n; y <= n && !cancelled(); y++)
    for (let x = -n; x <= n && !cancelled(); x++) {
      stats.cells++;
      if ((x * spacing) ** 2 + (y * spacing) ** 2 > radius ** 2) continue;
      const fx = request.target[0] + x * spacing,
        fy = request.target[1] + y * spacing;
      const floors = floorCandidates(map, fx, fy);
      if (!floors.length) stats.noFloor++;
      stats.floors += floors.length;
      const seen: number[][] = [[], []];
      for (const z of floors)
        for (const crouched of [0, 1]) {
          const foot = placeHull(map, fx, fy, z, crouched ? 54 : 72);
          if (!foot) {
            stats.rejectedHull++;
            continue;
          }
          if (seen[crouched].some((v) => Math.abs(v - foot[2]) < 1)) continue;
          seen[crouched].push(foot[2]);
          const eye: V3 = [foot[0], foot[1], foot[2] + (crouched ? 46 : 64)];
          const anchors = request.pose?.aims ?? [request.target];
          const row = [crouched, ...foot, eye[2]];
          for (let anchor = 0; anchor < 3; anchor++) {
            if (!request.pose && anchor) {
              row.push(...row.slice(5, 9));
              continue;
            }
            const aim = anchors[anchor] ?? anchors[0];
            const hit = request.pose ? intersectTarget(eye, aim, request.pose) : null;
            if (request.pose && (!hit || hit.distance < 0.1)) {
              row.push(0, 2, 0, 0);
              continue;
            }
            if (new Vector3(...eye).distanceTo(new Vector3(...aim)) < 0.1) {
              row.push(0, 2, 0, 0);
              continue;
            }
            const shot = map.trace(eye, hit?.point ?? aim);
            row.push(
              shot.damage ?? -1,
              statuses.indexOf(shot.status),
              shot.spans.length,
              hit?.group ?? 0,
            );
          }
          values.push(...row);
          stats[crouched ? 'crouching' : 'standing']++;
        }
      if (performance.now() - yielded > 16) {
        progress({ ...stats });
        await new Promise((r) => setTimeout(r, 0));
        yielded = performance.now();
      }
    }
  progress({ ...stats });
  return { rows: Float32Array.from(values), stats, cancelled: cancelled() };
}
export function cs2Sample(
  rows: Float32Array,
  index: number,
  pose: TargetPose,
  view: DamageView,
): SelectedSample {
  const r = rows.subarray(index * CS2_ROW, (index + 1) * CS2_ROW);
  const fixed = aimAnchor(view.aimPoint);
  let anchor = fixed ?? 0;
  if (fixed == null) for (let a = 1; a < 3; a++) if (r[5 + a * 4] > r[5 + anchor * 4]) anchor = a;
  const offset = 5 + anchor * 4;
  return {
    crouched: !!r[0],
    origin: [r[1], r[2], r[3]],
    eye: [r[1], r[2], r[4]],
    aim: pose.aims[anchor],
    anchor,
    hp: Math.max(0, r[offset]),
    status: statuses[r[offset + 1]],
    walls: r[offset + 2],
    group: r[offset + 3],
  };
}
export function classifyCs2(rows: Float32Array, pose: TargetPose, view: DamageView): PointData {
  const count = rows.length / CS2_ROW,
    positions = new Float32Array(count * 3),
    hp = new Float32Array(count),
    kind = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = cs2Sample(rows, i, pose, view);
    positions.set([s.origin[0], s.origin[1], s.origin[2] + 1], i * 3);
    hp[i] = s.hp;
    kind[i] =
      (s.status === 'clear' ? 1 : s.status === 'estimated-penetration' ? 2 : 0) +
      (s.crouched ? 3 : 0);
  }
  return { positions, hp, kind };
}
