import { gzipSync } from 'node:zlib';
import { LinearFilter, NoColorSpace, RedFormat, RepeatWrapping } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { type Cs2Mask, loadMaterialMask } from '../cs2/render-masks';

afterEach(() => vi.unstubAllGlobals());
const metadata: Cs2Mask = {
  file: 'render/mask-0123456789abcdef0123.r8.gz',
  width: 2,
  height: 2,
  format: 'R8_UNORM',
  gpuBytes: 4,
  bytes: 24,
};

it('uploads exact scalar mask bytes as R8 without color conversion, flips or bitmap readback', async () => {
  const bytes = new Uint8Array([0, 64, 128, 255]);
  vi.stubGlobal('fetch', async () => new Response(gzipSync(bytes)));
  const texture = await loadMaterialMask(metadata, 'test');
  expect(texture.image.data).toEqual(bytes);
  expect(texture.format).toBe(RedFormat);
  expect(texture.colorSpace).toBe(NoColorSpace);
  expect(texture.flipY).toBe(false);
  expect(texture.generateMipmaps).toBe(false);
  expect(texture.minFilter).toBe(LinearFilter);
  expect(texture.wrapS).toBe(RepeatWrapping);
  texture.dispose();
});

it('bounds gzip output, validates dimensions/path and aborts before fetching', async () => {
  for (const [bytes, message] of [
    [new Uint8Array(3), 'Truncated'],
    [new Uint8Array(1024), 'Oversized'],
  ] as const) {
    vi.stubGlobal('fetch', async () => new Response(gzipSync(bytes)));
    await expect(loadMaterialMask(metadata, '')).rejects.toThrow(message);
  }
  await expect(loadMaterialMask({ ...metadata, gpuBytes: 5 }, '')).rejects.toThrow('Unsupported');
  await expect(loadMaterialMask({ ...metadata, file: '../mask.r8.gz' }, '')).rejects.toThrow(
    'Unsupported',
  );
  const abort = new AbortController();
  abort.abort();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(loadMaterialMask(metadata, '', abort.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
