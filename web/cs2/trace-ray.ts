/// <reference path="./trace-ray.d.ts" />
import { Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { intersectRay } from 'three-mesh-bvh/src/core/utils/intersectUtils.js';
import type { Crossing } from './collision';
import { EPS, type MapData, type Metadata } from './types';

export interface TraceCrossing extends Crossing {
  shape: number;
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
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const point = new Vector3(),
    normal = new Vector3();
  const ray = new Ray();
  const { positions, indices, shapes, materials } = data;
  return (source: Vector3, direction: Vector3, kind: 'bullet' | 'player', far: number) => {
    ray.origin.copy(source);
    ray.direction.copy(direction);
    const hits: TraceCrossing[] = [];
    const near = EPS / 10;
    for (const { floats, ints, shorts } of roots) {
      const visit = (node: number) => {
        if (shorts[node * 2 + 15] === 65535) {
          const first = ints[node + 6],
            end = first + shorts[node * 2 + 14];
          for (let i = first; i < end; i++) {
            const triangle = indirectBuffer[i],
              shape = shapes[triangle];
            if (!metadata.shapes[shape][kind]) continue;
            const offset = triangle * 3;
            a.fromArray(positions, indices[offset] * 3);
            b.fromArray(positions, indices[offset + 1] * 3);
            c.fromArray(positions, indices[offset + 2] * 3);
            if (!ray.intersectTriangle(a, b, c, false, point)) continue;
            const distance = ray.origin.distanceTo(point);
            if (distance < near || distance > far) continue;
            Triangle.getNormal(a, b, c, normal);
            hits.push({
              distance,
              facing: normal.dot(direction),
              material: materials[triangle],
              shape,
            });
          }
        } else {
          const left = node + 8,
            right = node + ints[node + 6] * 8;
          if (intersectRay(left, floats, ray, near, far)) visit(left);
          if (intersectRay(right, floats, ray, near, far)) visit(right);
        }
      };
      visit(0);
    }
    return hits;
  };
}
