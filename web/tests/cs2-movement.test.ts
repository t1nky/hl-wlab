import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CollisionMap } from '../cs2/collision';
import { WalkController, type WalkInput } from '../cs2/movement';
import { decodeMap, type Metadata, required } from '../cs2/types';
import { type Box, fixture } from './helpers/cs2-map';

const floor: Box = { center: [0, 0, -10], size: [2000, 2000, 20] };
const idle: WalkInput = { forward: 0, side: 0, jump: false, duck: false };

describe('Fly to Walk deployment', () => {
  it('lands on the first surface below the camera, including boxes and stacked floors', () => {
    const map = fixture([
      floor,
      { center: [100, 50, 64], size: [80, 80, 128], bullet: false },
      { center: [0, 0, 300], size: [600, 600, 10] },
    ]);
    const walker = new WalkController(map);
    const box = walker.deploy([100, 50, 270]);
    expect(box.foot).toEqual([100, 50, expect.closeTo(128.025, 3)]);
    expect(box.grounded).toBe(true);
    expect(box.crouched).toBe(false);
    expect(walker.deploy([0, 0, 270]).foot[2]).toBeCloseTo(0.025, 3);
    expect(walker.deploy([100, 50, 1200]).foot[2]).toBeCloseTo(305.025, 3);
    map.dispose();
  });
  it('uses the player hull on narrow props and crouches when standing cannot fit', () => {
    const map = fixture([
      floor,
      { center: [200, 0, 50], size: [8, 8, 100] },
      { center: [0, 0, 70], size: [100, 100, 20] },
    ]);
    const walker = new WalkController(map);
    expect(walker.deploy([200, 0, 300]).foot[2]).toBeCloseTo(100.025, 3);
    const crouch = walker.deploy([0, 0, 50]);
    expect(crouch.crouched).toBe(true);
    expect(crouch.foot[2]).toBeCloseTo(0.025, 3);
    expect(crouch.eye[2]).toBeCloseTo(46.025, 3);
    map.dispose();
  });
  it('rejects solids and empty space below the map without changing the last walk position', () => {
    const map = fixture([floor, { center: [0, 0, 100], size: [160, 160, 200] }]);
    map.metadata.spawns.push({ classname: 'info_player_terrorist', origin: [500, 0, 1] });
    const walker = new WalkController(map);
    const previous = walker.teleport([300, 0, 0.025]);
    expect(() => walker.deploy([0, 0, 64])).toThrow('Cannot deploy');
    expect(() => walker.deploy([300, 0, -100])).toThrow('Cannot deploy');
    expect(walker.state).toEqual(previous);
    map.dispose();
  });
});
function ticks(walker: WalkController, n: number, input: Partial<WalkInput> = {}, yaw = 0) {
  for (let i = 0; i < n; i++) walker.step(1 / 60, { ...idle, ...input }, yaw);
  return walker.state;
}

