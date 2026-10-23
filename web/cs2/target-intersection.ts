import { Box3, Matrix4, Ray, Sphere, Vector3 } from 'three';
import type { TargetPose } from '../src/games/target';
import type { V3 } from './types';

/** Compile immutable frozen pose data once per scan. Intersection arithmetic and ordering
 * match intersectTarget; only invariant transforms and scratch allocations are reused. */
export function targetIntersector(pose: TargetPose) {
  const shapes = pose.shapes.map((shape) => {
    const matrix = new Matrix4().fromArray(shape.matrix);
    const a = new Vector3(...shape.min).applyMatrix4(matrix);
    const b = new Vector3(...(shape.kind === 'sphere' ? shape.min : shape.max)).applyMatrix4(
      matrix,
    );
    const segment = b.clone().sub(a);
    const length = segment.length();
    return {
      kind: shape.kind,
      group: shape.group,
      matrix,
      inverse: matrix.clone().invert(),
      box: new Box3(new Vector3(...shape.min), new Vector3(...shape.max)),
      a,
      b,
      length,
      axis: length ? segment.divideScalar(length) : new Vector3(0, 0, 1),
      radius: shape.radius * matrix.getMaxScaleOnAxis(),
    };
  });
  const origin = new Vector3(),
    direction = new Vector3();
  const ray = new Ray(origin, direction),
    local = new Ray();
  const point = new Vector3(),
    offset = new Vector3(),
    perpendicular = new Vector3();
  const d = new Vector3(),
    o = new Vector3(),
    sphere = new Sphere();
  return (source: V3, aim: V3): { distance: number; point: V3; group: number } | null => {
    origin.set(...source);
    direction
      .set(...aim)
      .sub(origin)
      .normalize();
    if (!direction.lengthSq()) return null;
    let nearest: { distance: number; point: V3; group: number } | null = null;
    const accept = (p: Vector3, group: number) => {
      const distance = origin.distanceTo(p);
      if (!nearest || distance < nearest.distance)
        nearest = { distance, point: p.toArray() as V3, group };
    };
    for (const shape of shapes) {
      if (shape.kind === 'box') {
        local.copy(ray).applyMatrix4(shape.inverse);
        const p = shape.box.containsPoint(local.origin)
          ? point.copy(local.origin)
          : local.intersectBox(shape.box, point);
        if (p) accept(p.applyMatrix4(shape.matrix), shape.group);
      } else {
        const { a, b, radius, axis, length, group } = shape;
        if (ray.distanceSqToSegment(a, b) > radius * radius) continue;
        offset.copy(origin).sub(a);
        const along = offset.dot(axis),
          dAlong = direction.dot(axis);
        perpendicular.copy(offset).addScaledVector(axis, -Math.max(0, Math.min(length, along)));
        if (perpendicular.lengthSq() <= radius * radius) accept(origin, group);
        for (const center of [a, b]) {
          sphere.set(center, radius);
          const p = ray.intersectSphere(sphere, point);
          if (p) accept(p, group);
        }
        d.copy(direction).addScaledVector(axis, -dAlong);
        o.copy(offset).addScaledVector(axis, -along);
        const qa = d.lengthSq(),
          qb = 2 * o.dot(d),
          qc = o.lengthSq() - radius * radius;
        const disc = qb * qb - 4 * qa * qc;
        if (qa > 1e-12 && disc >= 0)
          for (const t of [
            (-qb - Math.sqrt(disc)) / (2 * qa),
            (-qb + Math.sqrt(disc)) / (2 * qa),
          ]) {
            const y = along + t * dAlong;
            if (t >= 0 && y >= 0 && y <= length) accept(ray.at(t, point), group);
          }
      }
    }
    return nearest;
  };
}
