import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BoxGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CollisionMap, estimate, hullSpan, meshSpans, unionSpans } from '../cs2/collision';
import {
  decodeMap,
  type MapData,
  type Metadata,
  required,
  type Shape,
  type Span,
} from '../cs2/types';

function fixture(kind: 'mesh' | 'hull' = 'mesh', bullet = true) {
  const box = new BoxGeometry(10, 200, 200);
  box.translate(15, 0, 0);
  const positions = new Float32Array(box.getAttribute('position').array);
  const indices = new Uint32Array(required(box.index).array);
  const shape: Shape = {
    kind,
    source: 'synthetic',
    group: 'default',
    tags: [],
    exclude: [],
    bullet,
    player: true,
    firstTriangle: 0,
    triangleCount: indices.length / 3,
    planes: [
      [1, 0, 0, 20],
      [-1, 0, 0, -10],
      [0, 1, 0, 100],
      [0, -1, 0, 100],
      [0, 0, 1, 100],
      [0, 0, -1, 100],
    ],
  };
  const meta: Metadata = {
    schema: 1,
    map: 'synthetic',
    fingerprint: 'test',
    steamInf: 'test',
    binarySha256: '',
    prepareMs: 0,
    binaryBytes: 0,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    weapon: { name: 'AWP', damage: 115, penetration: 2.5, range: 8192, rangeModifier: 0.99 },
    materials: [
      { name: 'wood', hash: 1, distanceModifier: 0.9, damageModifier: 0.6, gameMaterial: 'W' },
    ],
    shapes: [shape],
    stats: {},
    spawns: [],
    warnings: [],
  };
  const data: MapData = {
    positions,
    indices,
    materials: new Uint32Array(indices.length / 3),
    shapes: new Uint32Array(indices.length / 3),
  };
  return { map: new CollisionMap(data, meta), meta };
}
function span(enter: number, exit: number): Span {
  return { enter, exit, material: 0, exitMaterial: 0, shape: 0, startInside: false };
}
describe('CS2 collision and explicit surrogate', () => {
  for (const kind of ['mesh', 'hull'] as const) {
    it(`${kind}: oblique geometric entry/exit and winding`, () => {
      const { map } = fixture(kind);
      const shot = map.trace([0, 0, 0], [30, 15, 0]);
      expect(shot.issues).toEqual([]);
      expect(shot.spans).toHaveLength(1);
      expect(shot.spans[0].enter).toBeCloseTo(Math.sqrt(125));
      expect(shot.spans[0].exit - shot.spans[0].enter).toBeCloseTo(Math.sqrt(125));
      expect(shot.status).toBe('estimated-penetration');
      expect(shot.damage).toBeGreaterThan(0);
      map.dispose();
    });
    it(`${kind}: start-inside and target-inside are indeterminate`, () => {
      const { map } = fixture(kind);
      expect(map.trace([15, 0, 0], [30, 0, 0]).spans[0].startInside).toBe(true);
      expect(map.trace([15, 0, 0], [30, 0, 0]).damage).toBeNull();
      expect(map.trace([0, 0, 0], [15, 0, 0]).status).toBe('indeterminate');
      map.dispose();
    });
    it(`${kind}: parallel rays, grazing face, and misses`, () => {
      const { map } = fixture(kind);
      expect(map.trace([0, 101, 0], [30, 101, 0]).status).toBe('clear');
      expect(map.trace([0, 0, 0], [0, 30, 0]).status).toBe('clear');
      map.dispose();
    });
  }
  it('filters player-only shapes for bullets, retains them for clearance', () => {
    const { map } = fixture('hull', false);
    expect(map.trace([0, 0, 0], [30, 0, 0]).status).toBe('clear');
    expect(map.trace([0, 0, 0], [30, 0, 0], 'player').spans).toHaveLength(1);
    expect(map.standable([15, 0, 0])).toBe(false);
    map.dispose();
  });
  it('treats sky as a boundary, never as a containing solid', () => {
    const { map, meta } = fixture();
    meta.shapes[0].tags = ['sky'];
    // First forward intersection is a backface, beyond the nearby target.
    expect(map.trace([15, 0, 0], [16, 0, 0]).status).toBe('clear');
    expect(map.trace([15, 0, 0], [16, 0, 0]).spans).toEqual([]);
    // Boundary crossings still block, from either direction.
    expect(map.trace([15, 0, 0], [30, 0, 0]).status).toBe('blocked');
    expect(map.trace([0, 0, 0], [15, 0, 0]).status).toBe('blocked');
    expect(map.trace([15, 0, 0], [0, 0, 0]).contacts.length).toBeGreaterThan(0);
    map.dispose();
  });
  it('keeps per-triangle surface and shape IDs through indirect BVH traversal', () => {
    const { map: first, meta } = fixture();
    const a = first.data;
    const positions = new Float32Array(a.positions.length * 2);
    positions.set(a.positions);
    positions.set(a.positions, a.positions.length);
    for (let i = a.positions.length; i < positions.length; i += 3) positions[i] += 40;
    const indices = new Uint32Array(a.indices.length * 2);
    indices.set(a.indices);
    indices.set(
      a.indices.map((i) => i + a.positions.length / 3),
      a.indices.length,
    );
    const materials = new Uint32Array(a.materials.length * 2);
    materials.fill(1, a.materials.length);
    const shapes = materials.slice();
    meta.materials.push({
      ...meta.materials[0],
      name: 'metal',
      hash: 2,
      distanceModifier: 0.4,
      damageModifier: 0.3,
    });
    meta.shapes.push({ ...meta.shapes[0], firstTriangle: a.materials.length });
    const map = new CollisionMap({ positions, indices, materials, shapes }, meta);
    const shot = map.trace([0, 0, 0], [80, 0, 0]);
    expect(shot.spans.map((s) => [s.material, s.shape, s.enter, s.exit])).toEqual([
      [0, 0, 10, 20],
      [1, 1, 50, 60],
    ]);
    first.dispose();
    map.dispose();
  });
  it('preserves coordinate transforms in analytic hull planes', () => {
    // A rotated and translated hull: 10 <= y <= 20, -100 <= x <=100.
    const hit = hullSpan(
      [
        [0, 1, 0, 20],
        [0, -1, 0, -10],
        [1, 0, 0, 100],
        [-1, 0, 0, 100],
        [0, 0, 1, 100],
        [0, 0, -1, 100],
      ],
      new Vector3(0, 0, 0),
      new Vector3(0, 1, 0),
      40,
    );
    expect(hit).toEqual([10, 20]);
  });
  it('rejects unclosed and conflicting mesh crossings, deduplicates shared edges', () => {
    expect(meshSpans([{ distance: 10, facing: -1, material: 0 }], 30, 0).issues).not.toEqual([]);
    expect(
      meshSpans(
        [
          { distance: 10, facing: -1, material: 0 },
          { distance: 10, facing: 1, material: 0 },
        ],
        30,
        0,
      ).issues,
    ).not.toEqual([]);
    expect(
      meshSpans(
        [
          { distance: 10, facing: -1, material: 0 },
          { distance: 10, facing: -1, material: 0 },
          { distance: 20, facing: 1, material: 0 },
        ],
        30,
        0,
      ).spans,
    ).toHaveLength(1);
    expect(
      meshSpans(
        [
          { distance: 100, facing: -1, material: 0 },
          { distance: 110, facing: -1, material: 0 },
        ],
        30,
        0,
      ).issues,
    ).toEqual([]);
  });
  it('does not charge overlapping solids twice', () => {
    const { map, meta } = fixture();
    const result = unionSpans([span(10, 20), span(15, 25)], meta);
    expect(result.reduce((total, s) => total + s.exit - s.enter, 0)).toBe(15);
    map.dispose();
  });
  it('falloff is applied once, thicker solids lose more energy, unknowns never claim hits', () => {
    const { map, meta } = fixture();
    expect(estimate([], 500, meta, []).damage).toBeCloseTo(115 * 0.99);
    expect(required(estimate([span(10, 15)], 100, meta, []).damage)).toBeGreaterThan(
      required(estimate([span(10, 30)], 100, meta, []).damage),
    );
    expect(estimate([span(10, 100)], 200, meta, []).status).toBe('blocked');
    meta.materials[0].damageModifier = null;
    expect(estimate([span(10, 15)], 100, meta, []).status).toBe('indeterminate');
    expect(estimate([], 100, meta, ['bad geometry']).damage).toBeNull();
    map.dispose();
  });
  it('validates malformed packages and coordinates', () => {
    expect(() => decodeMap(new ArrayBuffer(16))).toThrow();
    const { map } = fixture();
    expect(() => map.trace([0, 0, 0], [0, 0, 0])).toThrow();
    expect(() => map.trace([Number.NaN, 0, 0], [1, 0, 0])).toThrow();
    map.dispose();
  });
});
const local = fileURLToPath(new URL('../../.local/cs2/de_inferno/', import.meta.url));
it.skipIf(!existsSync(`${local}map.json`))(
  'private installed Inferno extraction/load/trace smoke',
  () => {
    const meta: Metadata = JSON.parse(readFileSync(`${local}map.json`, 'utf8'));
    const bytes = readFileSync(`${local}map.cs2map`);
    const data = decodeMap(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(meta.map).toBe('de_inferno');
    expect(meta.triangleCount).toBeGreaterThan(100000);
    expect(data.indices.length / 3).toBe(meta.triangleCount);
    expect(meta.materials.some((m) => m.name === 'wood')).toBe(true);
    expect(meta.shapes.some((s) => s.tags.includes('playerclip') && !s.bullet && s.player)).toBe(
      true,
    );
    expect(meta.shapes.filter((s) => s.tags.includes('passbullets')).every((s) => !s.bullet)).toBe(
      true,
    );
    const start = performance.now();
    const map = new CollisionMap(data, meta);
    const buildMs = performance.now() - start;
    const clear = map.trace([-1586.52, 440.79, 18], [-1520.06, 430.891, 2]);
    expect(clear.status).toBe('clear');
    expect(clear.spans).toHaveLength(0);
    const wall = map.trace([-1586.52, 440.79, 18], [-1586.52, 440.79, -200]);
    expect(wall.spans.length + wall.issues.length).toBeGreaterThan(0);
    expect(wall.status).not.toBe('clear');
    expect(wall.contacts.length).toBeGreaterThan(0);
    const wood = map.trace(
      [1333.673828125, 3069.50634765625, 220.5009307861328],
      [1333.673828125, 3113.50634765625, 220.5009307861328],
    );
    expect(wood.status).toBe('estimated-penetration');
    expect(meta.materials[wood.spans[0].material].name).toBe('wood');
    expect(wood.spans[0].exit - wood.spans[0].enter).toBeCloseTo(3.5, 2);
    // User-reported false start-solid: a remote inward sky face used to hide
    // this valid wall interval. Forward/reverse physical thickness must agree.
    const source: [number, number, number] = [77.46, 1227.8, 156.9];
    const target: [number, number, number] = [457.28, 1846.2, 184];
    const plaster = map.trace(source, target);
    const reverse = map.trace(target, source);
    expect(plaster.status).toBe('estimated-penetration');
    expect(plaster.issues).toEqual([]);
    expect(plaster.spans).toHaveLength(1);
    expect(meta.materials[plaster.spans[0].material].name).toBe('plaster');
    expect(plaster.spans[0].enter).toBeCloseTo(670.2012, 3);
    expect(plaster.spans[0].exit).toBeCloseTo(689.4508, 3);
    expect(plaster.spans[0].startInside).toBe(false);
    expect(plaster.spans[0].exit - plaster.spans[0].enter).toBeCloseTo(
      reverse.spans[0].exit - reverse.spans[0].enter,
      5,
    );
    expect(plaster.damage).toBeCloseTo(reverse.damage ?? -1, 5);
    console.log(
      JSON.stringify({ map: meta.map, triangles: meta.triangleCount, buildMs, clear, wall }),
    );
    map.dispose();
  },
  30000,
);
