import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  BoxGeometry,
  BufferAttribute,
  type CompressedTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  RED_RGTC1_Format,
  ShaderLib,
  Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { bindSunUv, compactPrimitive, packSunUv } from '../../tools/cs2-render-pack.mjs';
import { batchStaticMap } from '../cs2/render-batches';
import { disposeRenderGroup } from '../cs2/render-map';
import { type Cs2Material, diffuseMaterial } from '../cs2/render-materials';
import {
  hasSunBinding,
  loadSunVisibility,
  patchSunVisibility,
  type SunLighting,
  type SunMetadata,
} from '../cs2/render-sun';

afterEach(() => vi.unstubAllGlobals());
const metadata: SunMetadata = {
  schema: 1,
  file: 'render/sun-shadow.bc4.gz',
  format: 'BC4_UNORM',
  width: 4,
  height: 4,
  gpuBytes: 8,
  uvScale: [1.1428397, 1.1428397],
  channel: 0,
  slice: 0,
  flipY: false,
  gamma20: false,
  visibility: '1-r',
};
const sun: SunLighting = {
  texture: Object.assign(new Texture(), { image: { width: 4, height: 4 } }),
  scale: new Vector2(...metadata.uvScale),
  enabled: { value: 1 },
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

it('recovers every native UNORM16 value with sub-0.00028-texel float error', () => {
  const values = Float32Array.from({ length: 65536 * 2 }, (_, i) => (i >> 1) / 65535);
  const packed = packSunUv({ array: values, size: 2 });
  expect(packed.normalized).toBe(true);
  let maxError = 0;
  for (let i = 0; i < values.length; i++) {
    expect(packed.array[i]).toBe(i >> 1);
    maxError = Math.max(
      maxError,
      Math.abs(values[i] - packed.array[i] / 65535) * 8192 * metadata.uvScale[0],
    );
  }
  expect(maxError).toBeLessThan(0.00028);
  expect(() => packSunUv({ array: new Float32Array([0.1234567, 0]), size: 2 })).toThrow('UNORM16');
});

it('binds the explicit per-draw UV1 or UV2 without consuming layer UVs or paint weights', () => {
  for (const channel of ['TEXCOORD_1', 'TEXCOORD_2']) {
    const uv = { array: new Float32Array([1, 0, 0, 1, 0, 0]), size: 2 };
    const paint = { array: new Uint8Array(12).fill(99), size: 4, normalized: true };
    const attributes = {
      POSITION: { array: new Float32Array(9), size: 3 },
      [channel]: uv,
      _TEXCOORD_4: paint,
    };
    bindSunUv(attributes, {
      mode: 'lightmap',
      attribute: channel,
      semantic: 'TEXCOORD3',
      storage: 'UNORM16x2',
    });
    expect(attributes[channel]).toBe(uv);
    const compact = compactPrimitive(attributes, new Uint32Array([2, 0, 1]));
    expect([...compact.attributes._CS2_LIGHT_UV.array]).toEqual([0, 0, 65535, 0, 0, 65535]);
    expect([...compact.attributes._TEXCOORD_4.array]).toEqual([...paint.array]);
    expect(compact.attributes._CS2_LIGHT_UV.normalized).toBe(true);
  }
  for (const mode of ['vertex', 'probe']) {
    const attributes = { TEXCOORD_1: { array: new Float32Array(2), size: 2 } };
    bindSunUv(attributes, { mode });
    expect(Object.keys(attributes)).toEqual(['TEXCOORD_1']);
  }
});

it('loads unchanged BC4 bytes with linear red sampling, original dimensions and row orientation', async () => {
  const blocks = new Uint8Array([255, 0, 12, 34, 56, 78, 90, 12]);
  const fetch = vi.fn(async (_url: string) => new Response(gzipSync(blocks)));
  vi.stubGlobal('fetch', fetch);
  const loaded = await loadSunVisibility(metadata, 'package/version');
  expect(loaded.texture.format).toBe(RED_RGTC1_Format);
  expect(loaded.texture.colorSpace).toBe(NoColorSpace);
  expect(loaded.texture.flipY).toBe(false);
  expect(loaded.texture.generateMipmaps).toBe(false);
  const mipmap = (loaded.texture as CompressedTexture).mipmaps?.[0] as { data: Uint8Array };
  expect(mipmap.data).toEqual(blocks);
  expect(fetch.mock.calls[0][0]).toContain('v=package%2Fversion');
  await expect(loadSunVisibility({ ...metadata, gamma20: true }, '')).rejects.toThrow(
    'Unsupported',
  );
  await expect(loadSunVisibility({ ...metadata, visibility: 'r' }, '')).rejects.toThrow(
    'Unsupported',
  );
  const abort = new AbortController();
  abort.abort();
  await expect(loadSunVisibility(metadata, '', abort.signal)).rejects.toThrow();
  loaded.texture.dispose();
});

it('gates only designated direct sunlight, applies scale once, and keeps alpha/layers/hemisphere intact', () => {
  const s = shader();
  patchSunVisibility(s, sun, renderer);
  expect(s.fragmentShader).toContain('UNROLLED_LOOP_INDEX == 0');
  expect(s.fragmentShader).toContain('1.0 - texture2D(cs2SunShadow, vCs2LightUv).r');
  expect(s.fragmentShader).not.toContain('diffuseColor.rgb *=');
  expect(s.fragmentShader).toContain('#include <lights_fragment_end>');
  expect(s.vertexShader.match(/cs2LightUv \* cs2SunUvScale/g)).toHaveLength(1);
  const settings: Cs2Material = {
    shader: 'csgo_environment_blend.vfx',
    blendMode: 2,
    opacity: 0.8,
    uv: { scale: [1, 1], offset: [0, 0], center: [0.5, 0.5], rotation: 0, channel: 0 },
    layers: [],
  };
  settings.layers.push({ texture: 0, uv: { ...settings.uv, channel: 1 } });
  const source = new MeshStandardMaterial({ alphaTest: 0.4, opacity: 0.5 });
  const m = diffuseMaterial(source, settings, [new Texture()], sun);
  const composed = shader();
  m.onBeforeCompile(composed, renderer);
  expect(composed.fragmentShader).toContain('cs2Layer0');
  expect(composed.fragmentShader).toContain('cs2SunShadow');
  expect(composed.fragmentShader).toContain('#include <alphatest_fragment>');
  expect(m.alphaTest).toBe(0.4);
  expect(m.opacity).toBe(0.4);
  const fallback = shader();
  patchSunVisibility(fallback, sun, {
    ...renderer,
    extensions: { has: () => false },
  } as unknown as WebGLRenderer);
  expect(fallback.fragmentShader).not.toContain('cs2SunShadow');
});

it('rejects oversized expanded data and early EOF against the declared atlas capacity', async () => {
  for (const [length, message] of [
    [7, 'Truncated'],
    [1024 * 1024, 'Oversized'],
  ] as const) {
    vi.stubGlobal('fetch', async () => new Response(gzipSync(new Uint8Array(length))));
    await expect(loadSunVisibility(metadata, '')).rejects.toThrow(message);
  }
});

it('keeps unsupported fallback when either atlas dimension exceeds the GPU limit', () => {
  for (const [width, height] of [
    [8192, 4],
    [4, 8192],
  ]) {
    const texture = Object.assign(new Texture(), { image: { width, height } });
    const lighting = { ...sun, texture };
    const compiled = shader();
    patchSunVisibility(compiled, lighting, {
      ...renderer,
      capabilities: { maxTextureSize: 4096 },
    } as unknown as WebGLRenderer);
    expect(lighting.status).toBe('unsupported');
    expect(compiled.uniforms.cs2SunShadow).toBeUndefined();
    expect(compiled.fragmentShader).not.toContain('cs2SunShadow');
    texture.dispose();
  }
});

it('batches matching lightmapped primitives and disposes the shared atlas once, even before attachment', () => {
  const group = new Group();
  const geometry = new BoxGeometry();
  geometry.setAttribute(
    'cs2LightUv',
    new BufferAttribute(new Uint16Array(geometry.getAttribute('position').count * 2), 2, true),
  );
  const material = diffuseMaterial(new MeshStandardMaterial(), undefined, [], sun);
  group.add(new Mesh(geometry, material), new Mesh(geometry.clone(), material));
  const fallback = diffuseMaterial(new MeshStandardMaterial());
  group.add(new Mesh(geometry.clone(), fallback));
  const result = batchStaticMap(group);
  expect(result.batches).toBe(1);
  expect(result.instances).toBe(2);
  const disposed = vi.fn();
  sun.texture.addEventListener('dispose', disposed);
  group.userData.cs2SunTexture = sun.texture;
  disposeRenderGroup(group);
  expect(disposed).toHaveBeenCalledTimes(1);
  const unattached = new Group();
  unattached.userData.cs2SunTexture = new Texture();
  const early = vi.fn();
  unattached.userData.cs2SunTexture.addEventListener('dispose', early);
  disposeRenderGroup(unattached);
  expect(early).toHaveBeenCalledTimes(1);
});

it('patches the pinned Three BC4 lookup for both module and CJS consumers', () => {
  for (const path of [
    'build/three.module.js',
    'build/three.cjs',
    'src/renderers/webgl/WebGLUtils.js',
  ]) {
    const source = readFileSync(`node_modules/three/${path}`, 'utf8');
    expect(source).toContain(
      'if ( p === RED_RGTC1_Format ) return extension.COMPRESSED_RED_RGTC1_EXT;',
    );
  }
});

it('requires explicit primitive mode and native normalized UV storage at runtime', () => {
  const geometry = new BoxGeometry();
  const uv = new BufferAttribute(new Uint16Array(48), 2, true);
  expect(hasSunBinding(geometry)).toBe(false);
  geometry.setAttribute('_cs2_light_uv', uv);
  expect(() => hasSunBinding(geometry)).toThrow('non-lightmapped');
  geometry.userData.cs2Lighting = { mode: 'lightmap', storage: 'UNORM16x2' };
  expect(hasSunBinding(geometry)).toBe(true);
  geometry.setAttribute('_cs2_light_uv', new BufferAttribute(new Float32Array(48), 2));
  expect(() => hasSunBinding(geometry)).toThrow('invalid');
});

const localManifest = new URL('../../.local/cs2/de_inferno/render.json', import.meta.url);
it.skipIf(!existsSync(localManifest))(
  'actual Inferno retains independent UV1/UV2 bindings, fallback props and paint layers',
  () => {
    const meta = JSON.parse(readFileSync(localManifest, 'utf8'));
    if (!meta.sunShadows) return; // Older prepared packages remain valid.
    const gltf = JSON.parse(
      readFileSync(
        new URL('../../.local/cs2/de_inferno/render/chunk-000.gltf', import.meta.url),
        'utf8',
      ),
    );
    const channels = new Set<string>();
    let lightmapped = 0,
      fallback = 0,
      layered = 0;
    for (const mesh of gltf.meshes)
      for (const primitive of mesh.primitives) {
        const sourceMaterial = gltf.materials[primitive.material];
        expect(sourceMaterial.extras.staticSurface).not.toBe(false);
        expect(sourceMaterial.extras.cs2.shader).not.toBe('csgo_effects.vfx');
        const binding = primitive.extras.cs2Lighting;
        if (binding.mode === 'lightmap') {
          lightmapped++;
          channels.add(binding.attribute);
          expect(binding.semantic).toBe('TEXCOORD3');
          expect(binding.packedAttribute).toBe('_CS2_LIGHT_UV');
          const accessor = gltf.accessors[primitive.attributes._CS2_LIGHT_UV];
          expect(accessor.componentType).toBe(5123);
          expect(accessor.normalized).toBe(true);
          expect(accessor.type).toBe('VEC2');
        } else {
          fallback++;
          expect(primitive.attributes._CS2_LIGHT_UV).toBeUndefined();
        }
        if (gltf.materials[primitive.material].extras.cs2.layers.length) {
          layered++;
          expect(primitive.attributes._TEXCOORD_4).toBeDefined();
        }
      }
    expect(channels).toEqual(new Set(['TEXCOORD_1', 'TEXCOORD_2']));
    expect(lightmapped).toBeGreaterThan(6000);
    expect(fallback).toBeGreaterThan(0);
    expect(layered).toBeGreaterThan(100);
    expect(meta.sunShadows.gpuBytes).toBe((meta.sunShadows.width * meta.sunShadows.height) / 2);
  },
);
