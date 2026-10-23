import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { type CompressedRenderView, streamRenderViews } from './render-stream';

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      buffers: { uri?: string; byteLength: number }[];
      views: CompressedRenderView[];
      base: string;
      version: string;
    }>,
  ) => void;
  postMessage(value: unknown, transfer: Transferable[]): void;
};

// One transfer per chunk replaces tens of thousands of per-accessor worker messages.
// Compressed bytes never enter the main thread, and terminate() releases WASM scratch memory.
scope.onmessage = async ({ data }) => {
  try {
    const needed = new Set(data.views.map((v) => v.extensions.EXT_meshopt_compression.buffer));
    const views: ArrayBuffer[] = new Array(data.views.length);
    let fetchMs = 0,
      decodeMs = 0,
      compressedBytes = 0,
      compressedTransferBytes = 0,
      compressedStagingBytes = 0;
    await MeshoptDecoder.ready;
    // Bound compressed staging even if a later exporter emits several buffers.
    for (const index of needed) {
      const uri = data.buffers[index]?.uri;
      if (!uri || !/^[a-zA-Z0-9_.-]+\.bin$/.test(uri)) throw Error('Invalid render buffer path');
      const url = new URL(uri, data.base);
      url.searchParams.set('v', data.version);
      const fetchStart = performance.now();
      const response = await fetch(url);
      fetchMs += performance.now() - fetchStart;
      if (!response.ok) throw Error(`Render geometry request failed (${response.status})`);
      const entries = data.views
        .map((view, i): [number, CompressedRenderView] => [i, view])
        .filter(([, view]) => view.extensions.EXT_meshopt_compression.buffer === index);
      const streamed = await streamRenderViews(response, entries, (target, source, view) => {
        const extension = view.extensions.EXT_meshopt_compression;
        MeshoptDecoder.decodeGltfBuffer(
          target,
          extension.count,
          extension.byteStride,
          source,
          extension.mode,
          extension.filter,
        );
      });
      if (streamed.compressedBytes !== data.buffers[index].byteLength)
        throw Error('Render buffer length mismatch');
      for (const [i, buffer] of streamed.results) views[i] = buffer;
      fetchMs += streamed.fetchMs;
      decodeMs += streamed.decodeMs;
      compressedBytes += streamed.compressedBytes;
      const resource = performance.getEntriesByName(url.href).at(-1) as
        | PerformanceResourceTiming
        | undefined;
      compressedTransferBytes += resource?.transferSize ?? 0;
      compressedStagingBytes = Math.max(compressedStagingBytes, streamed.compressedStagingBytes);
    }
    scope.postMessage(
      {
        views,
        timings: {
          fetchMs,
          decodeMs,
          compressedBytes,
          compressedTransferBytes,
          compressedStagingBytes,
          decodedBytes: views.reduce((sum, b) => sum + b.byteLength, 0),
          viewCount: views.length,
        },
      },
      views,
    );
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  }
};
