import { type Box3, type Triangle, Vector3 } from 'three';

// Three 0.170 Box3.intersectsTriangle SAT, with the same translated vertices,
// edge subtraction, dot products and inequalities. Hoist invariant box work and
// replace the three per-triangle axis arrays with scalar tests. Synchronous only.
const v0 = new Vector3(),
  v1 = new Vector3(),
  v2 = new Vector3();
const f0 = new Vector3(),
  f1 = new Vector3(),
  f2 = new Vector3();
const normal = new Vector3();
export function triangleBoxIntersector(box: Box3) {
  const center = box.getCenter(new Vector3());
  const extents = new Vector3().subVectors(box.max, center);
  const empty = box.isEmpty();
  const sat = (x: number, y: number, z: number) => {
    const radius = extents.x * Math.abs(x) + extents.y * Math.abs(y) + extents.z * Math.abs(z);
    const p0 = x * v0.x + y * v0.y + z * v0.z;
    const p1 = x * v1.x + y * v1.y + z * v1.z;
    const p2 = x * v2.x + y * v2.y + z * v2.z;
    return !(Math.max(-Math.max(p0, p1, p2), Math.min(p0, p1, p2)) > radius);
  };
  return (triangle: Triangle) => {
    if (empty) return false;
    v0.subVectors(triangle.a, center);
    v1.subVectors(triangle.b, center);
    v2.subVectors(triangle.c, center);
    f0.subVectors(v1, v0);
    f1.subVectors(v2, v1);
    f2.subVectors(v0, v2);
    if (
      !(
        sat(0, -f0.z, f0.y) &&
        sat(0, -f1.z, f1.y) &&
        sat(0, -f2.z, f2.y) &&
        sat(f0.z, 0, -f0.x) &&
        sat(f1.z, 0, -f1.x) &&
        sat(f2.z, 0, -f2.x) &&
        sat(-f0.y, f0.x, 0) &&
        sat(-f1.y, f1.x, 0) &&
        sat(-f2.y, f2.x, 0) &&
        sat(1, 0, 0) &&
        sat(0, 1, 0) &&
        sat(0, 0, 1)
      )
    )
      return false;
    normal.crossVectors(f0, f1);
    return sat(normal.x, normal.y, normal.z);
  };
}
