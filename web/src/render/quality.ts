import { Vector2, type WebGLRenderer } from 'three';

const currentSize = new Vector2();

/** Change size and pixel ratio together, without clearing an unchanged canvas
 * or allocating an intermediate drawing buffer at the previous logical size. */
export function resizeView(
  renderer: Pick<WebGLRenderer, 'getSize' | 'getPixelRatio' | 'setDrawingBufferSize'>,
  width: number,
  height: number,
  ratio: number,
) {
  renderer.getSize(currentSize);
  if (currentSize.x === width && currentSize.y === height && renderer.getPixelRatio() === ratio)
    return false;
  renderer.setDrawingBufferSize(width, height, ratio);
  return true;
}

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
