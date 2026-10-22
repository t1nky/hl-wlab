// ReGameDLL_CS 5.30.0.814: wpn_shared/wpn_*.cpp, weapons.h,
// CBaseEntity::FireBullets3/FireBuckshots and CBasePlayer::TakeDamage.
// Values describe a single aimed bullet/pellet, without spread or recoil.
export interface WeaponPreset {
  readonly label: string;
  readonly category: 'Sniper rifles' | 'Rifles' | 'Pistols' | 'SMGs' | 'Machine guns' | 'Shotguns';
  readonly damage: number;
  readonly maxDistance: number;
  readonly impacts: number;
  readonly power: number;
  readonly penetrationDistance: number;
  readonly rangeModifier: number;
  readonly armorRatio: number;
  readonly pellets: number;
}

// Projectile penetration power/cutoff comes from the ammunition type, not
// the weapon's firing range. One impact permits a direct hit, but no wallbang.
const ammo = {
  '338mag': { power: 45, penetrationDistance: 8000 },
  '762mm': { power: 39, penetrationDistance: 5000 },
  '556mm': { power: 35, penetrationDistance: 4000 },
  '50ae': { power: 30, penetrationDistance: 1000 },
  '57mm': { power: 30, penetrationDistance: 2000 },
  '357sig': { power: 25, penetrationDistance: 800 },
  '9mm': { power: 21, penetrationDistance: 800 },
  '45acp': { power: 15, penetrationDistance: 500 },
  buckshot: { power: 0, penetrationDistance: 0 },
} as const;

function preset(
  label: string,
  category: WeaponPreset['category'],
  bullet: keyof typeof ammo,
  damage: number,
  maxDistance: number,
  impacts: number,
  rangeModifier: number,
  armorRatio: number,
  pellets = 1,
): WeaponPreset {
  return Object.freeze({
    label,
    category,
    damage,
    maxDistance,
    impacts,
    rangeModifier,
    armorRatio,
    pellets,
    ...ammo[bullet],
  });
}

export const WEAPONS = {
  awp: preset('AWP', 'Sniper rifles', '338mag', 115, 8192, 3, 0.99, 0.975),
  scout: preset('Scout', 'Sniper rifles', '762mm', 75, 8192, 3, 0.98, 0.85),
  g3sg1: preset('G3SG1', 'Sniper rifles', '762mm', 80, 8192, 3, 0.98, 0.825),
  sg550: preset('SG 550', 'Sniper rifles', '556mm', 70, 8192, 2, 0.98, 0.725),
  ak47: preset('AK-47', 'Rifles', '762mm', 36, 8192, 2, 0.98, 0.775),
  m4a1: preset('M4A1', 'Rifles', '556mm', 32, 8192, 2, 0.97, 0.7),
  'm4a1-silenced': preset('M4A1 · silenced', 'Rifles', '556mm', 33, 8192, 2, 0.95, 0.7),
  aug: preset('AUG', 'Rifles', '556mm', 32, 8192, 2, 0.96, 0.7),
  sg552: preset('SG 552', 'Rifles', '556mm', 33, 8192, 2, 0.955, 0.7),
  galil: preset('Galil', 'Rifles', '556mm', 30, 8192, 2, 0.98, 0.775),
  famas: preset('FAMAS', 'Rifles', '556mm', 30, 8192, 2, 0.96, 0.7),
  'famas-burst': preset('FAMAS · burst bullet', 'Rifles', '556mm', 34, 8192, 2, 0.96, 0.7),
  deagle: preset('Desert Eagle', 'Pistols', '50ae', 54, 4096, 2, 0.81, 0.75),
  usp: preset('USP', 'Pistols', '45acp', 34, 4096, 1, 0.79, 0.5),
  'usp-silenced': preset('USP · silenced', 'Pistols', '45acp', 30, 4096, 1, 0.79, 0.5),
  glock18: preset('Glock 18', 'Pistols', '9mm', 25, 8192, 1, 0.75, 0.525),
  p228: preset('P228', 'Pistols', '357sig', 32, 4096, 1, 0.8, 0.625),
  fiveseven: preset('Five-SeveN', 'Pistols', '57mm', 20, 4096, 1, 0.885, 0.75),
  elite: preset('Dual Elites', 'Pistols', '9mm', 36, 8192, 1, 0.75, 0.525),
  mp5navy: preset('MP5', 'SMGs', '9mm', 26, 8192, 1, 0.84, 0.5),
  tmp: preset('TMP', 'SMGs', '9mm', 20, 8192, 1, 0.85, 0.5),
  mac10: preset('MAC-10', 'SMGs', '45acp', 29, 8192, 1, 0.82, 0.475),
  ump45: preset('UMP45', 'SMGs', '45acp', 30, 8192, 1, 0.82, 0.5),
  p90: preset('P90', 'SMGs', '57mm', 21, 8192, 1, 0.885, 0.75),
  m249: preset('M249', 'Machine guns', '556mm', 32, 8192, 2, 0.97, 0.75),
  m3: preset('M3', 'Shotguns', 'buckshot', 20, 3000, 1, 1, 0.5, 9),
  xm1014: preset('XM1014', 'Shotguns', 'buckshot', 20, 3048, 1, 1, 0.5, 6),
} as const;
export type WeaponID = keyof typeof WEAPONS;
export const DEFAULT_WEAPON: WeaponID = 'awp';

export function isWeaponID(id: unknown): id is WeaponID {
  return typeof id === 'string' && Object.hasOwn(WEAPONS, id);
}
export function getWeapon(id: string = DEFAULT_WEAPON): WeaponPreset {
  if (!isWeaponID(id)) throw Error(`Unknown weapon preset: ${id}`);
  return WEAPONS[id];
}

// Raw results can be shared by weapons with identical projectile physics.
// Armor and pellet-count metadata only change presentation, not the raw trace.
export function weaponShotKey(weapon: WeaponPreset): string {
  return JSON.stringify([
    weapon.damage,
    weapon.maxDistance,
    weapon.impacts,
    weapon.power,
    weapon.penetrationDistance,
    Math.fround(weapon.rangeModifier),
    weapon.pellets > 1,
  ]);
}