describe('CS2 swept exploration movement', () => {
  it('lands with feet at floor, standing eye64, gravity and jump with held-key edge detection', () => {
    const map = fixture([floor]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 100]);
    let state = ticks(walker, 90);
    expect(state.grounded).toBe(true);
    expect(state.foot[2]).toBeCloseTo(0.025, 3);
    expect(state.eye[2] - state.foot[2]).toBe(64);
    state = ticks(walker, 1, { jump: true });
    expect(state.foot[2]).toBeGreaterThan(4);
    expect(state.grounded).toBe(false);
    state = ticks(walker, 90, { jump: true });
    expect(state.grounded).toBe(true);
    expect(state.foot[2]).toBeCloseTo(0.025, 3);
    map.dispose();
  });
  it('continuous box sweep stops a 1000u displacement at a 0.05u playerclip wall', () => {
    const map = fixture([floor, { center: [80, 0, 80], size: [0.05, 2000, 160], bullet: false }]);
    const hit = map.sweepPlayer([0, 0, 0.025], 72, [1000, 0, 0]);
    expect(hit).not.toBeNull();
    expect(required(hit).fraction).toBeCloseTo((79.975 - 16) / 1000, 6);
    expect(required(hit).normal[0]).toBe(-1);
    expect(Math.abs(required(hit).normal[1]) + Math.abs(required(hit).normal[2])).toBe(0);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    const state = ticks(walker, 120, { forward: 1, side: 1 });
    expect(state.foot[0]).toBeLessThan(64);
    expect(state.foot[1]).toBeGreaterThan(200);
    map.dispose();
  });
  it('ignores non-player triangles even when bullets hit them', () => {
    const map = fixture([floor, { center: [80, 0, 80], size: [1, 200, 160], player: false }]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    expect(ticks(walker, 60, { forward: 1 }).foot[0]).toBeGreaterThan(190);
    map.dispose();
  });
  it('slides into a corner without passing either wall', () => {
    const map = fixture([
      floor,
      { center: [80, 0, 100], size: [1, 500, 200] },
      { center: [0, 80, 100], size: [500, 1, 200] },
    ]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    const state = ticks(walker, 120, { forward: 1, side: 1 });
    expect(state.foot[0]).toBeGreaterThan(62);
    expect(state.foot[0]).toBeLessThan(63.5);
    expect(state.foot[1]).toBeGreaterThan(62);
    expect(state.foot[1]).toBeLessThan(63.5);
    map.dispose();
  });
  it('climbs 16u stairs but stops at a step higher than 18u', () => {
    const map = fixture([
      floor,
      { center: [100, 0, 8], size: [80, 200, 16] },
      { center: [180, 0, 16], size: [80, 200, 32] },
      { center: [260, 0, 28], size: [80, 200, 56] },
    ]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    const state = ticks(walker, 120, { forward: 1 });
    expect(state.foot[0]).toBeGreaterThan(190);
    expect(state.foot[0]).toBeLessThan(204.1);
    expect(state.foot[2]).toBeCloseTo(32.025, 3);
    map.dispose();
  });
  it('crouches under a low ceiling and refuses to stand until clear', () => {
    const map = fixture([floor, { center: [150, 0, 80], size: [160, 200, 40] }]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    expect(ticks(walker, 60, { forward: 1 }).foot[0]).toBeLessThan(54);
    let state = ticks(walker, 60, { forward: 1, duck: true });
    expect(state.foot[0]).toBeGreaterThan(100);
    expect(state.eye[2] - state.foot[2]).toBe(46);
    state = ticks(walker, 1);
    expect(state.crouched).toBe(true);
    state = ticks(walker, 180, { forward: 1 });
    expect(state.crouched).toBe(false);
    map.dispose();
  });
  it('rejects placements wholly inside solids and falls back to map spawn', () => {
    const map = fixture([floor, { center: [0, 0, 100], size: [160, 160, 200] }]);
    const walker = new WalkController(map);
    expect(() => walker.teleport([0, 0, 20])).toThrow(/solid/);
    map.metadata.spawns.push({ classname: 'info_player_terrorist', origin: [300, 0, 1] });
    const result = walker.start([0, 0, 64]);
    expect(result.placement).toBe('info_player_terrorist');
    expect(result.state.foot[0]).toBe(300);
    map.dispose();
  });
  it('follows walkable ramps but cannot climb steep faces', () => {
    for (const degrees of [30, 70]) {
      const angle = (degrees * Math.PI) / 180;
      const height = 150 * Math.sin(angle) - 10 * Math.cos(angle);
      const map = fixture([
        floor,
        {
          center: [160, 0, height],
          size: [300, 200, 20],
          rotationY: -angle,
        },
      ]);
      const walker = new WalkController(map);
      walker.teleport([-40, 0, 0.025]);
      const state = ticks(walker, 120, { forward: 1 });
      if (degrees === 30) {
        expect(state.foot[0]).toBeGreaterThan(170);
        expect(state.foot[2]).toBeGreaterThan(60);
      } else {
        expect(state.foot[0]).toBeLessThan(110);
        expect(state.foot[2]).toBeLessThan(18.1);
      }
      map.dispose();
    }
  });
  it('stops jumping at a ceiling and rejects invalid placement/input', () => {
    const map = fixture([floor, { center: [0, 0, 100], size: [200, 200, 20] }]);
    const walker = new WalkController(map);
    walker.teleport([0, 0, 0.025]);
    let maximum = 0;
    for (let i = 0; i < 90; i++) {
      const state = walker.step(1 / 60, { ...idle, jump: true }, 0);
      maximum = Math.max(maximum, state.foot[2]);
      expect(state.foot[2] + 72).toBeLessThan(90.001);
    }
    expect(maximum).toBeGreaterThan(15);
    expect(walker.state.grounded).toBe(true);
    expect(() => walker.teleport([NaN, 0, 0])).toThrow(/finite/);
    expect(() => walker.step(NaN, idle, 0)).toThrow(/finite/);
    map.dispose();
  });
});

const local = fileURLToPath(new URL('../../.local/cs2/de_inferno/', import.meta.url));
it.skipIf(!existsSync(`${local}map.json`))(
  'private Inferno walk spawn, floor and measured ticks',
  () => {
    const meta: Metadata = JSON.parse(readFileSync(`${local}map.json`, 'utf8'));
    const bytes = readFileSync(`${local}map.cs2map`);
    const map = new CollisionMap(
      decodeMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      meta,
    );
    const walker = new WalkController(map);
    const result = walker.start([77.46, 1227.8, 156.9]);
    expect(result.state.grounded).toBe(true);
    expect(map.playerFits(result.state.foot, 72, true)).toBe(true);
    const timings: number[] = [];
    for (let i = 0; i < 240; i++) {
      const start = performance.now();
      walker.step(
        1 / 60,
        { ...idle, forward: 1, side: i > 120 ? 1 : 0 },
        i > 120 ? Math.PI / 2 : 0,
      );
      timings.push(performance.now() - start);
      expect(walker.state.foot.every(Number.isFinite)).toBe(true);
      expect(map.playerFits(walker.state.foot, 72)).toBe(true);
    }
    const sorted = timings.slice().sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        movement: 'inferno',
        start: result,
        end: walker.state,
        ticks: timings.length,
        meanMs: timings.reduce((a, b) => a + b) / timings.length,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted.at(-1),
      }),
    );
    map.dispose();
  },
  30000,
);
