export interface RenderDecodeTimings {
  fetchMs: number;
  decodeMs: number;
  compressedBytes: number;
  compressedTransferBytes: number;
  decodedBytes: number;
  viewCount: number;
  compressedStagingBytes: number;
}

export function decodeRenderViews(
  buffers: unknown[],
  views: unknown[],
  base: string,
  version: string,
  signal?: AbortSignal,
): Promise<{ views: ArrayBuffer[]; timings: RenderDecodeTimings }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./render-decode-worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(signal?.reason ?? new DOMException('Map loading aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      finish();
      reject(Error(event.message || 'Render geometry decoding failed'));
    };
    worker.postMessage({ buffers, views, base, version });
  });
}
