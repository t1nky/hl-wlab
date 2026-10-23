import type { Ray } from 'three';

/** three-mesh-bvh 0.9.8 intersectRay arithmetic, hoisting reciprocal directions
 * out of the node loop. Preserve signed zero, infinities and NaN slab handling. */
export class RayBoxTester {
  private x = 0;
  private y = 0;
  private z = 0;
  private ix = 0;
  private iy = 0;
  private iz = 0;
  private near = 0;
  private far = 0;
  set(ray: Ray, near: number, far: number) {
    this.x = ray.origin.x;
    this.y = ray.origin.y;
    this.z = ray.origin.z;
    this.ix = 1 / ray.direction.x;
    this.iy = 1 / ray.direction.y;
    this.iz = 1 / ray.direction.z;
    this.near = near;
    this.far = far;
  }
  intersects(node: number, array: Float32Array) {
    const { x, y, z, ix, iy, iz } = this;
    let min = (array[node + (ix >= 0 ? 0 : 3)] - x) * ix;
    let max = (array[node + (ix >= 0 ? 3 : 0)] - x) * ix;
    const ymin = (array[node + (iy >= 0 ? 1 : 4)] - y) * iy;
    const ymax = (array[node + (iy >= 0 ? 4 : 1)] - y) * iy;
    if (min > ymax || ymin > max) return false;
    if (ymin > min || Number.isNaN(min)) min = ymin;
    if (ymax < max || Number.isNaN(max)) max = ymax;
    const zmin = (array[node + (iz >= 0 ? 2 : 5)] - z) * iz;
    const zmax = (array[node + (iz >= 0 ? 5 : 2)] - z) * iz;
    if (min > zmax || zmin > max) return false;
    if (zmin > min || Number.isNaN(min)) min = zmin;
    if (zmax < max || Number.isNaN(max)) max = zmax;
    return min <= this.far && max >= this.near;
  }
}
