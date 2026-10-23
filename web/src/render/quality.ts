/** Physical pixel budget bounds walking raster cost on large/high-DPI displays. */
export function viewPixelRatio(
  width: number,
  height: number,
  deviceRatio: number,
  cs2: boolean,
  software: boolean,
  walking: boolean,
) {
  const maximum = cs2 ? (software ? 0.75 : 1) : 2;
  const budget = walking ? Math.sqrt(1_500_000 / Math.max(1, width * height)) : maximum;
  return Math.min(deviceRatio, maximum, budget);
}
