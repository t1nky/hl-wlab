// Uses only ignored, locally prepared game data. Run with Bun (TypeScript imports).
import { readFileSync, writeFileSync } from 'node:fs';
import { CollisionMap } from '../web/cs2/collision.ts';
import { CS2_ROW, cs2Sample, scanMap } from '../web/cs2/scan.ts';
import { decodeMap } from '../web/cs2/types.ts';
import { CS2 } from '../web/src/games/contracts.ts';
import { playerPose } from '../web/src/games/target.ts';

const folder = '.local/cs2/de_inferno/';
const meta = JSON.parse(readFileSync(`${folder}map.json`, 'utf8'));
const player = JSON.parse(readFileSync(`${folder}player.json`, 'utf8'));
if (meta.steamInf !== player.steamInf)
  throw Error('Prepare map and player from the same installation version');
const bytes = readFileSync(`${folder}map.cs2map`);
const map = new CollisionMap(
  decodeMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  meta,
);
const pose = playerPose(player, CS2.target.defaults.p, 0, 0, 0);
const view = { armor: 0, armorValue: 0, armorRatio: 1, aimPoint: 'head' };
const reports = [];
for (const settings of [{ spacing: 64, radius: 768, workers: 1 }, CS2.scan.defaults]) {
  const started = performance.now();
  const result = await scanMap(
    map,
    { target: pose.origin, pose, settings },
    () => {},
    () => false,
  );
  const report = {
    settings,
    ...result.stats,
    ms: performance.now() - started,
    status: {},
    standingStatus: {},
    examples: [],
    standingAt100HP: { direct: 0, penetrating: 0 },
  };
  for (let i = 0; i < result.rows.length / CS2_ROW; i++) {
    const sample = cs2Sample(result.rows, i, pose, view, meta.weapon);
    report.status[sample.status] = (report.status[sample.status] ?? 0) + 1;
    if (!sample.crouched)
      report.standingStatus[sample.status] = (report.standingStatus[sample.status] ?? 0) + 1;
    if (!sample.crouched && sample.hp >= 100) {
      if (sample.status === 'clear') report.standingAt100HP.direct++;
      if (sample.status === 'estimated-penetration') report.standingAt100HP.penetrating++;
    }
    if (!sample.crouched && sample.status === 'clear' && report.examples.length < 3)
      report.examples.push(sample);
  }
  if (result.cancelled || report.standing < 100 || !report.status.clear)
    throw Error('Installed Inferno scan smoke failed');
  reports.push(report);
}
map.dispose();
writeFileSync(
  '.local/cs2/scan-smoke.json',
  JSON.stringify(
    { steamInf: meta.steamInf, target: pose.origin, playerModel: player.model, reports },
    null,
    2,
  ),
);
console.log(JSON.stringify(reports));
