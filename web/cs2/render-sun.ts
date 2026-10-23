import {
  type BufferGeometry,
  ClampToEdgeWrapping,
  CompressedTexture,
  LinearFilter,
  NoColorSpace,
  RED_RGTC1_Format,
  ShaderChunk,
  type Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import type { IrradianceLighting } from './render-irradiance';

export interface SunMetadata {
  schema: number;
  file: string;
  format: string;
  width: number;
  height: number;
  uvScale: [number, number];
  gpuBytes: number;
  gamma20: boolean;
  visibility: string;
  flipY: boolean;
  channel: number;
  slice: number;
}

export interface SunBinding {
  mode: 'lightmap' | 'vertex' | 'probe';
  semantic?: string;
  attribute?: string;
  storage?: string;
}

export interface SunLighting {
  texture: Texture;
  scale: Vector2;
  enabled: { value: number };
  irradiance?: IrradianceLighting;
  status?: 'pending' | 'active' | 'unsupported';
}

/** Custom attribute presence alone never establishes a draw's baked-lighting mode. */
export function hasSunBinding(geometry: BufferGeometry): boolean {
  const binding = geometry.userData.cs2Lighting as SunBinding | undefined;
  const uv = geometry.getAttribute('_cs2_light_uv');
  if (binding?.mode !== 'lightmap') {
    if (uv) throw Error('Sunlight UV on a non-lightmapped primitive');
    return false;
  }
  if (
    uv?.itemSize !== 2 ||
    !uv.normalized ||
    !(uv.array instanceof Uint16Array) ||
    binding.storage !== 'UNORM16x2'
  )
    throw Error('Missing or invalid lightmapped primitive UV');
  return true;
}

export async function loadSunVisibility(
  metadata: SunMetadata,
  version: string,
  signal?: AbortSignal,
): Promise<SunLighting> {
  if (
    metadata.schema !== 1 ||
    metadata.format !== 'BC4_UNORM' ||
    metadata.gamma20 ||
    metadata.visibility !== '1-r' ||
    metadata.flipY ||
    metadata.channel !== 0 ||
    metadata.slice !== 0 ||
    !/^render\/[a-zA-Z0-9_.-]+\.bc4\.gz$/.test(metadata.file) ||
    ![metadata.width, metadata.height].every(
      (v) => Number.isInteger(v) && v > 0 && v <= 16384 && v % 4 === 0,
    ) ||
    metadata.gpuBytes !== (metadata.width * metadata.height) / 2 ||
    metadata.uvScale.length !== 2 ||
    !metadata.uvScale.every((v) => Number.isFinite(v) && v > 0)
  )
    throw Error('Unsupported sunlight visibility atlas');
  const response = await fetch(`/local/${metadata.file}?v=${encodeURIComponent(version)}`, {
    signal,
  });
  if (!response.ok || !response.body) throw Error('Missing sunlight visibility atlas');
  // Bound expanded storage while streaming; validating only after arrayBuffer()
  // would let a malformed gzip allocate far beyond its declared atlas size.
  const bytes = new Uint8Array(metadata.gpuBytes);
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let used = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > bytes.byteLength - used)
        throw Error('Oversized sunlight visibility atlas');
      bytes.set(value, used);
      used += value.byteLength;
    }
    if (used !== bytes.byteLength) throw Error('Truncated sunlight visibility atlas');
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const texture = new CompressedTexture(
    [{ data: bytes, width: metadata.width, height: metadata.height }],
    metadata.width,
    metadata.height,
    RED_RGTC1_Format,
  );
  texture.name = 'CS2 original baked sun shadow red (BC4)';
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return {
    texture,
    scale: new Vector2(...metadata.uvScale),
    enabled: { value: 1 },
    status: 'pending',
  };
}

/** The viewer designates directional slot zero as its sun. Point/spot lights and
 * hemisphere irradiance stay outside this patch. A later directional light is unaffected.
 */
export function patchSunVisibility(
  shader: WebGLProgramParametersWithUniforms,
  sun: SunLighting,
  renderer: WebGLRenderer,
) {
  if (
    !renderer.extensions.has('EXT_texture_compression_rgtc') ||
    renderer.capabilities.maxTextureSize <
      Math.max(sun.texture.image.width, sun.texture.image.height)
  ) {
    sun.status = 'unsupported';
    return;
  }
  sun.status = 'active';
  shader.uniforms.cs2SunShadow = { value: sun.texture };
  shader.uniforms.cs2SunUvScale = { value: sun.scale };
  shader.uniforms.cs2SunEnabled = sun.enabled;
  shader.vertexShader = `attribute vec2 cs2LightUv; uniform vec2 cs2SunUvScale; varying vec2 vCs2LightUv;\n${shader.vertexShader}`;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <uv_vertex>',
    '#include <uv_vertex>\nvCs2LightUv = cs2LightUv * cs2SunUvScale;',
  );
  shader.fragmentShader = `uniform sampler2D cs2SunShadow; uniform float cs2SunEnabled; varying vec2 vCs2LightUv;\n${shader.fragmentShader}`;
  const lights = ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
    #if ( UNROLLED_LOOP_INDEX == 0 )
      directLight.color *= mix(1.0, clamp(1.0 - texture2D(cs2SunShadow, vCs2LightUv).r, 0.0, 1.0), cs2SunEnabled);
    #endif`,
  );
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights);
}
