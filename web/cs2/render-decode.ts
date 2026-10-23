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
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      worker.terminate();
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      signal?.removeEventListener('abort', abort);
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      reject(signal?.reason ?? new DOMException('Map loading aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (!finish()) return;
      if (data.error) reject(Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      if (!finish()) return;
      reject(Error(event.message || 'Render geometry decoding failed'));
    };
    worker.onmessageerror = () => {
      if (finish()) reject(Error('Render geometry message could not be decoded'));
    };
    if (signal?.aborted) return abort();
    try {
      worker.postMessage({ buffers, views, base, version });
    } catch (error) {
      if (finish()) reject(error);
    }
  });
}
