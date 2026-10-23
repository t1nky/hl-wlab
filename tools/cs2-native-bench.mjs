// Sequential exact-workload numeric-kernel experiment, no private assets in build output.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CollisionMap } from '../web/cs2/collision.ts';
import { createNativeScan } from '../web/cs2/native-scan.ts';
import { clearScanPlacementCache, scanMap } from '../web/cs2/scan.ts';
import { decodeMap } from '../web/cs2/types.ts';
import { CS2 } from '../web/src/games/contracts.ts';
import { playerPose } from '../web/src/games/target.ts';

const root = '.local/perf-scan-2048-20261022/native-pass';
mkdirSync(root, { recursive: true });
const label = process.argv[2] ?? 'native';
if (!/^[\w-]+$/.test(label)) throw Error('Invalid benchmark label');
const folder = '.local/cs2/de_inferno';
const meta = JSON.parse(readFileSync(`${folder}/map.json`, 'utf8'));
const player = JSON.parse(readFileSync(`${folder}/player.json`, 'utf8'));
const start = performance.now();
const bytes = readFileSync(`${folder}/map.cs2map`);
const data = decodeMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const map = new CollisionMap(data, meta);
const mapMs = performance.now() - start;
const initStart = performance.now();
const native = await createNativeScan(
  map,
  readFileSync('web/cs2/scan.wasm'),
  'sah',
  Number(process.env.CS2_NATIVE_LEAF ?? 8),
);
map.native = native;
const initMs = performance.now() - initStart;
const pose = playerPose(player, CS2.target.defaults.p, 0, 0, 0);
const reports = [];
const reference = readFileSync(
  '.local/perf-scan-2048-20261022/head2438bab-before-exact2048-cold.f32',
);
for (const cache of ['cold', 'warm']) {
  if (cache === 'cold') clearScanPlacementCache(map);
  let previous = -1,
    maxProgressGapMs = 0,
    last = performance.now();
  const started = performance.now();
  const result = await scanMap(
    map,
    {
      target: pose.origin,
      pose,
      settings: { spacing: 16, radius: 2048, workers: 1 },
      profile: true,
    },
    (stats) => {
      if (stats.cells < previous) throw Error('Regressing progress');
      previous = stats.cells;
      const now = performance.now();
      maxProgressGapMs = Math.max(maxProgressGapMs, now - last);
      last = now;
    },
    () => false,
  );
  const ms = performance.now() - started;
  const output = new Uint8Array(result.rows.buffer);
  writeFileSync(`${root}/${label}-${cache}.f32`, output);
  let firstMismatch = -1;
  if (!Buffer.from(output).equals(reference)) {
    const expected = new Float32Array(
      reference.buffer,
      reference.byteOffset,
      reference.byteLength / 4,
    );
    firstMismatch = result.rows.findIndex((value, i) => !Object.is(value, expected[i]));
    console.log(
      JSON.stringify({
        firstMismatch,
        row: Math.floor(firstMismatch / 17),
        field: firstMismatch % 17,
        actual: Array.from(
          result.rows.slice(
            Math.floor(firstMismatch / 17) * 17,
            Math.floor(firstMismatch / 17) * 17 + 17,
          ),
        ),
        expected: Array.from(
          expected.slice(
            Math.floor(firstMismatch / 17) * 17,
            Math.floor(firstMismatch / 17) * 17 + 17,
          ),
        ),
      }),
    );
  }
  const report = {
    cache,
    ms,
    mapMs,
    initMs,
    loadAndColdMs: cache === 'cold' ? mapMs + initMs + ms : undefined,
    sharedNativeBytes: native.shared.bytes,
    stats: result.stats,
    placementCache: result.placementCache,
    profile: result.profile,
    native: result.native,
    maxProgressGapMs,
    byteParity: firstMismatch < 0 && output.length === reference.length,
    sha256: createHash('sha256').update(output).digest('hex'),
    memory: process.memoryUsage(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  reports.push(report);
  console.log(JSON.stringify(report));
  if (!report.byteParity) break;
}
const expectedShots = JSON.parse(
  readFileSync('.local/perf-scan-2048-20261022/head2438bab-before-shots.json', 'utf8'),
);
const shotErrors = [];
for (const [index, expected] of expectedShots.entries()) {
  const kind = expected.distance < 1.01 ? 'player' : 'bullet';
  const { ms: _ms, ...actual } = map.trace(expected.source, expected.target, kind);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    shotErrors.push({ index, kind, publicShot: true });
  const result = native.trace(expected.source, expected.target, kind);
  if (
    !Object.is(result[0], expected.damage ?? -1) ||
    result[1] !==
      ['clear', 'estimated-penetration', 'blocked', 'indeterminate'].indexOf(expected.status) ||
    result[2] !== expected.spans.length
  )
    shotErrors.push({
      index,
      kind,
      expected: [expected.damage, expected.status, expected.spans.length],
      actual: result,
    });
}
writeFileSync(
  `${root}/${label}.json`,
  JSON.stringify({ label, baseline: '2438bab', mapMs, initMs, reports, shotErrors }, null, 2),
);
console.log(JSON.stringify({ shotErrors }));
map.dispose();
if (shotErrors.length || reports.some((report) => !report.byteParity)) process.exitCode = 1;
