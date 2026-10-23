declare module 'three-mesh-bvh/src/core/utils/intersectUtils.js' {
  export function intersectRay(
    nodeIndex32: number,
    array: Float32Array,
    ray: import('three').Ray,
    near: number,
    far: number,
  ): boolean;
}
