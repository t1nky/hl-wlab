import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { readBSP } from '../src/engine/bsp.ts';
import { makeEngine } from '../src/engine/engine.ts';
import fixture from './fixtures/penetration.json';

const path = (p: string) => new URL(p, import.meta.url),
  read = (p: string) => readFileSync(path(p));
const available = existsSync(path('../assets/de_inferno.bsp'));
test('installed HLDS collision/material fixtures include start-solid continuation', {
  skip: !available,
}, async () => {
  const map = read('../assets/de_inferno.bsp');
  assert.equal(createHash('sha256').update(map).digest('hex'), fixture.mapSHA256);
  const bsp = readBSP(Uint8Array.from(map).buffer);
  for (const brush of fixture.brushes) Object.assign(bsp.brushes[brush.index], brush);
  const e = await makeEngine(
    bsp.buffer,
    bsp,
    read('../assets/materials.txt').toString(),
    read('../src/engine/lab.wasm'),
  );
  for (const q of fixture.rays) {
    const got = e.trace(q.start, q.end);
    for (let j = 0; j < 11; j++)
      assert.ok(
        j < 7
          ? Math.abs(got[j] - q.expected[j]) <= (j === 0 ? 0.00001 : 0.01)
          : got[j] === q.expected[j],
        `${q.texture} field ${j}: ${got[j]} vs ${q.expected[j]}`,
      );
  }
  assert.ok(fixture.rays.some((q) => q.expected[8] === 1));
  // Entirely solid world traces must never be replaced by a target beyond it.
  const solid = fixture.rays.find((q) => q.expected[8] === 1);
  assert.ok(solid);
  const a = solid.end;
  e.target(
    {
      boxes: [
        {
          group: 2,
          matrix: [1, 0, 0, a[0], 0, 1, 0, a[1], 0, 0, 1, a[2]],
          mins: [-2, -2, -2],
          maxs: [2, 2, 2],
        },
      ],
      aims: [a, a, a],
    },
    0,
  );
  assert.equal(e.fire(solid.start, a)[0], 0);
  for (const q of fixture.shots) {
    const a = q.aim;
    e.target(
      {
        boxes: [
          {
            group: 2,
            matrix: [1, 0, 0, a[0], 0, 1, 0, a[1], 0, 0, 1, a[2]],
            mins: [-0.25, -0.25, -0.25],
            maxs: [0.25, 0.25, 0.25],
          },
        ],
        aims: [a, a, a],
      },
      0,
    );
    const got = e.fire(q.eye, a);
    assert.ok(got[0] > 0, JSON.stringify(q));
    assert.equal(got[2], q.walls);
  }
});
