export interface CompressedRenderView {
  byteLength: number;
  extensions: {
    EXT_meshopt_compression: {
      buffer: number;
      byteOffset?: number;
      byteLength: number;
      count: number;
      byteStride: number;
      mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
      filter?: 'NONE';
    };
  };
}

/** Decode the packed export in file order, retaining only the largest compressed view.
 * Browser networking can fill the next chunk while this worker decodes the current one. */
export async function streamRenderViews(
  response: Response,
  entries: [number, CompressedRenderView][],
  decode: (target: Uint8Array, source: Uint8Array, view: CompressedRenderView) => void,
) {
  const sorted = [...entries].sort(
    (a, b) =>
      (a[1].extensions.EXT_meshopt_compression.byteOffset ?? 0) -
      (b[1].extensions.EXT_meshopt_compression.byteOffset ?? 0),
  );
  let previousEnd = 0,
    scratchBytes = 0;
  for (const [, view] of sorted) {
    const extension = view.extensions.EXT_meshopt_compression;
    const start = extension.byteOffset ?? 0;
    if (
      !Number.isSafeInteger(view.byteLength) ||
      view.byteLength <= 0 ||
      !Number.isSafeInteger(extension.byteLength) ||
      extension.byteLength <= 0 ||
      !Number.isSafeInteger(start) ||
      start < previousEnd ||
      extension.count * extension.byteStride !== view.byteLength
    )
      throw Error('Invalid compressed render view');
    previousEnd = start + extension.byteLength;
    scratchBytes = Math.max(scratchBytes, extension.byteLength);
  }
  if (!response.body) throw Error('Missing render geometry response body');
  const reader = response.body.getReader();
  const scratch = new Uint8Array(scratchBytes);
  const results = new Map<number, ArrayBuffer>();
  let offset = 0,
    next = 0,
    filled = 0,
    fetchMs = 0,
    decodeMs = 0,
    maxChunkBytes = 0;
  try {
    while (true) {
      const wait = performance.now();
      const { done, value: chunk } = await reader.read();
      fetchMs += performance.now() - wait;
      if (done) break;
      maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
      const end = offset + chunk.byteLength;
      while (next < sorted.length) {
        const [index, view] = sorted[next];
        const extension = view.extensions.EXT_meshopt_compression;
        const start = (extension.byteOffset ?? 0) + filled;
        if (start >= end) break;
        const length = Math.min(end - start, extension.byteLength - filled);
        scratch.set(chunk.subarray(start - offset, start - offset + length), filled);
        filled += length;
        if (filled < extension.byteLength) break;
        const target = new Uint8Array(view.byteLength);
        const timer = performance.now();
        decode(target, scratch.subarray(0, filled), view);
        decodeMs += performance.now() - timer;
        results.set(index, target.buffer);
        filled = 0;
        next++;
      }
      offset = end;
    }
    if (next !== sorted.length) throw Error('Truncated compressed render buffer');
    return {
      results,
      compressedBytes: offset,
      fetchMs,
      decodeMs,
      compressedStagingBytes: scratchBytes + maxChunkBytes,
    };
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
