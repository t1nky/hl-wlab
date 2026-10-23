import type { Engine } from './engine.ts';
import type { BSP, Player, Sequence } from './types.ts';

// The placement contract is a stationary target at the player's body origin,
// with the camera's view angles and the player's actual (not requested) stance.
export function capturePlacement(
  player: Player | undefined,
  lookYaw: number,
  lookPitch: number,
  sequences: Pick<Sequence, 'name' | 'index'>[],
) {
  if (!player?.ground) throw Error('Land on a surface before placing the target.');
  if (![...player.p, lookYaw, lookPitch].every(Number.isFinite))
    throw Error('Invalid player position or view direction.');
  const duck = !!player.duck,
    names = duck ? ['crouch_aim_rifle', 'crouch_idle'] : ['ref_aim_rifle', 'idle1'];
  const sequence = names.map((name) => sequences.find((s) => s.name === name)).find(Boolean);
  if (!sequence) throw Error('This player model has no matching stationary posture.');
  const yaw = (lookYaw * 180) / Math.PI,
    pitch = (-lookPitch * 180) / Math.PI;
  // CS stores entity pitch at -viewPitch/3. CalculatePitchBlend quantizes
  // that value before the model's nine-way stationary animation blend.
  const range = Math.trunc(-pitch),
    pitchBlend = range <= -45 ? 255 : range >= 45 ? 0 : Math.trunc(((45 - range) * 255) / 90);
  return {
    p: player.p.slice(),
    yaw,
    pitch,
    duck,
    seq: sequence.index,
    options: { yawBlend: 128, pitchBlend, gait: duck ? 2 : 1 },
  };
}
export function postureSequence(sequences: Pick<Sequence, 'name' | 'index'>[], duck: boolean) {
  return [duck ? 'crouch_aim_rifle' : 'ref_aim_rifle', duck ? 'crouch_idle' : 'idle1']
    .map((name) => sequences.find((s) => s.name === name))
    .find(Boolean);
}
export function findWalkStart(
  engine: Pick<Engine, 'trace'>,
  bsp: Pick<BSP, 'entities'>,
  preferred: { p: number[]; yaw: number }[] = [],
) {
  const fromMap = bsp.entities
    .filter((e) => ['info_player_start', 'info_player_deathmatch'].includes(e.classname))
    .map((e) => ({ p: (e.origin || '').split(/\s+/).map(Number), yaw: Number(e.angle || 0) }));
  for (const entry of [...preferred, ...fromMap]) {
    if (entry.p?.length !== 3 || !entry.p.every(Number.isFinite)) continue;
    const p = entry.p.slice(),
      fit = engine.trace(p, p, 1);
    if (fit[7] || fit[8]) continue;
    const floor = engine.trace(p, [p[0], p[1], p[2] - 8192], 1);
    if (floor[0] < 1 && !floor[7] && floor[6] >= 0.7)
      return { p: floor.slice(1, 4), yaw: entry.yaw || 0 };
  }
  throw Error(
    'No clear standing spawn found. Import a valid player spawn or choose a firing position.',
  );
}

/** Project the player hull down from the Fly eye, without moving sideways or
 * searching unrelated spawns. Hull traces include props and stacked floors. */
export function deployWalk(engine: Pick<Engine, 'trace'>, eye: number[], minimumZ: number) {
  if (eye.length !== 3 || !eye.every(Number.isFinite) || !Number.isFinite(minimumZ))
    throw Error('Invalid deployment position.');
  for (const duck of [false, true]) {
    const hull = duck ? 3 : 1;
    const origin = [eye[0], eye[1], eye[2] - (duck ? 12 : 17)];
    const fit = engine.trace(origin, origin, hull);
    if (fit[7] || fit[8]) continue;
    const end = [origin[0], origin[1], Math.min(minimumZ - 128, origin[2] - 1)];
    const floor = engine.trace(origin, end, hull);
    if (floor[0] >= 1 || floor[7] || floor[8] || floor[6] < 0.7) continue;
    const p = floor.slice(1, 4),
      landed = engine.trace(p, p, hull);
    if (!landed[7] && !landed[8]) return { p, duck };
  }
  throw Error('Cannot deploy here. Fly into clear space above a walkable surface.');
}
