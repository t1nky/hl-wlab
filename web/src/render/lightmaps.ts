import * as THREE from 'three';
import type { Face } from '../engine/types.ts';

type Surface = Pick<Face, 'lightmap' | 'uv'>;
export interface LightmapPlacement {
  page: number;
  uv: number[][];
}

/** One upload at map load; gutters isolate bilinear samples at adjacent faces.
 * GoldSrc RGB samples are irradiance, not sRGB albedo. Keep them linear and
 * compensate MeshBasicMaterial's 1/PI factor with lightMapIntensity in map.ts.
 * Light styles are frozen at nominal intensity, rather than waking idle frames.
 */
export function buildLightmapAtlas(faces: Surface[], size = 1024) {
  const placements = new Map<Surface, LightmapPlacement>();
  const pages: Uint8Array<ArrayBuffer>[] = [];
  let x = 1,
    y = 0,
    row = 0,
    page = -1;
  const newPage = () => {
    const data = new Uint8Array(size * size * 4);
    // Reserved white luxel for surfaces that have no baked samples.
    data.set([128, 128, 128, 255]);
    pages.push(data);
    page++;
    x = 1;
    y = 0;
    row = 1;
  };
  const lit = faces
    .filter((f) => f.lightmap)
    .sort((a, b) => (b.lightmap?.height ?? 0) - (a.lightmap?.height ?? 0));
  for (const face of lit) {
    const lm = face.lightmap;
    if (!lm) continue;
    const w = lm.width + 2,
      h = lm.height + 2;
    // Leave room for the reserved white luxel even on a fresh page.
    if (w >= size || h >= size) continue; // unusual oversized surfaces keep fallback shading
    if (page < 0) newPage();
    if (x + w > size) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + h > size) newPage();
    const data = pages[page],
      pixels = lm.width * lm.height;
    for (let dy = -1; dy <= lm.height; dy++)
      for (let dx = -1; dx <= lm.width; dx++) {
        const src =
          (Math.max(0, Math.min(lm.height - 1, dy)) * lm.width +
            Math.max(0, Math.min(lm.width - 1, dx))) *
          3;
        const dst = ((y + dy + 1) * size + x + dx + 1) * 4;
        for (let c = 0; c < 3; c++) {
          let value = 0;
          for (let style = 0; style < lm.styles.length; style++)
            value += lm.samples[src + style * pixels * 3 + c];
          data[dst + c] = Math.min(255, value);
        }
        data[dst + 3] = 255;
      }
    placements.set(face, {
      page,
      uv: face.uv.map(([s, t]) => [
        (x + 1.5 + s / 16 - lm.mins[0]) / size,
        (y + 1.5 + t / 16 - lm.mins[1]) / size,
      ]),
    });
    x += w;
    row = Math.max(row, h);
  }
  const textures = pages.map((data, i) => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.name = `GoldSrc baked lightmap ${i}`;
    texture.channel = 1;
    texture.flipY = false;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  });
  return { textures, placements, white: [0.5 / size, 0.5 / size] };
}
