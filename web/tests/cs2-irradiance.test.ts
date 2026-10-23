import { gzipSync } from 'node:zlib';
import {
  ClampToEdgeWrapping,
  type CompressedTexture,
  LinearFilter,
  NoColorSpace,
  RGB_BPTC_UNSIGNED_Format,
  ShaderLib,
  Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { type IrradianceMetadata, loadIrradiance, patchIrradiance } from '../cs2/render-irradiance';
import { patchSunVisibility } from '../cs2/render-sun';

afterEach(() => vi.unstubAllGlobals());
const metadata: IrradianceMetadata = {
  schema: 1,
  file: 'render/irradiance.bc6h.gz',
  format: 'BC6H_UFLOAT',
  width: 4096,
  height: 4096,
  gpuBytes: 16777216,
  uvScale: [1.1428397, 1.1428397],
  slice: 0,
  sourceMip: 1,
  flipY: false,
};
const renderer = {
  extensions: { has: () => true },
  capabilities: { maxTextureSize: 8192 },
} as unknown as WebGLRenderer;
const shader = () =>
  ({
    vertexShader: ShaderLib.lambert.vertexShader,
    fragmentShader: ShaderLib.lambert.fragmentShader,
    uniforms: {},
  }) as WebGLProgramParametersWithUniforms;
const lighting = () => ({
  texture: Object.assign(new Texture(), { image: { width: 8192, height: 8192 } }),
  scale: new Vector2(...metadata.uvScale),
  enabled: { value: 1 },
  irradiance: {
    texture: Object.assign(new Texture(), { image: { width: 4096, height: 4096 } }),
    scale: new Vector2(...metadata.uvScale),
    status: 'pending' as 'pending' | 'active' | 'unsupported',
  },
});

it('keeps source unsigned BC6H blocks as a single 16 MiB linear HDR mip', async () => {
  const blocks = new Uint8Array(metadata.gpuBytes);
  blocks.set([0, 255, 12, 34, 56, 78, 90, 123]);
  blocks[blocks.length - 1] = 137;
  const fetch = vi.fn(async () => new Response(gzipSync(blocks)));
  vi.stubGlobal('fetch', fetch);
  const loaded = await loadIrradiance(metadata, 'a/b');
  const texture = loaded.texture as CompressedTexture;
  expect(texture.format).toBe(RGB_BPTC_UNSIGNED_Format);
  expect(texture.colorSpace).toBe(NoColorSpace);
  expect(texture.flipY).toBe(false);
  expect(texture.generateMipmaps).toBe(false);
  expect(texture.wrapS).toBe(ClampToEdgeWrapping);
  expect(texture.minFilter).toBe(LinearFilter);
  expect(texture.magFilter).toBe(LinearFilter);
  expect(texture.mipmaps).toHaveLength(1);
  const mip = texture.mipmaps?.[0] as { data: Uint8Array; width: number; height: number };
  expect(mip.data.byteLength).toBe(16777216);
  expect(mip.data.subarray(0, 8)).toEqual(blocks.subarray(0, 8));
  expect(mip.data[mip.data.length - 1]).toBe(137);
  expect([mip.width, mip.height]).toEqual([4096, 4096]);
  expect(fetch).toHaveBeenCalledWith('/local/render/irradiance.bc6h.gz?v=a%2Fb', {
    signal: undefined,
  });
  texture.dispose();
});

it('rejects malformed metadata before fetching or allocating atlas storage', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const invalid of [
    { schema: 2 },
    { format: 'BC6H_SFLOAT' },
    { sourceMip: -1 },
    { slice: 1 },
    { flipY: true },
    { width: 8192 },
    { height: 8192 },
    { gpuBytes: 67108864 },
    { file: 'render/../secret.bc6h.gz' },
    { uvScale: [Number.NaN, 1] },
    { uvScale: [1] },
    { uvScale: undefined },
  ]) {
    await expect(
      loadIrradiance({ ...metadata, ...invalid } as IrradianceMetadata, ''),
    ).rejects.toThrow('Unsupported');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('loads a smaller native atlas mip from the selected map package', async () => {
  const fetch = vi.fn(async () => new Response(gzipSync(new Uint8Array(16))));
  vi.stubGlobal('fetch', fetch);
  const texture = await loadIrradiance(
    { ...metadata, sourceMip: 0, width: 4, height: 4, gpuBytes: 16 },
    'build',
    undefined,
    '/local/maps/custom-map/',
  );
  expect(texture.texture.image.width).toBe(4);
  expect(fetch).toHaveBeenCalledWith('/local/maps/custom-map/render/irradiance.bc6h.gz?v=build', {
    signal: undefined,
  });
  texture.texture.dispose();
});

it('bounds decompressed bytes and rejects early EOF, corrupt gzip and missing files', async () => {
  for (const [size, message] of [
    [16, 'Truncated'],
    [metadata.gpuBytes + 1, 'Oversized'],
  ] as const) {
    vi.stubGlobal('fetch', async () => new Response(gzipSync(new Uint8Array(size))));
    await expect(loadIrradiance(metadata, '')).rejects.toThrow(message);
  }
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
  await expect(loadIrradiance(metadata, '')).rejects.toThrow();
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  await expect(loadIrradiance(metadata, '')).rejects.toThrow('Missing');
});

it('honors cancellation before fetch and while waiting for decompression', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(loadIrradiance(metadata, '', controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const mid = new AbortController();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array(gzipSync(new Uint8Array(32))));
            setTimeout(() => mid.abort(), 0);
          },
        }),
      ),
  );
  await expect(loadIrradiance(metadata, '', mid.signal)).rejects.toThrow();
});

