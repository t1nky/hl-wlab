import {
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  type Texture,
  UnsignedByteType,
} from 'three';

export interface Cs2Mask {
  file: string;
  width: number;
  height: number;
  format: string;
  gpuBytes: number;
  bytes: number;
}

/** Exact height-green bytes, uploaded as one R8 channel without bitmap decode/readback. */
export async function loadMaterialMask(
  metadata: Cs2Mask,
  version: string,
  signal?: AbortSignal,
): Promise<Texture> {
  if (
    metadata.format !== 'R8_UNORM' ||
    !/^render\/mask-[a-f0-9]{20}\.r8\.gz$/.test(metadata.file) ||
    ![metadata.width, metadata.height].every((v) => Number.isInteger(v) && v > 0 && v <= 4096) ||
    metadata.gpuBytes !== metadata.width * metadata.height ||
    metadata.bytes <= 0 ||
    metadata.bytes > metadata.gpuBytes + 1024
  )
    throw Error('Unsupported material mask');
  signal?.throwIfAborted();
  const response = await fetch(`/local/${metadata.file}?v=${encodeURIComponent(version)}`, {
    signal,
  });
  if (!response.ok || !response.body) throw Error('Missing material mask');
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
      if (value.byteLength > bytes.byteLength - used) throw Error('Oversized material mask');
      bytes.set(value, used);
      used += value.byteLength;
    }
    if (used !== bytes.byteLength) throw Error('Truncated material mask');
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const texture = new DataTexture(
    bytes,
    metadata.width,
    metadata.height,
    RedFormat,
    UnsignedByteType,
  );
  texture.name = metadata.file;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
