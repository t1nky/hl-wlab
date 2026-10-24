import {
  ClampToEdgeWrapping,
  CompressedTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  RepeatWrapping,
  RGB_S3TC_DXT1_Format,
  RGBA_BPTC_Format,
  SRGBColorSpace,
  type WebGLRenderer,
} from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RenderResources } from './render-resources';

export interface NativeTextureMetadata {
  schema: number;
  file: string;
  format: 'BC1_RGB' | 'BC7_RGBA';
  gpuBytes: number;
  levels: { width: number; height: number; offset: number; bytes: number }[];
}

/** Validate before allocation/decompression, including every authored mip and byte range. */
export function nativeTextureLayout(meta: NativeTextureMetadata) {
  if (
    meta.schema !== 1 ||
    !/^render\/native-[a-f0-9]{20}\.(bc1|bc7)\.gz$/.test(meta.file) ||
    !['BC1_RGB', 'BC7_RGBA'].includes(meta.format) ||
    !Array.isArray(meta.levels) ||
    !meta.levels.length ||
    meta.levels.length > 14
  )
    throw Error('Invalid native color texture');
  let bytes = 0;
  let width = meta.levels[0].width,
    height = meta.levels[0].height;
  if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= 8192))
    throw Error('Invalid native color dimensions');
  for (const [index, level] of meta.levels.entries()) {
    if (index > 0 && meta.levels[index - 1].width === 1 && meta.levels[index - 1].height === 1)
      throw Error('Duplicate native color mip');
    const size =
      Math.ceil(width / 4) * Math.ceil(height / 4) * (meta.format === 'BC1_RGB' ? 8 : 16);
    if (
      level.width !== width ||
      level.height !== height ||
      level.offset !== bytes ||
      level.bytes !== size
    )
      throw Error('Invalid native color mip');
    bytes += size;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
  if (bytes !== meta.gpuBytes || bytes > 96 * 1024 ** 2)
    throw Error('Invalid native color byte count');
  return bytes;
}

export async function readCompressedBlocks(url: string, size: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw Error('Missing native texture blocks');
  const bytes = new Uint8Array(size);
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let used = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > size - used) throw Error('Oversized native texture blocks');
      bytes.set(value, used);
      used += value.byteLength;
    }
    if (used !== size) throw Error('Truncated native texture blocks');
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function loadNativeTexture(
  meta: NativeTextureMetadata,
  base: string,
  version: string,
  signal: AbortSignal,
) {
  const bytes = await readCompressedBlocks(
    `${base}${meta.file}?v=${encodeURIComponent(version)}`,
    nativeTextureLayout(meta),
    signal,
  );
  signal.throwIfAborted();
  const mips = meta.levels.map((l) => ({
    width: l.width,
    height: l.height,
    data: bytes.subarray(l.offset, l.offset + l.bytes),
  }));
  const texture = new CompressedTexture(
    mips,
    mips[0].width,
    mips[0].height,
    meta.format === 'BC1_RGB' ? RGB_S3TC_DXT1_Format : RGBA_BPTC_Format,
  );
  texture.name = meta.file;
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const filters = {
  9728: NearestFilter,
  9729: LinearFilter,
  9984: NearestMipmapNearestFilter,
  9985: LinearMipmapNearestFilter,
  9986: NearestMipmapLinearFilter,
  9987: LinearMipmapLinearFilter,
};
const wrapping = {
  33071: ClampToEdgeWrapping,
  33648: MirroredRepeatWrapping,
  10497: RepeatWrapping,
};

/** The standard image dependency is never fetched/decoded when native blocks are supported. */
export function nativeTexturePlugin(
  parser: GLTFParser,
  renderer: WebGLRenderer | undefined,
  resources: RenderResources,
  base: string,
  version: string,
  signal: AbortSignal,
) {
  const pending = new Map<string, Promise<CompressedTexture>>();
  return {
    name: 'CS2_native_color',
    loadTexture(index: number) {
      const definition = parser.json.textures[index];
      const meta = definition.extras?.cs2Native as NativeTextureMetadata | undefined;
      if (
        !meta ||
        !renderer?.extensions.has(
          meta.format === 'BC1_RGB'
            ? 'WEBGL_compressed_texture_s3tc_srgb'
            : 'EXT_texture_compression_bptc',
        )
      )
        return null;
      // Equal blocks can represent differently shaped textures. Storage identity
      // alone must not alias their dimensions/mip layout or sampler interpretation.
      const key = JSON.stringify([meta.file, meta.format, meta.levels, definition.sampler]);
      let request = pending.get(key);
      if (!request) {
        request = loadNativeTexture(meta, base, version, signal).then((texture) => {
          resources.texture(texture);
          signal.throwIfAborted();
          const sampler = parser.json.samplers?.[definition.sampler] ?? {};
          texture.magFilter =
            filters[sampler.magFilter as keyof typeof filters] === NearestFilter
              ? NearestFilter
              : LinearFilter;
          texture.minFilter =
            filters[sampler.minFilter as keyof typeof filters] ?? LinearMipmapLinearFilter;
          texture.wrapS = wrapping[sampler.wrapS as keyof typeof wrapping] ?? RepeatWrapping;
          texture.wrapT = wrapping[sampler.wrapT as keyof typeof wrapping] ?? RepeatWrapping;
          const last = meta.levels.at(-1);
          if (meta.levels.length === 1 || last?.width !== 1 || last?.height !== 1)
            texture.minFilter = LinearFilter;
          parser.associations.set(texture, { textures: index });
          return texture;
        });
        pending.set(key, request);
      }
      return request;
    },
  };
}
