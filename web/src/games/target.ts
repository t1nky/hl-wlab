import { Box3, Matrix4, Ray, Sphere, Vector3 } from 'three';
import type { Pose, V3 } from '../engine/types';

export interface TargetShape {
  kind: 'box' | 'capsule' | 'sphere';
  name: string;
  group: number;
  min: V3;
  max: V3;
  radius: number;
  matrix: number[];
}
export interface TargetPose {
  shapes: TargetShape[];
  aims: V3[];
  origin: V3;
  label: string;
}
export interface PlayerPackage {
  schema: number;
  model: string;
  fingerprint: string;
  steamInf: string;
  warnings: string[];
  bones: { name: string; parent: number }[];
  hitboxes: (Omit<TargetShape, 'matrix'> & { bone: number; translationOnly: boolean })[];
  clips: {
    name: string;
    crouched: boolean;
    source: string;
    additive: string;
    fps: number;
    frames: number[][][];
  }[];
}
export function goldsrcPose(pose: Pose, origin: V3): TargetPose {
  return {
    origin,
    label: 'Imported MDL pose',
    aims: pose.aims as V3[],
    shapes: pose.boxes
      .filter((b) => b.group !== 8)
      .map((b, i) => {
        const m = b.matrix;
        return {
          kind: 'box',
          name: `hitbox ${i}`,
          group: b.group,
          min: b.mins as V3,
          max: b.maxs as V3,
          radius: 0,
          matrix: [
            m[0],
            m[4],
            m[8],
            0,
            m[1],
            m[5],
            m[9],
            0,
            m[2],
            m[6],
            m[10],
            0,
            m[3],
            m[7],
            m[11],
            1,
          ],
        };
      }),
  };
}
export function playerPose(
  data: PlayerPackage,
  origin: V3,
  yaw: number,
  clipIndex: number,
  frameIndex: number,
): TargetPose {
  if (data.schema !== 1 || !data.hitboxes.length)
    throw Error('Invalid player package; run bun run cs2:prepare:player');
  const clip = data.clips[clipIndex];
  if (!clip || !Number.isInteger(frameIndex) || !clip.frames[frameIndex])
    throw Error('Choose an available pose clip/frame');
  const world = new Matrix4().makeRotationZ((yaw * Math.PI) / 180).setPosition(...origin);
  const shapes = data.hitboxes.map((h) => {
    const transform = clip.frames[frameIndex][h.bone];
    if (transform?.length !== 16 || !transform.every(Number.isFinite))
      throw Error(`Invalid player bone transform: ${h.name}`);
    const local = new Matrix4().fromArray(transform);
    if (h.translationOnly) local.identity().setPosition(new Vector3().fromArray(transform, 12));
    return { ...h, matrix: world.clone().multiply(local).toArray() };
  });
  const aim = (name: string, group: number): V3 => {
    const h = shapes.find((h) => h.name === name) ?? shapes.find((h) => h.group === group);
    if (!h) throw Error(`Player package lacks ${name}`);
    return new Vector3(...h.min)
      .add(new Vector3(...h.max))
      .multiplyScalar(0.5)
      .applyMatrix4(new Matrix4().fromArray(h.matrix))
      .toArray() as V3;
  };
  return {
    origin,
    shapes,
    label: `${clip.name} · frame ${frameIndex}`,
    aims: [aim('spine_2', 2), aim('head_0', 1), aim('pelvis', 3)],
  };
}
export function targetLines(pose: TargetPose): Float32Array {
  const lines: number[] = [];
  for (const shape of pose.shapes) {
    const matrix = new Matrix4().fromArray(shape.matrix);
    const line = (a: Vector3, b: Vector3) => {
      lines.push(...a.applyMatrix4(matrix).toArray(), ...b.applyMatrix4(matrix).toArray());
    };
    if (shape.kind === 'box') {
      const corners = Array.from({ length: 8 }, (_, i) =>
        new Vector3(...shape.min).set(
          i & 1 ? shape.max[0] : shape.min[0],
          i & 2 ? shape.max[1] : shape.min[1],
          i & 4 ? shape.max[2] : shape.min[2],
        ),
      );
      for (let i = 0; i < 8; i++)
        for (const bit of [1, 2, 4])
          if (!(i & bit)) line(corners[i].clone(), corners[i | bit].clone());
    } else {
      const a = new Vector3(...shape.min),
        b = shape.kind === 'sphere' ? a.clone() : new Vector3(...shape.max);
      const axis = b.clone().sub(a).normalize();
      if (!axis.lengthSq()) axis.set(0, 0, 1);
      const u = new Vector3(Math.abs(axis.z) < 0.9 ? 0 : 1, 0, Math.abs(axis.z) < 0.9 ? 1 : 0)
        .cross(axis)
        .normalize();
      const v = axis.clone().cross(u);
      const ring = (center: Vector3, radial: number, z: number) =>
        Array.from({ length: 13 }, (_, i) =>
          center
            .clone()
            .addScaledVector(axis, z)
            .addScaledVector(u, radial * Math.cos((i * Math.PI) / 6))
            .addScaledVector(v, radial * Math.sin((i * Math.PI) / 6)),
        );
      for (const [center, sign] of [
        [a, -1],
        [b, 1],
      ] as const) {
        let previous = ring(center, shape.radius, 0);
        for (let i = 1; i < 5; i++) {
          const theta = (i * Math.PI) / 8;
          const current = ring(
            center,
            shape.radius * Math.cos(theta),
            sign * shape.radius * Math.sin(theta),
          );
          for (let j = 0; j < 12; j++) {
            line(previous[j].clone(), previous[j + 1].clone());
            if (!(j % 3)) line(previous[j].clone(), current[j].clone());
          }
          previous = current;
        }
      }
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const offset = u
          .clone()
          .multiplyScalar(shape.radius * Math.cos(angle))
          .addScaledVector(v, shape.radius * Math.sin(angle));
        line(a.clone().add(offset), b.clone().add(offset));
      }
    }
  }
  return new Float32Array(lines);
}
/** Exact ray intersections against the frozen box/capsule shapes shown in the viewer. */
export function intersectTarget(source: V3, aim: V3, pose: TargetPose) {
  const origin = new Vector3(...source),
    direction = new Vector3(...aim).sub(origin).normalize();
  const ray = new Ray(origin, direction);
  if (!direction.lengthSq()) return null;
  let nearest: { distance: number; point: V3; group: number } | null = null;
  for (const shape of pose.shapes) {
    const matrix = new Matrix4().fromArray(shape.matrix);
    const candidates: Vector3[] = [];
    if (shape.kind === 'box') {
      const local = ray.clone().applyMatrix4(matrix.clone().invert());
      const box = new Box3(new Vector3(...shape.min), new Vector3(...shape.max));
      const point = box.containsPoint(local.origin)
        ? local.origin.clone()
        : local.intersectBox(box, new Vector3());
      if (point) candidates.push(point.applyMatrix4(matrix));
    } else {
      const a = new Vector3(...shape.min).applyMatrix4(matrix),
        b = new Vector3(...(shape.kind === 'sphere' ? shape.min : shape.max)).applyMatrix4(matrix);
      const radius = shape.radius * matrix.getMaxScaleOnAxis();
      if (ray.distanceSqToSegment(a, b) <= radius * radius) {
        const segment = b.clone().sub(a),
          length = segment.length();
        const axis = length ? segment.divideScalar(length) : new Vector3(0, 0, 1);
        const offset = origin.clone().sub(a),
          along = offset.dot(axis),
          dAlong = direction.dot(axis);
        const perpendicular = offset
          .clone()
          .addScaledVector(axis, -Math.max(0, Math.min(length, along)));
        if (perpendicular.lengthSq() <= radius * radius) candidates.push(origin.clone());
        for (const center of [a, b]) {
          const p = ray.intersectSphere(new Sphere(center, radius), new Vector3());
          if (p) candidates.push(p);
        }
        const d = direction.clone().addScaledVector(axis, -dAlong),
          o = offset.clone().addScaledVector(axis, -along);
        const qa = d.lengthSq(),
          qb = 2 * o.dot(d),
          qc = o.lengthSq() - radius * radius,
          disc = qb * qb - 4 * qa * qc;
        if (qa > 1e-12 && disc >= 0)
          for (const t of [
            (-qb - Math.sqrt(disc)) / (2 * qa),
            (-qb + Math.sqrt(disc)) / (2 * qa),
          ]) {
            const y = along + t * dAlong;
            if (t >= 0 && y >= 0 && y <= length) candidates.push(ray.at(t, new Vector3()));
          }
      }
    }
    for (const point of candidates) {
      const distance = origin.distanceTo(point);
      if (!nearest || distance < nearest.distance)
        nearest = { distance, point: point.toArray() as V3, group: shape.group };
    }
  }
  return nearest;
}
