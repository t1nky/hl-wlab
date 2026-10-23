import { BoxGeometry } from 'three';
import { CollisionMap } from '../../cs2/collision';
import { type Metadata, required, type V3 } from '../../cs2/types';

export type Box = { center: V3; size: V3; player?: boolean; bullet?: boolean; rotationY?: number };
export function fixture(boxes: Box[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  const shapes: number[] = [];
  const meta: Metadata = {
    schema: 1,
    map: 'synthetic',
    fingerprint: '',
    steamInf: '',
    binarySha256: '',
    prepareMs: 0,
    binaryBytes: 0,
    vertexCount: 0,
    triangleCount: 0,
    weapon: { name: 'AWP', damage: 115, penetration: 2.5, range: 8192, rangeModifier: 0.99 },
    materials: [
      { name: 'concrete', hash: 0, distanceModifier: 1, damageModifier: 1, gameMaterial: null },
    ],
    shapes: [],
    stats: {},
    spawns: [],
    warnings: [],
  };
  for (const [id, box] of boxes.entries()) {
    const geometry = new BoxGeometry(...box.size)
      .rotateY(box.rotationY ?? 0)
      .translate(...box.center);
    const firstTriangle = indices.length / 3;
    const offset = positions.length / 3;
    positions.push(...geometry.getAttribute('position').array);
    indices.push(...Array.from(required(geometry.index).array, (index) => index + offset));
    const triangleCount = indices.length / 3 - firstTriangle;
    shapes.push(...Array<number>(triangleCount).fill(id));
    meta.shapes.push({
      kind: box.rotationY ? 'mesh' : 'hull',
      source: 'synthetic',
      group: '',
      tags: [],
      exclude: [],
      player: box.player ?? true,
      bullet: box.bullet ?? true,
      firstTriangle,
      triangleCount,
      planes: box.center.flatMap((center, axis) => {
        const normal = [0, 0, 0];
        normal[axis] = 1;
        return [
          [...normal, center + box.size[axis] / 2],
          [...normal.map((x) => -x), -center + box.size[axis] / 2],
        ];
      }),
    });
    geometry.dispose();
  }
  return new CollisionMap(
    {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      shapes: new Uint32Array(shapes),
      materials: new Uint32Array(shapes.length),
    },
    meta,
  );
}
