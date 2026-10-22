import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { candidates, readBSP } from '../src/engine/bsp.ts';
import { damage, makeEngine } from '../src/engine/engine.ts';
import { Walker } from '../src/engine/movement.ts';
import { readStudio } from '../src/engine/studio.ts';

const path = (s: string) => fileURLToPath(new URL(s, import.meta.url)),
  bytes = (s: string) => Uint8Array.from(readFileSync(path(s))).buffer,
  wasm = readFileSync(path('../src/engine/lab.wasm'));
// Independent halfspace fixture: solid below z=0, with pre-expanded player
// hulls at z=36/18. No production game assets needed for these assertions.
function floorBSP() {
  const lumps = Array.from({ length: 15 }, () => Buffer.alloc(0));
  lumps[1] = Buffer.alloc(60);
  [0, 36, 18].forEach((z, j) => {
    lumps[1].writeFloatLE(1, j * 20 + 8);
    lumps[1].writeFloatLE(z, j * 20 + 12);
    lumps[1].writeInt32LE(2, j * 20 + 16);
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
  lumps[10].writeInt32LE(-2, 0);
  lumps[10].writeInt32LE(-1, 28);
  lumps[14] = Buffer.alloc(64);
  lumps[14].writeInt32LE(0, 36);
  lumps[14].writeInt32LE(0, 40);
  lumps[14].writeInt32LE(0, 44);
  lumps[14].writeInt32LE(1, 48);
  const head = Buffer.alloc(124);
  head.writeInt32LE(30);
  let off = 124;
  lumps.forEach((l, j) => {
    head.writeInt32LE(off, 4 + j * 8);
    head.writeInt32LE(l.length, 8 + j * 8);
    off += l.length;
  });
  return Uint8Array.from(Buffer.concat([head, ...lumps])).buffer;
}
test('biased GoldSrc point and player hull collision against analytic floor', async () => {
  const b = readBSP(floorBSP()),
    e = await makeEngine(b.buffer, b, '', wasm);
  for (const [h, z] of [
    [0, 0],
    [1, 36],
    [3, 18],
  ]) {
    const t = e.trace([0, 0, 100], [0, 0, -100], h);
    assert.ok(Math.abs(t[3] - z - 0.03125) < 0.00001);
    assert.equal(t[6], 1);
    assert.equal(t[7], 0);
    assert.equal(t[8], 0);
    assert.equal(e.trace([0, 0, z - 1], [0, 0, z - 2], h)[7], 1);
  }
  assert.equal(e.trace([0, 0, 200], [10, 20, 200])[0], 1);
});
test('AWP direct head/body shots use actual oriented hitbox planes', async () => {
  const b = readBSP(floorBSP()),
    e = await makeEngine(b.buffer, b, '', wasm);
  const matrix = [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 60];
  const pose = {
    boxes: [{ matrix, mins: [-2, -2, -2], maxs: [2, 2, 2], group: 1 }],
    aims: [
      [100, 0, 60],
      [100, 0, 60],
      [100, 0, 60],
    ],
  };
  e.target(pose, 0);
  assert.deepEqual(e.fire([0, 0, 60], [100, 0, 60]), [456, 1, 0]);
  assert.equal(e.fire([0, 10, 60], [100, 10, 60])[0], 0);
  assert.equal(damage(456, 1, 2, 100), 444);
  assert.equal(damage(456, 1, 1, 100), 456);
  assert.equal(damage(456, 1, 2, 0), 456);
  assert.equal(damage(456, 1, 2, 1), 454);
  assert.equal(damage(114, 2, 1, 100), 111);
  assert.equal(damage(85.5, 6, 2, 100), 85);
});
test('standing and crouching settle without falling through floor', async () => {
  const b = readBSP(floorBSP()),
    e = await makeEngine(b.buffer, b, '', wasm),
    w = new Walker(e, [0, 0, 80]);
  for (let i = 0; i < 150; i++) w.step(0.01, { forward: 0, side: 0, jump: false, duck: false }, 0);
  assert.equal(w.p[2], 36.03125);
  assert.equal(w.ground, true);
  for (let i = 0; i < 50; i++) w.step(0.01, { forward: 0, side: 0, jump: false, duck: true }, 0);
  assert.equal(w.p[2], 18.03125);
  assert.equal(w.duck, true);
  assert.equal(w.eye[2], 30.03125);
  for (let i = 0; i < 50; i++) w.step(0.01, { forward: 0, side: 1, jump: false, duck: true }, 0);
  assert.ok(w.p[1] < -10, 'D strafes to the camera right at yaw zero');
});
test('reject malformed BSP ranges and model binaries', async () => {
  assert.throws(() => readBSP(new ArrayBuffer(124)), /v30/);
  const b = floorBSP();
  new DataView(b).setInt32(4, -1, true);
  assert.throws(() => readBSP(b), /lump/);
  assert.throws(() => readStudio(new ArrayBuffer(244)), /IDST/);
});
const hasAssets =
  existsSync(path('../assets/de_inferno.bsp')) && existsSync(path('../assets/player.mdl'));
test('real Inferno assets, all embedded poses, nested grids and native/WASM traces', {
  skip: !hasAssets,
}, async () => {
  const b = readBSP(bytes('../assets/de_inferno.bsp'));
  assert.equal(b.faces.length, 9347);
  assert.equal(b.textures.filter((t) => t.rgba).length, 97);
  const m = readStudio(bytes('../assets/player.mdl'));
  for (const s of m.sequences) {
    const pose = m.pose(s.index, [0, 0, 0], 0);
    assert.ok(pose.boxes.every((b) => b.matrix.every(Number.isFinite)));
  }
  const t = [1159.721435546, 288.663604736, 260.031097412];
  const coarse = [...candidates(b, 24, 384, t)],
    fine = new Set([...candidates(b, 12, 384, t)].map((p) => p.join(',')));
  assert.ok(coarse.length > 100);
  for (const p of coarse) assert.ok(fine.has(p.join(',')));
  const e = await makeEngine(b.buffer, b, '', wasm);
  for (const brush of b.brushes.slice(1))
    e.e.set_brush(brush.index, 0, ...brush.origin, ...brush.angles);
  let seed = 0x63f852;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const queries = new Float32Array(10000 * 7);
  for (let j = 0; j < 10000; j++)
    queries.set(
      [
        -2000 + random() * 4500,
        -1800 + random() * 4000,
        -200 + random() * 1000,
        -2000 + random() * 4500,
        -1800 + random() * 4000,
        -200 + random() * 1000,
        [0, 1, 3][j % 3],
      ],
      j * 7,
    );
  const exe = ['../../tools/lab-native.exe', '../../tools/lab-native'].map(path).find(existsSync);
  if (!exe) return;
  const native = spawnSync(exe, [path('../assets/de_inferno.bsp')], {
    input: Buffer.from(queries.buffer),
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr.toString());
  assert.equal(native.stdout.length, 10000 * 11 * 4);
  let maxError = 0,
    semanticMismatches = 0;
  for (let j = 0; j < 10000; j++) {
    const q = queries.subarray(j * 7, j * 7 + 7),
      r = e.trace(Array.from(q.slice(0, 3)), Array.from(q.slice(3, 6)), q[6]);
    for (let k = 0; k < 11; k++) {
      const expected = native.stdout.readFloatLE((j * 11 + k) * 4),
        delta = Math.abs(r[k] - expected);
      maxError = Math.max(maxError, delta);
      if (k === 7 || k === 8) if (r[k] !== expected) semanticMismatches++;
      assert.ok(delta <= 0.001, `trace ${j} field ${k}: ${r[k]} vs ${expected}`);
    }
  }
  const report = {
    nativeWasmTraces: 10000,
    maxAbsoluteFieldError: maxError,
    startSolidAllSolidMismatches: semanticMismatches,
    engineParityCertified: false,
    notes: 'Native is our own C++ core, not the installed game engine.',
  };
  writeFileSync(path('../validation-core.json'), JSON.stringify(report, null, 2));
});
