import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bestShot, classify, countVisible, ROW } from '../src/engine/results.ts';

const row = (stance: number, anchors: number[][]) => {
  const r = new Float32Array(ROW);
  r.set([stance, 1, 10, 20, stance ? 178 : 196, stance ? 190 : 213]);
  anchors.forEach((a, i) => {
    r.set(a, 6 + i * 3);
  });
  return r;
};
const rows = (...list: Float32Array[]) => {
  const out = new Float32Array(list.length * ROW);
  list.forEach((r, i) => {
    out.set(r, i * ROW);
  });
  return out;
};
const none = [0, 0, 0];
test('rows are classified by hit type and shooter stance, with points on the floor below the origin', () => {
  const { positions, hp, kind } = classify(
    rows(
      row(0, [[115, 2, 0], none, none]),
      row(1, [none, [50, 1, 1], none]),
      row(0, [none, none, none]),
      row(1, [none, none, none]),
    ),
    0,
    0,
  );
  assert.deepEqual([...kind], [1, 5, 0, 3]);
  assert.deepEqual([...hp], [115, 50, 0, 0]);
  assert.deepEqual([...positions.subarray(0, 3)], [10, 20, 161]);
  assert.deepEqual([...positions.subarray(3, 6)], [10, 20, 161]);
});
test('armor can move the best shot to an unprotected anchor and turn a direct hit into a wallbang', () => {
  const r = row(0, [[100, 2, 0], none, [98, 6, 1]]);
  assert.deepEqual([bestShot(r, 0, 0).anchor, bestShot(r, 0, 0).hp], [0, 100]);
  assert.deepEqual([bestShot(r, 1, 100).anchor, bestShot(r, 1, 100).hp], [2, 98]);
  assert.deepEqual([...classify(r, 0, 0).kind, ...classify(r, 1, 100).kind], [1, 2]);
});
test('chip counts ignore their own toggle, and the damage filter reports hidden hits but never hides misses', () => {
  const hp = new Float32Array([120, 40, 90, 0, 0]),
    kind = new Float32Array([1, 2, 5, 0, 3]);
  const all = countVisible(hp, kind, {
    types: [true, true, true],
    stances: [true, true],
    minDamage: 1,
  });
  assert.deepEqual(
    [all.visible, all.weak, all.typeCounts, all.stanceCounts],
    [5, 0, [2, 1, 2], [3, 2]],
  );
  const strict = countVisible(hp, kind, {
    types: [true, true, true],
    stances: [true, true],
    minDamage: 100,
  });
  assert.deepEqual(
    [strict.visible, strict.weak, strict.typeCounts, [...strict.shown]],
    [3, 2, [2, 1, 0], [1, 0, 0, 1, 1]],
  );
  const directStandingOnly = countVisible(hp, kind, {
    types: [false, true, false],
    stances: [true, false],
    minDamage: 1,
  });
  assert.deepEqual(
    [directStandingOnly.visible, directStandingOnly.typeCounts, directStandingOnly.stanceCounts],
    [1, [1, 1, 1], [1, 0]],
  );
});
