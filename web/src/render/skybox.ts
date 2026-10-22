import * as THREE from 'three';
import type { BSP, Skybox, SkySide } from '../engine/types.ts';

type SkyFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;

export const SKY_SIDES: SkySide[] = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'];
export function skyName(bsp: Pick<BSP, 'entities'>) {
  const name = bsp.entities.find((e) => e.classname === 'worldspawn')?.skyname || 'desert';
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) throw Error('Unsupported skybox name');
  return name.toLowerCase();
}

// GoldSrc environment TGAs are true-color BGR(A), optionally RLE compressed.
// Normalize all four image origins to top-left rows before cube conversion.
export function readTGA(buffer: ArrayBuffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 18 || buffer.byteLength > 8 * 1048576)
    throw Error('Invalid sky TGA size');
  const d = new DataView(buffer),
    u = new Uint8Array(buffer),
    type = u[2],
    width = d.getUint16(12, true),
    height = d.getUint16(14, true),
    depth = u[16],
    flags = u[17];
  if (
    u[1] !== 0 ||
    ![2, 10].includes(type) ||
    ![24, 32].includes(depth) ||
    flags & 192 ||
    !width ||
    !height ||
    width > 1024 ||
    height > 1024
  )
    throw Error('Sky TGA must be true-color 24/32-bit, at most 1024 × 1024');
  const bytes = depth / 8,
    count = width * height,
    rgba = new Uint8Array(count * 4);
  let p = 18 + u[0],
    pixel = 0;
  const copy = (src: number) => {
    const x = pixel % width,
      y = Math.floor(pixel / width),
      out = ((flags & 32 ? y : height - 1 - y) * width + (flags & 16 ? width - 1 - x : x)) * 4;
    rgba[out] = u[src + 2];
    rgba[out + 1] = u[src + 1];
    rgba[out + 2] = u[src];
    rgba[out + 3] = 255;
    pixel++;
  };
  while (pixel < count) {
    if (p >= u.length) throw Error('Truncated sky TGA');
    const packet = type === 10 ? u[p++] : 0,
      n = type === 10 ? (packet & 127) + 1 : count,
      repeat = !!(packet & 128),
      needed = (repeat ? 1 : n) * bytes;
    if (pixel + n > count || p + needed > u.length) throw Error('Invalid sky TGA pixel packet');
    for (let k = 0; k < n; k++) copy(p + (repeat ? 0 : k * bytes));
    p += needed;
  }
  return { width, height, rgba };
}

export function importSkyFiles(files: SkyFile[], name: string): Promise<Skybox> {
  if (files.length !== 6)
    throw Error('Select all six skybox TGAs together (rt, bk, lf, ft, up, dn)');
  const faces: Partial<Record<SkySide, SkyFile>> = {};
  for (const file of files) {
    const match = file.name.match(/^(.*)(rt|bk|lf|ft|up|dn)\.tga$/i);
    if (!match || match[1].toLowerCase() !== name || faces[match[2].toLowerCase() as SkySide])
      throw Error(`Choose the six ${name} skybox TGAs; names must match the map`);
    if (file.size > 8 * 1048576) throw Error('Sky TGA exceeds 8 MiB');
    faces[match[2].toLowerCase() as SkySide] = file;
  }
  return Promise.all(SKY_SIDES.map(async (side) => [side, await faces[side]?.arrayBuffer()])).then(
    (entries) => ({ name, faces: Object.fromEntries(entries) as Skybox['faces'] }),
  );
}

export async function fetchSkybox(
  name: string,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<Skybox | null> {
  const pairs = await Promise.all(
    SKY_SIDES.map(async (side) => {
      const r = await fetcher(`assets/gfx/env/${name}${side}.tga`);
      if (r.status === 404) return [side, null];
      if (!r.ok) throw Error(`Skybox download failed (${r.status})`);
      const size = Number(r.headers.get('Content-Length'));
      if (size > 8 * 1048576) throw Error('Sky TGA exceeds 8 MiB');
      return [side, await r.arrayBuffer()];
    }),
  );
  if (pairs.every(([, data]) => !data)) return null;
  if (pairs.some(([, data]) => !data))
    throw Error(`Incomplete ${name} skybox: all six TGAs are needed`);
  return { name, faces: Object.fromEntries(pairs) as Skybox['faces'] };
}

// WebGL cube order is +X/-X/+Y/-Y/+Z/-Z. Three's ordinary cube backgrounds
// also invert X. Reorient the decoded pixels once to GoldSrc's Z-up axes,
// including its rotated ceiling/floor, so rendering needs no custom shader.
export function buildSkybox(sky: Skybox) {
  const source = Object.fromEntries(SKY_SIDES.map((side) => [side, readTGA(sky.faces[side])])),
    n = source.rt.width;
  if (Object.values(source).some((t) => t.width !== n || t.height !== n))
    throw Error('Skybox TGAs must be square and all the same size');
  const mappings: [SkySide, number, number, number, number, number, number][] = [
    ['lf', 0, -1, n - 1, 1, 0, 0],
    ['rt', 0, 1, 0, -1, 0, n - 1],
    ['bk', -1, 0, n - 1, 0, -1, n - 1],
    ['ft', 1, 0, 0, 0, 1, 0],
    ['up', 0, 1, 0, -1, 0, n - 1],
    ['dn', 0, 1, 0, -1, 0, n - 1],
  ];
  const images = mappings.map(([side, ax, ay, ao, bx, by, bo]) => {
    const data = new Uint8Array(n * n * 4),
      src = source[side].rgba;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const p = ((bx * x + by * y + bo) * n + ax * x + ay * y + ao) * 4,
          q = (y * n + x) * 4;
        data[q] = src[p];
        data[q + 1] = src[p + 1];
        data[q + 2] = src[p + 2];
        data[q + 3] = 255;
      }
    return new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  });
  const cube = new THREE.CubeTexture(images);
  cube.name = sky.name;
  cube.colorSpace = THREE.SRGBColorSpace;
  cube.magFilter = cube.minFilter = THREE.LinearFilter;
  cube.generateMipmaps = false;
  cube.needsUpdate = true;
  return cube;
}
