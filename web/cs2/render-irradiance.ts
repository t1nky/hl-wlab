import {
  ClampToEdgeWrapping,
  CompressedTexture,
  LinearFilter,
  NoColorSpace,
  RGB_BPTC_UNSIGNED_Format,
  type Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import type { SunLighting } from './render-sun';

export interface IrradianceMetadata {
  schema: number;
  file: string;
  format: string;
  width: number;
  height: number;
  gpuBytes: number;
  uvScale: [number, number];
  slice: number;
  sourceMip: number;
  flipY: boolean;
}

export interface IrradianceLighting {
  texture: Texture;
  scale: Vector2;
  status?: 'pending' | 'active' | 'unsupported';
}

/** Keep the source-authored lower mip in GPU-native HDR blocks: 16 MiB, no bitmap decode. */
export async function loadIrradiance(
  metadata: IrradianceMetadata,
  version: string,
  signal?: AbortSignal,
  base = '/local/',
): Promise<IrradianceLighting> {
  if (
    metadata.schema !== 1 ||
    metadata.format !== 'BC6H_UFLOAT' ||
    !Number.isInteger(metadata.sourceMip) ||
    metadata.sourceMip < 0 ||
    metadata.sourceMip > 15 ||
    metadata.slice !== 0 ||
    metadata.flipY !== false ||
    !/^render\/[a-zA-Z0-9_.-]+\.bc6h\.gz$/.test(metadata.file) ||
    ![metadata.width, metadata.height].every(
      (n) => Number.isInteger(n) && n >= 4 && n <= 16384 && n % 4 === 0,
    ) ||
    metadata.gpuBytes !== metadata.width * metadata.height ||
    metadata.gpuBytes > 4096 * 4096 ||
    !Array.isArray(metadata.uvScale) ||
    metadata.uvScale.length !== 2 ||
    !metadata.uvScale.every((v) => Number.isFinite(v) && v > 0)
  )
    throw Error('Unsupported diffuse irradiance atlas');
  signal?.throwIfAborted();
  const response = await fetch(`${base}${metadata.file}?v=${encodeURIComponent(version)}`, {
    signal,
  });
  signal?.throwIfAborted();
  if (!response.ok || !response.body) throw Error('Missing diffuse irradiance atlas');
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
        throw Error('Oversized diffuse irradiance atlas');
      bytes.set(value, used);
      used += value.byteLength;
    }
    if (used !== bytes.byteLength) throw Error('Truncated diffuse irradiance atlas');
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
    RGB_BPTC_UNSIGNED_Format,
  );
  texture.name = `CS2 authored diffuse irradiance mip${metadata.sourceMip} (BC6H unsigned)`;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, scale: new Vector2(...metadata.uvScale), status: 'pending' };
}

/** Source indirect is a diffuse multiplier; Three's Lambert divides irradiance by PI.
 * No normal maps/specular are exported, so directional irradiance is not sampled.
 * Disabling baked shading restores hemisphere lighting through the existing sun toggle.
 */
export function patchIrradiance(
  shader: WebGLProgramParametersWithUniforms,
  sun: SunLighting & { irradiance?: IrradianceLighting },
  renderer: WebGLRenderer,
) {
  const irradiance = sun.irradiance;
  if (!irradiance) return;
  if (
    !renderer.extensions.has('EXT_texture_compression_bptc') ||
    renderer.capabilities.maxTextureSize <
      Math.max(irradiance.texture.image.width, irradiance.texture.image.height)
  ) {
    irradiance.status = 'unsupported';
    return;
  }
  if (!irradiance.scale.equals(sun.scale)) throw Error('Mismatched irradiance lightmap UV scale');
  irradiance.status = 'active';
  shader.uniforms.cs2Irradiance = { value: irradiance.texture };
  shader.uniforms.cs2IrradianceEnabled = sun.enabled;
  // BPTC can be supported even if the independent BC4 sun patch fell back.
  if (!shader.vertexShader.includes('varying vec2 vCs2LightUv;')) {
    shader.uniforms.cs2SunUvScale = { value: sun.scale };
    shader.vertexShader = `attribute vec2 cs2LightUv; uniform vec2 cs2SunUvScale; varying vec2 vCs2LightUv;\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvCs2LightUv = cs2LightUv * cs2SunUvScale;',
    );
    shader.fragmentShader = `varying vec2 vCs2LightUv;\n${shader.fragmentShader}`;
  }
  shader.fragmentShader = `uniform sampler2D cs2Irradiance; uniform float cs2IrradianceEnabled;\n${shader.fragmentShader}`;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_end>',
    `irradiance = mix(irradiance, PI * texture2D(cs2Irradiance, vCs2LightUv).rgb, cs2IrradianceEnabled);\n#include <lights_fragment_end>`,
  );
}
