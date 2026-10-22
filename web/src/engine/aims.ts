// The studio model and cached scan rows use this fixed anchor order.
const anchors = { chest: 0, head: 1, pelvis: 2 } as const;
export type AimPoint = keyof typeof anchors | 'best';

export function isAimPoint(value: unknown): value is AimPoint {
  return value === 'head' || value === 'chest' || value === 'pelvis' || value === 'best';
}

export function aimAnchor(point: AimPoint): number | undefined {
  return point === 'best' ? undefined : anchors[point];
}