it('replaces only indirect light, cancels Lambert PI, and shares existing UVs and toggle', () => {
  const sun = lighting();
  const compiled = shader();
  patchSunVisibility(compiled, sun, renderer);
  patchIrradiance(compiled, sun, renderer);
  expect(sun.irradiance.status).toBe('active');
  expect(compiled.uniforms.cs2IrradianceEnabled).toBe(sun.enabled);
  sun.enabled.value = 0;
  expect(compiled.uniforms.cs2IrradianceEnabled.value).toBe(0);
  expect(compiled.fragmentShader).toContain(
    'mix(irradiance, PI * texture2D(cs2Irradiance, vCs2LightUv).rgb, cs2IrradianceEnabled)',
  );
  expect(compiled.fragmentShader.indexOf('irradiance = mix')).toBeLessThan(
    compiled.fragmentShader.indexOf('#include <lights_fragment_end>'),
  );
  expect(compiled.vertexShader.match(/cs2LightUv \* cs2SunUvScale/g)).toHaveLength(1);
  expect(compiled.fragmentShader.match(/varying vec2 vCs2LightUv;/g)).toHaveLength(1);
  expect(compiled.fragmentShader).toContain('UNROLLED_LOOP_INDEX == 0');
  expect(compiled.fragmentShader).toContain('#include <alphatest_fragment>');
  expect(compiled.fragmentShader).not.toContain('diffuseColor.rgb *=');
});

it('supports BPTC independently of BC4 and preserves fallback on unsupported devices', () => {
  const sun = lighting();
  const compiled = shader();
  const bptcOnly = {
    ...renderer,
    extensions: { has: (name: string) => name === 'EXT_texture_compression_bptc' },
  } as unknown as WebGLRenderer;
  patchSunVisibility(compiled, sun, bptcOnly);
  patchIrradiance(compiled, sun, bptcOnly);
  expect(compiled.uniforms.cs2SunShadow).toBeUndefined();
  expect(compiled.uniforms.cs2Irradiance).toBeDefined();
  expect(compiled.vertexShader).toContain('cs2LightUv * cs2SunUvScale');
  for (const unsupported of [
    { ...renderer, extensions: { has: () => false } },
    { ...renderer, capabilities: { maxTextureSize: 2048 } },
  ]) {
    const fallback = shader();
    patchIrradiance(fallback, sun, unsupported as unknown as WebGLRenderer);
    expect(sun.irradiance.status).toBe('unsupported');
    expect(fallback.uniforms.cs2Irradiance).toBeUndefined();
    expect(fallback.fragmentShader).toBe(ShaderLib.lambert.fragmentShader);
  }
  sun.irradiance.scale.x = 1;
  expect(() => patchIrradiance(shader(), sun, renderer)).toThrow('Mismatched');
});

it('applies indirect lighting when the map has no supported sun atlas', () => {
  const { texture: _, ...indirectOnly } = lighting();
  const compiled = shader();
  patchSunVisibility(compiled, indirectOnly, renderer);
  patchIrradiance(compiled, indirectOnly, renderer);
  expect(indirectOnly.irradiance.status).toBe('active');
  expect(compiled.uniforms.cs2SunShadow).toBeUndefined();
  expect(compiled.uniforms.cs2Irradiance).toBeDefined();
  expect(compiled.vertexShader.match(/cs2LightUv \* cs2SunUvScale/g)).toHaveLength(1);
  expect(compiled.fragmentShader).not.toContain('directLight.color *=');
});
