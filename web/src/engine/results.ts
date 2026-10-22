import { damage } from './engine.ts';

export interface Filters {
  types: boolean[];
  stances: boolean[];
  minDamage: number;
}

// Scan rows: [stance, valid, x, y, z origin, eye z, then raw damage, hitgroup, walls for the chest, head and pelvis anchors].
export const ROW = 15;
export function bestShot(
  row: Float32Array,
  armor: number,
  armorPoints: number,
  armorRatio?: number,
) {
  let best = { hp: 0, group: 0, walls: 0, anchor: 0, raw: 0 };
  for (let a = 0; a < 3; a++) {
    const raw = row[6 + a * 3],
      group = row[7 + a * 3],
      dealt = damage(raw, group, armor, armorPoints, armorRatio);
    if (dealt > best.hp) best = { hp: dealt, group, walls: row[8 + a * 3], anchor: a, raw };
  }
  return best;
}
// kind = hit type (0 no hit, 1 direct, 2 wallbang) + 3 for crouching shooters; the point shader decodes the same values.
// Points sit one unit above the floor under each origin so they stay visible on the surface the shooter stands on.
export function classify(
  rows: Float32Array,
  armor: number,
  armorPoints: number,
  armorRatio?: number,
) {
  const n = rows.length / ROW,
    positions = new Float32Array(n * 3),
    hp = new Float32Array(n),
    kind = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows.subarray(i * ROW, (i + 1) * ROW),
      best = bestShot(r, armor, armorPoints, armorRatio);
    positions[i * 3] = r[2];
    positions[i * 3 + 1] = r[3];
    positions[i * 3 + 2] = r[4] - (r[0] ? 18 : 36) + 1;
    hp[i] = best.hp;
    kind[i] = (best.hp ? (best.walls ? 2 : 1) : 0) + 3 * r[0];
  }
  return { positions, hp, kind };
}
// Each chip counts what it would show under the other active filters, so switching a chip off never hides its number.
// Hits below the threshold form a separate fourth category. Misses have no damage and stay misses.
export function countVisible(
  hp: Float32Array,
  kind: Float32Array,
  { types, stances, minDamage }: Filters,
  shown = new Uint8Array(kind.length),
) {
  const typeCounts = [0, 0, 0, 0],
    stanceCounts = [0, 0];
  let visible = 0;
  for (let i = 0; i < kind.length; i++) {
    const s = kind[i] > 2 ? 1 : 0,
      t = kind[i] - 3 * s,
      bucket = t !== 0 && hp[i] < minDamage ? 3 : t;
    if (stances[s]) typeCounts[bucket]++;
    if (types[bucket]) stanceCounts[s]++;
    shown[i] = types[bucket] && stances[s] ? 1 : 0;
    visible += shown[i];
  }
  return { typeCounts, stanceCounts, visible, shown };
}
