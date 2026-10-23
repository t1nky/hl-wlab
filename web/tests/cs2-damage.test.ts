import { describe, expect, it } from 'vitest';
import { estimate, unionSpans } from '../cs2/collision';
import { penetrationLoss, penetrationParameters, targetDamage } from '../cs2/damage';
import { CS2_ROW, classifyCs2, cs2Sample } from '../cs2/scan';
import type { Span, Surface } from '../cs2/types';
import { countVisible } from '../src/engine/results';
import { required } from '../src/engine/types';
import type { DamageView } from '../src/games/contracts';
import type { TargetPose } from '../src/games/target';
import { fixture } from './helpers/cs2-map';

const weapon = { armorRatio: 1.95, headshotMultiplier: 4 };
const view: DamageView = { armor: 0, armorValue: 100, armorRatio: 0.01, aimPoint: 'head' }; // GoldSrc ratio must not leak into CS2.
const plaster: Surface = {
  name: 'plaster',
  hash: 0,
  distanceModifier: 0.7,
  damageModifier: 0.6,
  gameMaterial: null,
};
const pose: TargetPose = {
  shapes: [],
  origin: [0, 0, 0],
  label: 'synthetic',
  aims: [
    [1, 0, 0],
    [1, 0, 1],
    [1, 0, -1],
  ],
};
const span = (enter: number, exit: number): Span => ({
  enter,
  exit,
  material: 0,
  exitMaterial: 0,
  shape: 0,
  startInside: false,
});

describe('CS2 energy and target HP are separate stages', () => {
  it('matches the user overlay wall loss without fitting AWP base damage', () => {
    const p = required(penetrationParameters(plaster, plaster));
    const loss = penetrationLoss(115, 47.8 / 2.54, 2.5, p);
    expect(loss.total).toBeCloseTo(45.9, 1);
    expect(115 - loss.total).toBeCloseTo(69.1, 1);
    // Independent earlier user overlay: 48.9cm plaster, displayed loss46.7 at damage114.
    expect(penetrationLoss(114, 48.9 / 2.54, 2.5, p).total).toBeCloseTo(46.7, 1);
    // Next plaster impact in the new overlay: zero displayed thickness, incoming49, loss14.2.
    expect(penetrationLoss(49, 0, 2.5, p).total).toBeGreaterThan(14.2);
    expect(penetrationLoss(49, 0, 2.5, p).total).toBeLessThan(14.3);
  });
  it('uses actual hitgroup, helmet coverage, armor ratio/2 and final flooring', () => {
    expect(targetDamage(69.091, 1, view, weapon)).toBe(276);
    expect(targetDamage(69.091, 1, { ...view, armor: 1 }, weapon)).toBe(276);
    expect(targetDamage(69.091, 1, { ...view, armor: 2 }, weapon)).toBe(269);
    expect(targetDamage(69.091, 2, { ...view, armor: 2 }, weapon)).toBe(67);
    expect(targetDamage(69.091, 3, view, weapon)).toBe(86);
    expect(targetDamage(69.091, 6, { ...view, armor: 2 }, weapon)).toBe(51);
    expect(targetDamage(69.091, 1, { ...view, armor: 2, armorValue: 1 }, weapon)).toBe(274);
    expect(targetDamage(-1, 1, view, weapon)).toBe(0);
    expect(targetDamage(0.99, 2, view, weapon)).toBe(0);
  });
  it('chooses best HP after hitgroup/armor and preserves wallbangs at a 100HP filter', () => {
    // Stronger chest residual(90) loses to head residual(69); the selected shape can also be an arm.
    const rows = Float32Array.from([0, 0, 0, 0, 64, 90, 1, 1, 2, 69.091, 1, 1, 1, 80, 1, 1, 3]);
    expect(rows.length).toBe(CS2_ROW);
    expect(cs2Sample(rows, 0, pose, { ...view, aimPoint: 'best' }, weapon).anchor).toBe(1);
    const c = classifyCs2(rows, pose, view, weapon);
    expect(c.hp[0]).toBe(276);
    expect(c.kind[0]).toBe(2);
    expect(
      countVisible(c.hp, c.kind, {
        types: [false, true, true, false],
        stances: [true, false],
        minDamage: 100,
      }).visible,
    ).toBe(1);
    rows[12] = 4; // head aim hit the arm in front instead
    expect(cs2Sample(rows, 0, pose, view, weapon).hp).toBe(69);
    rows[9] = -1;
    rows[10] = 3;
    expect(classifyCs2(rows, pose, view, weapon).hp[0]).toBe(0);
  });
  it('keeps Source units, averages surfaces, and does not require unused legacy retention fields', () => {
    expect(
      required(penetrationParameters(plaster, { ...plaster, distanceModifier: 0.5 })).modifier,
    ).toBe(0.6);
    expect(
      required(
        penetrationParameters(
          { ...plaster, name: 'wood_plank' },
          { ...plaster, name: 'wood_dense' },
        ),
      ).modifier,
    ).toBe(3);
    expect(
      required(penetrationParameters({ ...plaster, name: 'glass', damageModifier: null }, plaster))
        .fraction,
    ).toBe(0.05);
    expect(
      required(
        penetrationParameters(
          { ...plaster, name: 'plastic', damageModifier: null },
          { ...plaster, name: 'plastic_milkcrate' },
        ),
      ).modifier,
    ).toBe(2);
    expect(penetrationParameters({ ...plaster, distanceModifier: null }, plaster)).toBeNull();
  });
  it('charges one quadratic loss for a connected union and distinct impacts across air gaps', () => {
    const map = fixture([{ center: [0, 0, -10], size: [500, 500, 20] }]);
    const meta = map.metadata;
    meta.materials[0] = plaster;
    const united = unionSpans([span(10, 20), span(15, 25)], meta);
    expect(estimate(united, 100, meta, []).damage).toBeCloseTo(
      required(estimate([span(10, 25)], 100, meta, []).damage),
      6,
    );
    expect(required(estimate([span(10, 15), span(20, 25)], 100, meta, []).damage)).toBeLessThan(
      required(estimate([span(10, 20)], 100, meta, []).damage),
    );
    expect(
      estimate(
        [span(10, 15), span(20, 25), span(30, 35), span(40, 45), span(50, 55)],
        100,
        meta,
        [],
      ).status,
    ).toBe('blocked');
    expect(estimate([{ ...span(0, 10), startInside: true }], 100, meta, []).damage).toBeNull();
    map.dispose();
  });
  it('applies flight falloff incrementally once rather than charging distance repeatedly', () => {
    const map = fixture([{ center: [0, 0, -10], size: [500, 500, 20] }]);
    const meta = map.metadata;
    meta.materials[0] = plaster;
    const shot = estimate([span(500, 510)], 1000, meta, []);
    const incoming = 115 * 0.99;
    const expected =
      (incoming -
        penetrationLoss(incoming, 10, 2.5, required(penetrationParameters(plaster, plaster)))
          .total) *
      0.99;
    expect(shot.damage).toBeCloseTo(expected, 8);
    expect(shot.losses?.[0].before).toBeCloseTo(incoming);
    meta.weapon.penetration = 0;
    expect(estimate([span(10, 20)], 100, meta, []).status).toBe('blocked');
    map.dispose();
  });
});
