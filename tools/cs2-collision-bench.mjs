// Private assets stay in .local. Run: bun tools/cs2-collision-bench.mjs [label] [reference-label]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MeshBVH } from 'three-mesh-bvh';
import { decodeMap } from '../web/cs2/types.ts';
import { CS2 } from '../web/src/games/contracts.ts';
import { playerPose } from '../web/src/games/target.ts';

const root = '.local/perf-visual-20261022/collision';
mkdirSync(root, { recursive: true });
const label = process.argv[2] ?? 'current';
if (!/^[\w-]+$/.test(label)) throw Error('Use a simple output label');
const reference = process.argv[3];
const baseline = process.env.CS2_BENCH_BASELINE === '1';
if (baseline) {
  // Reconstruct only the two reference modules in ignored output, never mutate the checkout.
  for (const file of ['collision', 'scan']) {
    const source = execFileSync('git', ['show', `334ac4b:web/cs2/${file}.ts`], { encoding: 'utf8' })
      .replaceAll("'./damage'", "'../../../web/cs2/damage'")
      .replaceAll("'./types'", "'../../../web/cs2/types'")
      .replaceAll("'../src/", "'../../../web/src/")
      .replaceAll("'./collision'", "'./reference-collision'");
    writeFileSync(`${root}/reference-${file}.ts`, source);
  }
}
const { CollisionMap } = await import(
  baseline
    ? pathToFileURL(resolve(`${root}/reference-collision.ts`)).href
    : '../web/cs2/collision.ts'
);
const { CS2_ROW, cs2Sample, scanMap, clearScanPlacementCache } = await import(
  baseline ? pathToFileURL(resolve(`${root}/reference-scan.ts`)).href : '../web/cs2/scan.ts'
);
const memory = () => ({
  ...process.memoryUsage(),
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const folder = '.local/cs2/de_inferno/';
const meta = JSON.parse(readFileSync(`${folder}map.json`, 'utf8'));
const player = JSON.parse(readFileSync(`${folder}player.json`, 'utf8'));
if (meta.steamInf !== player.steamInf) throw Error('Prepare matching map/player versions');
const before = memory();
const loadStart = performance.now();
const bytes = readFileSync(`${folder}map.cs2map`);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const data = decodeMap(buffer);
const loadMs = performance.now() - loadStart;
const buildStart = performance.now();
const map = new CollisionMap(data, meta);
const buildMs = performance.now() - buildStart;
const serialized = map.cacheSnapshot?.() ?? MeshBVH.serialize(map.bvh, { cloneBuffers: false });
const restoreStart = performance.now();
const restored = new CollisionMap(data, meta, serialized);
const restoreMs = performance.now() - restoreStart;
restored.dispose();
const pose = playerPose(player, CS2.target.defaults.p, 0, 0, 0);
const view = { armor: 2, armorValue: 100, armorRatio: 1, aimPoint: 'head' };
const reports = [];
const shots = [];
const trace = map.trace.bind(map);
let traced = 0,
  traceMs = 0,
  sweepMs = 0,
  sweeps = 0,
  fitsMs = 0,
  fits = 0;
map.trace = (...args) => {
  const start = performance.now();
  const shot = trace(...args);
  traceMs += performance.now() - start;
  traced++;
  if (shots.length < 32 && shot.status === 'estimated-penetration') {
    const { ms: _ms, ...stable } = shot;
    shots.push(stable);
  }
  return shot;
};
for (const [name, fn] of [
  [
    'sweepPlayer',
    (ms) => {
      sweepMs += ms;
      sweeps++;
    },
  ],
  [
    'playerFits',
    (ms) => {
      fitsMs += ms;
      fits++;
    },
  ],
]) {
  const original = map[name].bind(map);
  map[name] = (...args) => {
    const start = performance.now();
    const result = original(...args);
    fn(performance.now() - start);
    return result;
  };
}
for (const [name, settings] of [
  ['default-cold', CS2.scan.defaults],
  ['default-warm', CS2.scan.defaults],
  ['dense-cold', { spacing: 16, radius: 1024, workers: 1 }],
  ['dense-warm', { spacing: 16, radius: 1024, workers: 1 }],
]) {
  if (name.endsWith('-cold')) clearScanPlacementCache?.(map);
  traced = 0;
  traceMs = 0;
  sweepMs = 0;
  sweeps = 0;
  fitsMs = 0;
  fits = 0;
  const started = performance.now();
  let maxProgressGapMs = 0,
    lastProgress = started,
    lastCells = -1;
  const result = await scanMap(
    map,
    { target: pose.origin, pose, settings },
    (stats) => {
      if (stats.cells < lastCells) throw Error('Progress regressed');
      lastCells = stats.cells;
      const now = performance.now();
      maxProgressGapMs = Math.max(maxProgressGapMs, now - lastProgress);
      lastProgress = now;
    },
    () => false,
  );
  const ms = performance.now() - started;
  const rowBytes = new Uint8Array(result.rows.buffer);
  const output = `${root}/${label}-${name}.f32`;
  writeFileSync(output, rowBytes);
  if (reference && !Buffer.from(rowBytes).equals(readFileSync(`${root}/${reference}-${name}.f32`)))
    throw Error(`Output mismatch: ${name}`);
  let direct100 = 0,
    penetrating100 = 0;
  const examples = [];
  for (let i = 0; i < result.rows.length / CS2_ROW; i++) {
    const sample = cs2Sample(result.rows, i, pose, view, meta.weapon);
    if (!sample.crouched && sample.hp >= 100) {
      if (sample.status === 'clear') direct100++;
      if (sample.status === 'estimated-penetration') penetrating100++;
      if (examples.length < 3) examples.push(sample);
    }
  }
  const report = {
    name,
    settings,
    ms,
    stats: result.stats,
    placementCache: result.placementCache,
    rowBytes: rowBytes.length,
    sha256: hash(rowBytes),
    direct100,
    penetrating100,
    traced,
    traceMs,
    sweeps,
    sweepMs,
    fits,
    fitsMs,
    maxProgressGapMs,
    memory: memory(),
    examples,
  };
  reports.push(report);
  console.log(JSON.stringify(report));
}
const stableShots = JSON.stringify(shots);
if (reference && stableShots !== readFileSync(`${root}/${reference}-shots.json`, 'utf8'))
  throw Error('Representative shots mismatch');
writeFileSync(`${root}/${label}-shots.json`, stableShots);
globalThis.Bun?.gc(true);
const retained = memory();
clearScanPlacementCache?.(map);
globalThis.Bun?.gc(true);
const withoutPlacementCache = memory();
const report = {
  label,
  reference,
  baseline,
  engine: process.versions,
  conditions:
    'Fresh process; filesystem cache uncontrolled. Cold/warm refer to scan placement cache (cleared before each cold workload); BVH build and restoration timed separately. CPU wall time, no GPU timings. After memory is after Bun.gc(true); per-scan memory includes transient allocations.',
  packageBytes: bytes.length,
  metadataBytes: readFileSync(`${folder}map.json`).length,
  binarySha256: hash(bytes),
  triangles: meta.triangleCount,
  before,
  loadMs,
  buildMs,
  restoreMs,
  bvhRootBytes: serialized.roots.reduce((n, root) => n + root.byteLength, 0),
  bvhIndexBytes: serialized.index.byteLength,
  bvhIndirectBytes: serialized.indirectBuffer?.byteLength,
  reports,
  after: retained,
  withoutPlacementCache,
  placementRetainedHeapBytesEstimate: retained.heapUsed - withoutPlacementCache.heapUsed,
};
writeFileSync(`${root}/${label}.json`, JSON.stringify(report, null, 2));
map.dispose();
console.log(JSON.stringify({ loadMs, buildMs, restoreMs, memory: memory() }));
