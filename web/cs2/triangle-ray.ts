import { type Ray, Triangle, Vector3 } from 'three';
import type { MapData } from './types';

/** Bounded geometry-only cache: exact float64 edges/normals, no cached ray answers.
 * Ray.intersectTriangle (Three 0.170) scalar arithmetic and Triangle.getNormal's
 * distinct winding arithmetic are retained. Immutable map identity owns the cache. */
export function triangleRayIntersector(data: MapData) {
  const limit = 32768,
    stride = 15;
  let keys: Int32Array | undefined;
  let values: Float64Array;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    face = new Vector3();
  const intersect = (triangle: number, ray: Ray, point: Vector3, normal: Vector3) => {
    if (!keys) {
      keys = new Int32Array(limit).fill(-1);
      values = new Float64Array(limit * stride);
    }
    const slot = triangle & (limit - 1),
      at = slot * stride;
    if (keys[slot] !== triangle) {
      const offset = triangle * 3;
      a.fromArray(data.positions, data.indices[offset] * 3);
      b.fromArray(data.positions, data.indices[offset + 1] * 3);
      c.fromArray(data.positions, data.indices[offset + 2] * 3);
      const x1 = b.x - a.x,
        y1 = b.y - a.y,
        z1 = b.z - a.z;
      const x2 = c.x - a.x,
        y2 = c.y - a.y,
        z2 = c.z - a.z;
      values[at] = a.x;
      values[at + 1] = a.y;
      values[at + 2] = a.z;
      values[at + 3] = x1;
      values[at + 4] = y1;
      values[at + 5] = z1;
      values[at + 6] = x2;
      values[at + 7] = y2;
      values[at + 8] = z2;
      values[at + 9] = y1 * z2 - z1 * y2;
      values[at + 10] = z1 * x2 - x1 * z2;
      values[at + 11] = x1 * y2 - y1 * x2;
      Triangle.getNormal(a, b, c, face);
      values[at + 12] = face.x;
      values[at + 13] = face.y;
      values[at + 14] = face.z;
      keys[slot] = triangle;
    }
    const dx = ray.direction.x,
      dy = ray.direction.y,
      dz = ray.direction.z;
    const nx = values[at + 9],
      ny = values[at + 10],
      nz = values[at + 11];
    let ddn = dx * nx + dy * ny + dz * nz;
    let sign: number;
    if (ddn > 0) sign = 1;
    else if (ddn < 0) {
      sign = -1;
      ddn = -ddn;
    } else return false;
    const qx = ray.origin.x - values[at],
      qy = ray.origin.y - values[at + 1],
      qz = ray.origin.z - values[at + 2];
    const x2 = values[at + 6],
      y2 = values[at + 7],
      z2 = values[at + 8];
    const dqe =
      sign * (dx * (qy * z2 - qz * y2) + dy * (qz * x2 - qx * z2) + dz * (qx * y2 - qy * x2));
    if (dqe < 0) return false;
    const x1 = values[at + 3],
      y1 = values[at + 4],
      z1 = values[at + 5];
    const deq =
      sign * (dx * (y1 * qz - z1 * qy) + dy * (z1 * qx - x1 * qz) + dz * (x1 * qy - y1 * qx));
    if (deq < 0 || dqe + deq > ddn) return false;
    const qdn = -sign * (qx * nx + qy * ny + qz * nz);
    if (qdn < 0) return false;
    ray.at(qdn / ddn, point);
    normal.set(values[at + 12], values[at + 13], values[at + 14]);
    return true;
  };
  return Object.assign(intersect, { clear: () => keys?.fill(-1) });
}
