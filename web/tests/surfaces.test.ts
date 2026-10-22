import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { candidates, readBSP } from '../src/engine/bsp.ts';
import { makeEngine } from '../src/engine/engine.ts';
import fixture from './fixtures/ramp-placement.json';

const wasm = readFileSync(new URL('../src/engine/lab.wasm', import.meta.url));
// Independent analytic ramp: render plane z=ax+by, with compiled player
// hulls translated by their standing/crouching Z extents. No game geometry.
function rampBSP(a: number, b: number) {
  const scale = Math.hypot(a, b, 1),
    normal = [-a / scale, -b / scale, 1 / scale].map(Math.fround);
  const lumps = Array.from({ length: 15 }, () => Buffer.alloc(0));
  lumps[1] = Buffer.alloc(60);
  [0, 36, 18].forEach((z, j) => {
    normal.forEach((n, k) => {
      lumps[1].writeFloatLE(n, j * 20 + k * 4);
    });
    lumps[1].writeFloatLE(z * normal[2], j * 20 + 12);
    lumps[1].writeInt32LE(3, j * 20 + 16);
  });
  lumps[2] = Buffer.alloc(4);
  lumps[5] = Buffer.alloc(24);
  lumps[5].writeInt16LE(-2, 4);
  lumps[5].writeInt16LE(-1, 6);
  lumps[9] = Buffer.alloc(16);
  for (let j = 0; j < 2; j++) {
    lumps[9].writeInt32LE(j + 1, j * 8);
    lumps[9].writeInt16LE(-1, j * 8 + 4);
    lumps[9].writeInt16LE(-2, j * 8 + 6);
  }
  lumps[10] = Buffer.alloc(56);
  lumps[10].writeInt32LE(-2);
  lumps[10].writeInt32LE(-1, 28);
  lumps[14] = Buffer.alloc(64);
  lumps[14].writeInt32LE(1, 48);
  const header = Buffer.alloc(124);
  header.writeInt32LE(30);
  let offset = 124;
  lumps.forEach((l, j) => {
    header.writeInt32LE(offset, 4 + j * 8);
    header.writeInt32LE(l.length, 8 + j * 8);
    offset += l.length;
  });
  const bsp = readBSP(Uint8Array.from(Buffer.concat([header, ...lumps])).buffer);
  bsp.faces = [
    {
      index: 0,
      uv: [],
      brush: 0,
      texture: 0,
      normal,
      points: [
        [-96, -96],
        [96, -96],
        [96, 96],
        [-96, 96],
      ].map(([x, y]) => [x, y, a * x + b * y]),
    },
  ];
  return bsp;
}

test('scan candidates settle on axial and diagonal ramps instead of stopping above the compiled floor', async () => {
  for (const [a, b] of [
    [0, 0],
    [0.3, 0],
    [-0.3, 0],
    [0, 0.6],
    [0, -0.6],
    [0.3, 0.4],
    [-0.4, 0.3],
    [0.99, 0],
  ]) {
    const bsp = rampBSP(a, b),
      engine = await makeEngine(bsp.buffer, bsp, '', wasm),
      points = [...candidates(bsp, 24, 256, [0, 0, 0])].filter(
        (p) => Math.abs(p[2] - (a * p[0] + b * p[1])) < 0.0001,
      );
    assert.ok(points.length > 40);
    const jobs = Float32Array.from(points.flatMap((p) => [0, ...p, 0, 0, 1, ...p, 0, 0])),
      result = engine.sample(jobs, points.length * 2);
    for (let i = 0; i < points.length; i++)
      for (let stance = 0; stance < 2; stance++) {
        const p = points[i],
          at = (i * 2 + stance) * 14;
        assert.ok(
          Math.abs(p[2] - (a * p[0] + b * p[1])) < 0.0001,
          'candidate must remain on the authored surface',
        );
        assert.equal(result[at], 1, `ramp ${a},${b}; posture ${stance}; ${p}`);
        const expected = p[2] + (stance ? 18 : 36) + 0.03125 / bsp.faces[0].normal[2];
        assert.ok(
          Math.abs(result[at + 3] - expected) < 0.0001,
          'compiled hull, not a geometric width estimate, determines final height',
        );
      }
  }
});

const mapURL = new URL('../assets/de_inferno.bsp', import.meta.url);
test('live HLDS ramp placements match the browser and recovered wallbang vectors remain reachable', {
  skip: !existsSync(mapURL),
}, async () => {
  const map = readFileSync(mapURL);
  assert.equal(createHash('sha256').update(map).digest('hex'), fixture.mapSHA256);
  const bsp = readBSP(Uint8Array.from(map).buffer),
    engine = await makeEngine(
      bsp.buffer,
      bsp,
      readFileSync(new URL('../assets/materials.txt', import.meta.url), 'utf8'),
      wasm,
    );
  const seeds = [...candidates(bsp, 12, 8192, fixture.target)];
  for (const q of fixture.placements) {
    if (q.corrected)
      assert.ok(
        seeds.some(
          (p) => p[0] === q.floor[0] && p[1] === q.floor[1] && Math.abs(p[2] - q.floor[2]) < 0.0001,
        ),
        'fixed scan must generate the independently validated floor seed',
      );
    const result = engine.sample(Float32Array.from([q.stance, ...q.floor, 0, 0]), 1);
    assert.equal(result[0], q.valid);
    if (q.valid)
      q.origin.forEach((v, j) => {
        assert.ok(Math.abs(result[j + 1] - v) < 0.001);
      });
    if (q.hp > 0) {
      // Same recorded native aim, small chest marker: isolates penetration
      // from the editor's deliberately different animation/hitbox pose.
      const aim = q.aim;
      engine.target(
        {
          boxes: [
            {
              group: 2,
              matrix: [1, 0, 0, aim[0], 0, 1, 0, aim[1], 0, 0, 1, aim[2]],
              mins: [-0.25, -0.25, -0.25],
              maxs: [0.25, 0.25, 0.25],
            },
          ],
          aims: [aim, aim, aim],
        },
        0,
      );
      const shot = engine.fire([q.origin[0], q.origin[1], q.eyeZ], aim);
      assert.ok(shot[0] > 0);
      assert.equal(shot[2], q.walls);
    }
  }
});
