import assert from 'node:assert/strict';
import { test } from 'vitest';
import { capturePlacement, deployWalk, findWalkStart } from '../src/engine/placement.ts';

const sequences = [
  { index: 1, name: 'idle1' },
  { index: 2, name: 'crouch_idle' },
  { index: 30, name: 'crouch_aim_rifle' },
  { index: 33, name: 'ref_aim_rifle' },
];
test('E placement preserves the body origin and exact view direction, independently of eye height', () => {
  const player = {
      p: [1428, 312, 196.03125],
      eye: [1428, 312, 213.03125],
      duck: false,
      ground: true,
    },
    yaw = -2.78,
    pitch = 0.31;
  const target = capturePlacement(player, yaw, pitch, sequences);
  assert.deepEqual(target.p, player.p);
  assert.notDeepEqual(target.p, player.eye);
  assert.equal(target.seq, 33);
  assert.equal(target.duck, false);
  const y = (target.yaw * Math.PI) / 180,
    p = (target.pitch * Math.PI) / 180,
    forward = [Math.cos(y) * Math.cos(p), Math.sin(y) * Math.cos(p), -Math.sin(p)],
    camera = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch)];
  forward.forEach((v, i) => {
    assert.ok(Math.abs(v - camera[i]) < 1e-14);
  });
  player.p[0] += 100;
  assert.equal(target.p[0], 1428, 'the stationary target must not follow the player');
});
test('crouched E placement preserves feet position and selects a crouched stationary pose', () => {
  const stand = capturePlacement(
      { p: [1.25, 2.5, 260.03125], duck: false, ground: true },
      0.4,
      0,
      sequences,
    ),
    crouch = capturePlacement(
      { p: [1.25, 2.5, 242.03125], duck: true, ground: true },
      0.4,
      0,
      sequences,
    );
  assert.equal(stand.p[2] - 36, crouch.p[2] - 18);
  assert.equal(crouch.seq, 30);
  assert.equal(crouch.options.gait, 2);
  assert.equal(crouch.duck, true);
  assert.equal(crouch.yaw, stand.yaw);
});
test('airborne placement is rejected rather than silently snapped to another location', () => {
  assert.throws(
    () => capturePlacement({ p: [0, 0, 400], ground: false, duck: false }, 0, 0, sequences),
    /Land/,
  );
});
test('player spawn selection works before any atlas has been calculated', () => {
  const engine = {
      trace(s: number[], e: number[]) {
        if (s[0] < 0) return [0, ...s, 0, 0, 1, 1, 1];
        return s[2] === e[2]
          ? [1, ...e, 0, 0, 0, 0, 0]
          : [0.1, s[0], s[1], 36.03125, 0, 0, 1, 0, 0];
      },
    },
    bsp = { entities: [{ classname: 'info_player_start', origin: '24 40 60', angle: '90' }] };
  assert.deepEqual(findWalkStart(engine, bsp, [{ p: [-40, 0, 50], yaw: 0 }]), {
    p: [24, 40, 36.03125],
    yaw: 90,
  });
});

test('deployment traces the full player hull down from the Fly eye at the same X/Y', () => {
  const calls: { start: number[]; end: number[]; hull: number }[] = [];
  const engine = {
    trace(start: number[], end: number[], hull: number) {
      calls.push({ start, end, hull });
      return start[2] === end[2]
        ? [1, ...end, 0, 0, 0, 0, 0]
        : [0.2, start[0], start[1], 164.03125, 0, 0, 1, 0, 0];
    },
  };
  assert.deepEqual(deployWalk(engine, [120, 80, 400], -512), {
    p: [120, 80, 164.03125],
    duck: false,
  });
  assert.deepEqual(calls[0], { start: [120, 80, 383], end: [120, 80, 383], hull: 1 });
  assert.deepEqual(calls[1], { start: [120, 80, 383], end: [120, 80, -640], hull: 1 });
});

test('deployment falls back to crouching and rejects invalid/steep/empty positions', () => {
  const engine = {
    trace(start: number[], end: number[], hull: number) {
      if (hull === 1) return [0, ...start, 0, 0, 0, 1, 1];
      return start[2] === end[2]
        ? [1, ...end, 0, 0, 0, 0, 0]
        : [0.2, start[0], start[1], 18.03125, 0, 0, 1, 0, 0];
    },
  };
  assert.deepEqual(deployWalk(engine, [10, 20, 40], -512), { p: [10, 20, 18.03125], duck: true });
  assert.throws(() => deployWalk(engine, [NaN, 0, 0], -512), /Invalid/);
  for (const normal of [0, 0.5])
    assert.throws(
      () =>
        deployWalk(
          {
            trace: (s, e) =>
              s[2] === e[2] ? [1, ...e, 0, 0, 0, 0, 0] : [0.5, ...e, 0, 0, normal, 0, 0],
          },
          [0, 0, 100],
          -512,
        ),
      /Cannot deploy/,
    );
  assert.throws(
    () => deployWalk({ trace: (_s, e) => [1, ...e, 0, 0, 0, 0, 0] }, [0, 0, 100], -512),
    /Cannot deploy/,
  );
});
