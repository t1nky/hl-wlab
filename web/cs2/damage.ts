import type { DamageView } from '../src/games/contracts';
import type { Metadata, Surface } from './types';

export type DamageWeapon = Pick<Metadata['weapon'], 'armorRatio' | 'headshotMultiplier'>;

/** Enemy bullet damage, default damage-scale convars; floor only after hitgroup/armor. */
export function targetDamage(
  residual: number,
  group: number,
  view: DamageView,
  weapon: DamageWeapon,
) {
  if (residual <= 0 || !Number.isFinite(residual)) return 0;
  const multiplier =
    group === 1
      ? weapon.headshotMultiplier
      : group === 3
        ? 1.25
        : group === 6 || group === 7
          ? 0.75
          : 1;
  let hp = residual * multiplier;
  const protectedPart =
    view.armor > 0 && ([0, 2, 3, 4, 5, 8].includes(group) || (group === 1 && view.armor === 2));
  if (protectedPart && view.armorValue > 0) {
    const reduced = hp * Math.min(1, weapon.armorRatio * 0.5);
    hp = (hp - reduced) * 0.5 > view.armorValue ? hp - view.armorValue * 2 : reduced;
  }
  return Math.floor(Math.max(0, hp));
}

// Source surface names provide the family when the prepared gameMaterial is absent.
function family(surface: Surface) {
  const material = surface.gameMaterial?.toUpperCase();
  const name = surface.name.toLowerCase();
  if (material === 'Y' || material === 'G' || /^(glass|grate|metalgrate|chainlink)/.test(name))
    return 'glass';
  if (material === 'W' || material === 'U' || /^(wood|cardboard)/.test(name)) return 'wood';
  if (material === 'L' || /^plastic/.test(name)) return 'plastic';
  return name;
}

/** Open-reference quadratic model, checked against the user's plaster overlay.
 * Math pattern: ExternalAutoWallCS2 (MIT, see licenses). Unlike that reference:
 * lengths stay in Source units, impact fraction is .16, and falloff advances once.
 * Family overrides and general engine parity still require broader game comparison.
 */
export function penetrationParameters(entry: Surface, exit: Surface) {
  if (
    entry.distanceModifier == null ||
    exit.distanceModifier == null ||
    entry.distanceModifier <= 0 ||
    exit.distanceModifier <= 0
  )
    return null;
  const first = family(entry),
    last = family(exit);
  if (first === 'glass' || last === 'glass') return { modifier: 3, fraction: 0.05 };
  const modifier =
    first === last && first === 'wood'
      ? 3
      : first === last && first === 'plastic'
        ? 2
        : (entry.distanceModifier + exit.distanceModifier) * 0.5;
  return { modifier, fraction: 0.16 };
}

export function penetrationLoss(
  damage: number,
  thickness: number,
  penetration: number,
  parameters: { modifier: number; fraction: number },
) {
  const impact = damage * parameters.fraction + 11.25 / (penetration * parameters.modifier);
  const mass = (thickness * thickness) / (24 * parameters.modifier);
  return { impact, mass, total: impact + mass };
}
