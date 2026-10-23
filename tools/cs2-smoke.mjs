import { readFileSync, writeFileSync } from 'node:fs';
import { CollisionMap } from '../web/cs2/collision.ts';
import { targetDamage } from '../web/cs2/damage.ts';
import { decodeMap } from '../web/cs2/types.ts';
import { CS2 } from '../web/src/games/contracts.ts';
import { intersectTarget, playerPose } from '../web/src/games/target.ts';

const meta = JSON.parse(readFileSync('.local/cs2/de_inferno/map.json', 'utf8'));
const bytes = readFileSync('.local/cs2/de_inferno/map.cs2map');
const data = decodeMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const start = performance.now();
const map = new CollisionMap(data, meta);
const buildMs = performance.now() - start;
const shots = [
  map.trace([-1586.52, 440.79, 18], [-1520.06, 430.891, 2]),
  map.trace([-1586.52, 440.79, 18], [-1586.52, 440.79, -200]),
  map.trace([-2288.06, -145.11, 0], [-1520.06, 430.891, 2]),
];
const found = [];
for (let id = 0; id < meta.shapes.length && found.length < 3; id++) {
  const shape = meta.shapes[id];
  if (
    !shape.bullet ||
    shape.kind !== 'hull' ||
    !meta.materials[data.materials[shape.firstTriangle]].name.includes('wood')
  )
    continue;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let t = shape.firstTriangle; t < shape.firstTriangle + shape.triangleCount; t++)
    for (let k = 0; k < 3; k++) {
      const index = data.indices[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], data.positions[index + a]);
        max[a] = Math.max(max[a], data.positions[index + a]);
      }
    }
  const center = min.map((v, i) => (v + max[i]) / 2),
    sizes = min.map((v, i) => max[i] - v);
  if (center[2] > 800 || center[2] < -100) continue;
  const axis = sizes.indexOf(Math.min(...sizes));
  if (sizes[axis] > 40) continue;
  const source = [...center],
    target = [...center];
  source[axis] = min[axis] - 20;
  target[axis] = max[axis] + 20;
  const shot = map.trace(source, target);
  if (
    shot.status === 'estimated-penetration' &&
    shot.spans.length &&
    !shot.spans.some((s) => s.startInside)
  )
    found.push(shot);
}
shots.push(...found);
const durations = [];
for (let i = 0; i < 200; i++)
  durations.push(map.trace(shots[i % shots.length].source, shots[i % shots.length].target).ms);
durations.sort((a, b) => a - b);
const report = {
  prepared: meta.prepareMs,
  buildMs,
  triangles: meta.triangleCount,
  stats: meta.stats,
  traceMedianMs: durations[100],
  traceP95Ms: durations[190],
  shots,
};
// User's exact getpos/angles. Standing eye assumed; bot placement is our default
// frozen pose, not a measurement of the user's bot or its health/armor.
const player = JSON.parse(readFileSync('.local/cs2/de_inferno/player.json', 'utf8'));
if (player.steamInf !== meta.steamInf) throw Error('Prepare matching map/player versions');
const source = [267.189392, 1604.769897, 119.359955 + 64];
const pitch = (-4.0146 * Math.PI) / 180,
  yaw = (51.279736 * Math.PI) / 180;
const direction = [
  Math.cos(pitch) * Math.cos(yaw),
  Math.cos(pitch) * Math.sin(yaw),
  -Math.sin(pitch),
];
const end = source.map((n, i) => n + direction[i] * 350);
const pose = playerPose(player, CS2.target.defaults.p, 0, 0, 0);
const hit = intersectTarget(source, end, pose);
const raw = map.trace(source, hit?.point ?? end);
report.reportedShot = {
  source,
  angles: [-4.0146, 51.279736, 0],
  assumptions:
    'Standing eye+64, default frozen target pose; actual bot armor/health/position unrecorded',
  hit,
  shot: raw,
  hp:
    hit && raw.damage != null
      ? {
          unarmored: targetDamage(
            raw.damage,
            hit.group,
            { armor: 0, armorValue: 100, armorRatio: 1, aimPoint: 'head' },
            meta.weapon,
          ),
          helmet: targetDamage(
            raw.damage,
            hit.group,
            { armor: 2, armorValue: 100, armorRatio: 1, aimPoint: 'head' },
            meta.weapon,
          ),
        }
      : null,
};
writeFileSync('.local/cs2/smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
