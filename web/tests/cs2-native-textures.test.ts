import { gzipSync } from 'node:zlib';
import { Box3, CompressedTexture, Group, type Texture, type WebGLRenderer } from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  loadNativeTexture,
  type NativeTextureMetadata,
  nativeTextureLayout,
  nativeTexturePlugin,
} from '../cs2/render-native-textures';
import { RenderResources } from '../cs2/render-resources';
import { loadSky } from '../cs2/render-sky';
import { required } from '../cs2/types';
import { cs2Lighting, setCs2Environment } from '../src/render/lighting';
import { textureBytes } from '../src/render/performance';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const meta: NativeTextureMetadata = {
  schema: 1,
  file: 'render/native-01234567890123456789.bc1.gz',
  format: 'BC1_RGB',
  gpuBytes: 24,
  levels: [
    { width: 4, height: 4, offset: 0, bytes: 8 },
    { width: 2, height: 2, offset: 8, bytes: 8 },
    { width: 1, height: 1, offset: 16, bytes: 8 },
  ],
};
const supported = { extensions: { has: () => true } } as unknown as WebGLRenderer;

it('validates authored block sizes and mip ranges before making a request', () => {
  expect(nativeTextureLayout(meta)).toBe(24);
  for (const invalid of [
    { gpuBytes: 23 },
    { file: 'render/../private.bc1.gz' },
    { levels: [{ ...meta.levels[0], width: 99999 }] },
    { levels: [meta.levels[0], { ...meta.levels[1], offset: 7 }] },
    { levels: [...meta.levels, { ...meta.levels[2], offset: 24 }], gpuBytes: 32 },
  ]) {
    expect(() => nativeTextureLayout({ ...meta, ...invalid })).toThrow();
  }
});
it('uploads the authored mip bytes with shared storage, without creating a bitmap or regenerating mips', async () => {
  const bytes = Uint8Array.from({ length: 24 }, (_, i) => i);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(gzipSync(bytes))),
  );
  const texture = await loadNativeTexture(
    meta,
    '/local/maps/test/',
    'version',
    new AbortController().signal,
  );
  expect(texture).toBeInstanceOf(CompressedTexture);
  expect(texture.generateMipmaps).toBe(false);
  const mips = required(texture.mipmaps);
  expect(mips.map((m) => Array.from(m.data))).toEqual([
    Array.from(bytes.slice(0, 8)),
    Array.from(bytes.slice(8, 16)),
    Array.from(bytes.slice(16)),
  ]);
  expect(mips[0].data.buffer).toBe(mips[2].data.buffer);
  texture.dispose();
});
it('rejects truncated and oversized blocks, and rejects an aborted fetch', async () => {
  for (const size of [23, 25]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(gzipSync(new Uint8Array(size)))),
    );
    await expect(
      loadNativeTexture(meta, '/local/', 'v', new AbortController().signal),
    ).rejects.toThrow(/Truncated|Oversized/);
  }
  const abort = new AbortController();
  abort.abort();
  await expect(loadNativeTexture(meta, '/local/', 'v', abort.signal)).rejects.toThrow();
});
it('uses image fallback without GPU support and shares native textures across image aliases', async () => {
  const resources = new RenderResources();
  const parser = {
    json: {
      textures: [
        { sampler: 0, extras: { cs2Native: meta } },
        { sampler: 0, extras: { cs2Native: meta } },
      ],
    },
    associations: new Map(),
  } as unknown as GLTFParser;
  const controller = new AbortController();
  expect(
    nativeTexturePlugin(
      parser,
      undefined,
      resources,
      '/local/',
      'v',
      controller.signal,
    ).loadTexture(0),
  ).toBeNull();
  const fetch = vi.fn(async () => new Response(gzipSync(new Uint8Array(24))));
  vi.stubGlobal('fetch', fetch);
  const plugin = nativeTexturePlugin(
    parser,
    supported,
    resources,
    '/local/',
    'v',
    controller.signal,
  );
  const [a, b] = await Promise.all([plugin.loadTexture(0), plugin.loadTexture(1)]);
  expect(a).toBe(b);
  expect(fetch).toHaveBeenCalledOnce();
  parser.json.textures[1].extras.cs2Native = {
    ...meta,
    levels: [
      { width: 4, height: 2, offset: 0, bytes: 8 },
      { width: 2, height: 1, offset: 8, bytes: 8 },
      { width: 1, height: 1, offset: 16, bytes: 8 },
    ],
  };
  const differentlyShaped = await plugin.loadTexture(1);
  expect(differentlyShaped).not.toBe(a);
  expect(differentlyShaped?.image.height).toBe(2);
  const dispose = vi.spyOn(required(a), 'dispose');
  resources.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
it('retains native sky cube faces through final ownership and disposes shader uniform textures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(gzipSync(new Uint8Array(96)))),
  );
  const sky = required(
    await loadSky(
      {
        schema: 1,
        file: 'render/sky.bc6h.gz',
        format: 'BC6H_UFLOAT_CUBE',
        size: 4,
        gpuBytes: 96,
        tint: [1, 1, 1],
        angles: [0, 0, 0],
      },
      '/local/',
      'v',
      supported,
    ),
  );
  const texture = sky.material.uniforms.sky.value as Texture;
  expect(texture.image).toHaveLength(6);
  expect(textureBytes(texture)).toBe(96);
  expect(new Box3().setFromObject(sky).isEmpty()).toBe(true);
  const dispose = vi.spyOn(texture, 'dispose');
  const root = new Group().add(sky);
  const resources = new RenderResources();
  resources.object(root);
  resources.retain(root);
  resources.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
it('converts Source direct diffuse units once and follows map brightness, color and Z-up direction', () => {
  const root = new Group().add(...cs2Lighting());
  setCs2Environment(root, {
    angles: [50, 43, 0],
    color: [1, 0.87, 0.74],
    brightness: 2.5,
    brightnessScale: 1.2,
  });
  const sun = root.children.find((c) => c.type === 'DirectionalLight') as ReturnType<
    typeof cs2Lighting
  >[number];
  expect(sun.intensity / Math.PI).toBeCloseTo(3);
  expect(sun.position.clone().normalize().z).toBeCloseTo(Math.sin((50 * Math.PI) / 180));
  expect(sun.color.r).toBe(1);
  expect(sun.color.b).toBeLessThan(0.74);
});
