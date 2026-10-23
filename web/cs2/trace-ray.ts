/// <reference path="./trace-ray.d.ts" />
import { Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Crossing } from './collision';
import { RayBoxTester } from './ray-box';
import { triangleRayIntersector } from './triangle-ray';
import { EPS, type MapData, type Metadata } from './types';

export interface TraceCrossing extends Crossing {
  shape: number;
  z?: number;
}

/** A collision-only reader for three-mesh-bvh 0.9.8's version-1 indirect nodes.
 * Uses the library's exact node test and Three's exact triangle/normal arithmetic.
 * Keeps traversal/triangle order, every remote crossing, and both face directions.
 * Unlike a render raycast it needs no barycentrics, UVs, face objects or hit points.
 */
export function collisionRaycaster(bvh: MeshBVH, data: MapData, metadata: Metadata) {
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
  const { version, indirectBuffer } = serialized as typeof serialized & {
    version: number;
    indirectBuffer?: Uint32Array;
  };
  if (version !== 1 || !indirectBuffer) throw Error('Unsupported collision BVH layout');
  const roots = serialized.roots.map((root) => ({
    floats: new Float32Array(root),
    ints: new Uint32Array(root),
    shorts: new Uint16Array(root),
  }));
  const intersect = triangleRayIntersector(data);
  const point = new Vector3(),
    normal = new Vector3();
  const ray = new Ray();
  const box = new RayBoxTester();
  const { shapes, materials } = data;
  const cast = (
    source: Vector3,
    direction: Vector3,
    kind: 'bullet' | 'player',
    far: number,
    column?: { indices: number[]; low: number[]; high: number[] },
    collectZ = false,
  ) => {
    ray.origin.copy(source);
    ray.direction.copy(direction);
    const hits: TraceCrossing[] = [];
    const near = EPS / 10;
    box.set(ray, near, far);
    const triangleHit = (triangle: number) => {
      const shape = shapes[triangle];
      if (!metadata.shapes[shape][kind]) return;
      if (!intersect(triangle, ray, point, normal)) return;
      const distance = ray.origin.distanceTo(point);
      if (distance < near || distance > far) return;
      const hit: TraceCrossing = {
        distance,
        facing: normal.dot(direction),
        material: materials[triangle],
        shape,
      };
      if (collectZ) hit.z = point.z;
      hits.push(hit);
    };
    if (column) {
      for (let i = 0; i < column.indices.length; i++) {
        if (column.high[i] < source.z || column.low[i] > source.z + far) continue;
        triangleHit(column.indices[i]);
      }
      return hits;
    }
    for (const { floats, ints, shorts } of roots) {
      const visit = (node: number) => {
        if (shorts[node * 2 + 15] === 65535) {
          const first = ints[node + 6],
            end = first + shorts[node * 2 + 14];
          for (let i = first; i < end; i++) {
            triangleHit(indirectBuffer[i]);
          }
        } else {
          const left = node + 8,
            right = node + ints[node + 6] * 8;
          if (box.intersects(left, floats)) visit(left);
          if (box.intersects(right, floats)) visit(right);
        }
      };
      visit(0);
    }
    return hits;
  };
  return Object.assign(cast, { clear: () => intersect.clear() });
}
