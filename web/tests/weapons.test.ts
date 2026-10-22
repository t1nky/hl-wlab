import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { readBSP } from '../src/engine/bsp.ts';
import { damage, makeEngine } from '../src/engine/engine.ts';
import { bestShot } from '../src/engine/results.ts';
import {
  DEFAULT_WEAPON,
  getWeapon,
  isWeaponID,
  WEAPONS,
  weaponShotKey,
} from '../src/engine/weapons.ts';
import { slabBSP } from './helpers/slab.ts';

const wasm = readFileSync(new URL('../src/engine/lab.wasm', import.meta.url));
async function scene(thickness = 0) {
  const map = slabBSP(thickness);
  return makeEngine(map, readBSP(map), '', wasm);
}
function target(engine: Awaited<ReturnType<typeof scene>>, x: number, group = 2) {
  const aim = [x, 0, 60];
  engine.target(
    {
      boxes: [
        {
          matrix: [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 60],
          mins: [-2, -2, -2],
          maxs: [2, 2, 2],
          group,
        },
      ],
      aims: [aim, aim, aim],
    },
    0,
  );
  return aim;
}

test('AWP is the default; every firearm and ballistic mode has a complete preset', () => {
  assert.equal(DEFAULT_WEAPON, 'awp');
  assert.equal(getWeapon(), WEAPONS.awp);
  assert.equal(Object.keys(WEAPONS).length, 27); // 24 firearms + 3 modes
  assert.equal(WEAPONS.awp.maxDistance, 8192);
  assert.equal(WEAPONS.deagle.maxDistance, 4096);
  assert.equal(WEAPONS.glock18.maxDistance, 8192);
  assert.equal(WEAPONS.m3.maxDistance, 3000);
  assert.equal(WEAPONS.xm1014.maxDistance, 3048);
  for (const [id, weapon] of Object.entries(WEAPONS)) {
    assert.ok(isWeaponID(id));
    assert.ok(weapon.maxDistance >= 3000 && weapon.maxDistance <= 8192);
    assert.ok(weapon.damage > 0 && weapon.armorRatio > 0 && weapon.armorRatio <= 1);
    assert.ok(Object.values(weapon).every((v) => typeof v !== 'number' || Number.isFinite(v)));
  }
  assert.equal(isWeaponID('__proto__'), false);
  assert.throws(() => getWeapon('not-a-weapon'), /Unknown weapon/);
});

test('all presets configure the WASM and preserve their own direct damage falloff', async () => {
  const engine = await scene();
  for (const [id, weapon] of Object.entries(WEAPONS)) {
    engine.setWeapon(weapon);
    const aim = target(engine, 2000),
      raw = engine.fire([0, 0, 60], aim)[0];
    // The analytic box's leading plane is x=1998, with GoldSrc's 1/32 bias.
    const distance = Math.fround(1998 - 0.03125);
    const expected =
      weapon.pellets > 1
        ? Math.trunc(
            Math.fround(
              Math.fround(1 - Math.fround(distance / weapon.maxDistance)) * weapon.damage,
            ),
          )
        : Math.trunc(
            weapon.damage * Math.fround(weapon.rangeModifier) ** Math.fround(distance / 500),
          );
    assert.equal(raw, expected, id);
  }
});

test('weapon range is a real trace limit, independent from its penetration-distance cutoff', async () => {
  const engine = await scene(),
    eye = [0, 0, 60];
  const far = target(engine, 4500);
  engine.setWeapon(WEAPONS.deagle);
  assert.equal(engine.fire(eye, far)[0], 0);
  engine.setWeapon(WEAPONS.glock18);
  assert.ok(
    engine.fire(eye, far)[0] > 0,
    'Glock bullet range is 8192 despite its 800-unit penetration cutoff',
  );
  engine.setWeapon(WEAPONS.awp);
  assert.ok(engine.fire(eye, target(engine, 8190))[0] > 0);
  assert.equal(engine.fire(eye, target(engine, 8200))[0], 0);
});

test('wallbangs obey impact count, ammunition power and shotgun blocking', async () => {
  const engine = await scene(8),
    aim = target(engine, 200),
    eye = [0, 0, 60];
  for (const id of ['awp', 'ak47', 'deagle'] as const) {
    engine.setWeapon(WEAPONS[id]);
    const shot = engine.fire(eye, aim);
    assert.ok(shot[0] > 0, id);
    assert.equal(shot[2], 1, id);
  }
  for (const id of ['glock18', 'usp', 'mp5navy', 'p90', 'm3', 'xm1014'] as const) {
    engine.setWeapon(WEAPONS[id]);
    assert.equal(engine.fire(eye, aim)[0], 0, id);
  }
  engine.setWeapon({ ...WEAPONS.awp, power: 0 });
  assert.equal(
    engine.fire(eye, aim)[0],
    0,
    'a zero-power projectile cannot advance through the surface',
  );
  engine.setWeapon({ ...WEAPONS.awp, penetrationDistance: 32 });
  assert.equal(
    engine.fire(eye, aim)[0],
    0,
    'the first surface is beyond the configured penetration cutoff',
  );
});

test('shotgun hits use linear per-pellet damage, without summing a shell or applying rifle falloff', async () => {
  const engine = await scene();
  engine.setWeapon(WEAPONS.m3);
  assert.equal(engine.fire([0, 0, 60], target(engine, 100))[0], 19);
  assert.equal(engine.fire([0, 0, 60], target(engine, 2500))[0], 3);
  assert.equal(engine.fire([0, 0, 60], target(engine, 2500, 1))[0], 12);
});

test('armor uses the selected weapon, including weak armor and anchor selection', () => {
  assert.equal(damage(100, 2, 2, 100, WEAPONS.awp.armorRatio), 97);
  assert.equal(damage(100, 2, 2, 100, WEAPONS.ak47.armorRatio), 77);
  assert.equal(damage(100, 2, 2, 100, WEAPONS.mp5navy.armorRatio), 50);
  assert.equal(damage(100, 2, 2, 1, WEAPONS.mp5navy.armorRatio), 98);
  assert.equal(damage(100, 1, 1, 100, WEAPONS.mp5navy.armorRatio), 100, 'vest does not cover head');
  assert.equal(damage(100, 6, 2, 100, WEAPONS.mp5navy.armorRatio), 100, 'legs remain unarmored');
  const row = Float32Array.from([0, 1, 0, 0, 36, 53, 31, 2, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(bestShot(row, 2, 100, WEAPONS.m4a1.armorRatio).hp, 21);
  assert.equal(bestShot(row, 2, 100, WEAPONS.m249.armorRatio).hp, 23);
});

test('raw cache identity separates projectile physics and reuses armor-only differences', () => {
  assert.notEqual(weaponShotKey(WEAPONS.awp), weaponShotKey(WEAPONS.ak47));
  assert.notEqual(weaponShotKey(WEAPONS.m4a1), weaponShotKey(WEAPONS['m4a1-silenced']));
  assert.equal(weaponShotKey(WEAPONS.m4a1), weaponShotKey(WEAPONS.m249));
  assert.notEqual(WEAPONS.m4a1.armorRatio, WEAPONS.m249.armorRatio);
});
