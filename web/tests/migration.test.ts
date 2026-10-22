import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { candidates, readBSP } from '../src/engine/bsp.ts';
import { makeEngine } from '../src/engine/engine.ts';
import { readStudio } from '../src/engine/studio.ts';
import baseline from './fixtures/migration.json';

const asset = (name: string) => new URL(`../assets/${name}`, import.meta.url);
const bytes = (url: URL) => Uint8Array.from(readFileSync(url)).buffer;
const digest = (data: ArrayBuffer) =>
  createHash('sha256').update(new Uint8Array(data)).digest('hex');

// Captured from the JavaScript implementation before moving any source.
// The fixture contains only metadata/hashes; no game geometry or textures.
test('AWP retains every pre-migration full-map candidate and float32 shot result', {
  skip: !existsSync(asset('de_inferno.bsp')) || !existsSync(asset('player.mdl')),
}, async () => {
  const map = bytes(asset('de_inferno.bsp'));
  const model = bytes(asset('player.mdl'));
  const materials = bytes(asset('materials.txt'));
  const core = bytes(new URL('../src/engine/lab.wasm', import.meta.url));
  assert.equal(digest(map), baseline.mapSHA256);
  assert.equal(digest(model), baseline.modelSHA256);
  assert.equal(digest(materials), baseline.materialsSHA256);
  // The WASM now accepts weapon profiles. Keep the original binary hash as
  // provenance in the fixture; assert unchanged AWP output bytes below.
  const bsp = readBSP(map, { pixels: false });
  const studio = readStudio(model);
  const engine = await makeEngine(map, bsp, new TextDecoder().decode(materials), core);
  engine.target(
    studio.pose(baseline.sequence, baseline.target, baseline.yaw, 0, true, baseline.options),
    baseline.expansion,
  );
  const points = [...candidates(bsp, baseline.spacing, baseline.radius, baseline.target)];
  assert.equal(points.length, baseline.candidates);
  const jobs = Float32Array.from(points.flatMap((p) => [0, ...p, 0, 0, 1, ...p, 0, 0]));
  assert.equal(digest(jobs.buffer), baseline.jobsSHA256);
  const results = createHash('sha256');
  let valid = 0;
  for (let start = 0; start < baseline.postures; start += 4096) {
    const count = Math.min(4096, baseline.postures - start);
    const out = engine.sample(jobs.subarray(start * 6, (start + count) * 6), count);
    results.update(new Uint8Array(out.buffer));
    for (let i = 0; i < count; i++) if (out[i * 14]) valid++;
  }
  assert.equal(valid, baseline.valid);
  assert.equal(results.digest('hex'), baseline.resultsSHA256);
});
