import { existsSync, readFileSync } from 'node:fs';
import { Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { CS2_ROW, classifyCs2, floorCandidates, placeHull, scanMap } from '../cs2/scan';
import { readStudio } from '../src/engine/studio';
import { required, type V3 } from '../src/engine/types';
import { CS2, type DamageView, GOLDSRC, validateScan } from '../src/games/contracts';
import {
  goldsrcPose,
  intersectTarget,
  type PlayerPackage,
  playerPose,
  type TargetPose,
  type TargetShape,
  targetLines,
} from '../src/games/target';
import { fixture } from './helpers/cs2-map';
import { playerModel } from './helpers/game-files';

const view: DamageView = { armor: 0, armorValue: 0, armorRatio: 1, aimPoint: 'head' };
const shape: TargetShape = {
  kind: 'capsule',
  name: 'head',
  group: 1,
  min: [0, 0, -2],
  max: [0, 0, 2],
  radius: 1,
  matrix: new Matrix4().toArray(),
};
function pose(shapes = [shape], origin: V3 = [0, 0, 0]): TargetPose {
  return { shapes, origin, aims: [origin, origin, origin], label: 'synthetic' };
}

describe('shared posed target geometry', () => {
  it('intersects capsule cylinder, caps, tangent, miss and start inside', () => {
    expect(required(intersectTarget([-10, 0, 0], [0, 0, 0], pose())).distance).toBeCloseTo(9);
    expect(required(intersectTarget([0, 0, 10], [0, 0, 0], pose())).distance).toBeCloseTo(7);
    expect(required(intersectTarget([-10, 1, 0], [0, 1, 0], pose())).distance).toBeCloseTo(10);
    expect(intersectTarget([-10, 1.1, 0], [0, 1.1, 0], pose())).toBeNull();
    expect(required(intersectTarget([0, 0, 0], [10, 0, 0], pose())).distance).toBe(0);
    expect(intersectTarget([0, 0, 0], [0, 0, 0], pose())).toBeNull();
  });
  it('respects bone rotations/translations and chooses the first actual hitgroup', () => {
    const transformed = {
      ...shape,
      matrix: new Matrix4()
        .makeRotationY(Math.PI / 2)
        .setPosition(10, 0, 0)
        .toArray(),
    };
    expect(
      required(intersectTarget([0, 0, 0], [10, 0, 0], pose([transformed]))).distance,
    ).toBeCloseTo(7);
    const box = {
      ...shape,
      kind: 'box' as const,
      min: [-1, -2, -1] as V3,
      max: [1, 2, 1] as V3,
      group: 2,
      matrix: new Matrix4()
        .makeRotationZ(Math.PI / 2)
        .setPosition(5, 0, 0)
        .toArray(),
    };
    const hit = required(intersectTarget([0, 0, 0], [10, 0, 0], pose([transformed, box])));
    expect(hit.distance).toBeCloseTo(3);
    expect(hit.group).toBe(2);
    expect(targetLines(pose([box])).length).toBe(12 * 2 * 3);
  });
  it('decodes GoldSrc RLE frame samples, held values and subsequent spans', () => {
    const source = Buffer.from(playerModel()),
      b = Buffer.concat([source, Buffer.from([2, 4, 1, 0, 2, 0, 2, 2, 7, 0, 9, 0])]);
    const bone = b.readInt32LE(144),
      sequence = b.readInt32LE(168) + 176,
      animation = b.readInt32LE(sequence + 124);
    b.writeInt32LE(b.length, 72);
    b.writeFloatLE(1, bone + 88);
    b.writeInt32LE(6, sequence + 56);
    b.writeUInt16LE(source.length - animation, animation);
    const model = readStudio(Uint8Array.from(b).buffer);
    expect(
      [0, 1, 2, 3, 4, 5].map(
        (frame) => model.pose(1, [0, 0, 0], 0, 0, false, { frame }).boxes[0].matrix[3],
      ),
    ).toEqual([1, 2, 2, 2, 7, 9]);
    expect(() => model.pose(1, [0, 0, 0], 0, 0, false, { frame: 6 })).toThrow(/frame/);
    const wire = goldsrcPose(model.pose(1, [10, 20, 30], 90, 0, false, { frame: 4 }), [10, 20, 30]);
    expect(targetLines(wire).every(Number.isFinite)).toBe(true);
    expect(wire.shapes).toHaveLength(1);
  });
  const playerPath = new URL('../../.local/cs2/de_inferno/player.json', import.meta.url);
  it.skipIf(!existsSync(playerPath))(
    'loads all 19 installed hitboxes in real standing and crouch animation poses',
    () => {
      const data: PlayerPackage = JSON.parse(readFileSync(playerPath, 'utf8'));
      const standing = playerPose(data, [0, 0, 0], 0, 0, 0),
        crouch = playerPose(data, [0, 0, 0], 0, 1, 0);
      for (const p of [standing, crouch]) {
        expect(p.shapes).toHaveLength(19);
        expect(targetLines(p).every(Number.isFinite)).toBe(true);
        expect(
          required(intersectTarget([p.aims[1][0], p.aims[1][1], 100], p.aims[1], p)).group,
        ).toBe(1);
      }
      const top = (p: TargetPose) =>
        Math.max(...Array.from(targetLines(p)).filter((_, i) => i % 3 === 2));
      expect(top(standing)).toBeGreaterThan(70);
      expect(top(standing)).toBeLessThan(73);
      expect(top(crouch)).toBeGreaterThan(53);
      expect(top(crouch)).toBeLessThan(56);
      const moved = playerPose(data, [100, 200, 300], 90, 0, 1);
      expect(moved.aims[1][2]).toBeGreaterThan(360);
      expect(() => playerPose(data, [0, 0, 0], 0, 0, 100)).toThrow(/frame/);
    },
  );
});

describe('CS2 standability and bounded shared scan', () => {
  it('keeps lower floors below ceilings and recognizes crouch-only clearance', () => {
    const map = fixture([
      { center: [0, 0, -10], size: [500, 500, 20] },
      { center: [0, 0, 70], size: [500, 500, 20] },
    ]);
    expect(floorCandidates(map, 0, 0)).toEqual([80, 0]);
    expect(placeHull(map, 0, 0, 0, 72)).toBeNull();
    expect(required(placeHull(map, 0, 0, 0, 54))[2]).toBeCloseTo(0.025);
    expect(required(placeHull(map, 0, 0, 80, 72))[2]).toBeCloseTo(80.025);
    map.dispose();
  });
  it('places a hull on a real slope rather than requiring equal-height corners', () => {
    const map = fixture([{ center: [0, 0, -10], size: [500, 500, 20], rotationY: Math.PI / 12 }]);
    const z = required(floorCandidates(map, 0, 0)[0]);
    const foot = required(placeHull(map, 0, 0, z, 72));
    expect(foot[2]).toBeGreaterThan(z + 3);
    expect(map.playerFits(foot, 72, true)).toBe(true);
    map.dispose();
  });
  it('scans both stances at supplied spacing, includes direct rays and cancels without fabricating work', async () => {
    const map = fixture([{ center: [0, 0, -10], size: [500, 500, 20] }]);
    const result = await scanMap(
      map,
      { target: [0, 0, 64], settings: { spacing: 32, radius: 64, workers: 1 } },
      () => {},
      () => false,
    );
    expect(result.stats.total).toBe(25);
    expect(result.stats.standing).toBe(13);
    expect(result.stats.crouching).toBe(13);
    expect(result.rows.length).toBe(26 * CS2_ROW);
    const data = classifyCs2(result.rows, pose(undefined, [0, 0, 64]), view);
    expect(Array.from(data.kind).filter((k) => k === 1)).toHaveLength(12); // coincident eye/point is excluded
    expect(Array.from(data.kind).filter((k) => k === 4)).toHaveLength(13);
    const cancelled = await scanMap(
      map,
      { target: [0, 0, 64], settings: { spacing: 32, radius: 64, workers: 1 } },
      () => {},
      () => true,
    );
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.rows.length).toBe(0);
    map.dispose();
  });
  it('validates requested cost and game capabilities instead of silently clamping controls', () => {
    expect(validateScan(CS2.scan.defaults, CS2)).toBe(7225);
    expect(() => validateScan({ spacing: 3, radius: 8192, workers: 1 }, CS2)).toThrow(/grid cells/);
    expect(() => validateScan({ spacing: 24, radius: 1024, workers: 4 }, CS2)).toThrow(/workers/);
    expect(CS2.weapons).toEqual(['awp']);
    expect(GOLDSRC.weapons.length).toBeGreaterThan(1);
    expect(GOLDSRC.features.armor).toBe(true);
    expect(CS2.features.armor).toBe(false);
  });
});
