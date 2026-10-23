import type { ScanResult } from '../cs2/scan-parallel';
import type { Shot } from '../cs2/types';
import { CS2 } from '../src/games/contracts';
import { playerPose } from '../src/games/target';

interface BenchReply extends ScanResult {
  id: number;
  kind: string;
  tested: number;
  error?: string;
  ms: number;
  loadMs: number;
  buildMs: number;
  startupMs: number;
  workersUsed: number;
  sharedBytes: number;
  shot: Shot;
}

/** Dev-only actual module-worker wall-time harness; private data stays on loopback. */
export async function benchmarkScan(
  workers: number,
  report: (value: unknown) => void,
  workerUrl?: string,
) {
  const worker = new Worker(workerUrl ?? new URL('../cs2/worker.ts', import.meta.url), {
    type: 'module',
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: BenchReply) => void; reject: (error: Error) => void }
  >();
  let cells = 0,
    maxProgressGapMs = 0,
    lastProgress = performance.now();
  worker.onmessage = ({ data }) => {
    if (data.kind === 'progress') {
      if (data.tested < cells) throw Error('Regressing progress');
      cells = data.tested;
      maxProgressGapMs = Math.max(maxProgressGapMs, performance.now() - lastProgress);
      lastProgress = performance.now();
      return;
    }
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.kind === 'error') request?.reject(Error(data.error));
    else request?.resolve(data);
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(Error(event.message));
    pending.clear();
  };
  const call = (op: object) =>
    new Promise<BenchReply>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...op });
    });
  let frames = 0,
    maxFrameGapMs = 0,
    previousFrame = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    frames++;
    maxFrameGapMs = Math.max(maxFrameGapMs, now - previousFrame);
    previousFrame = now;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  try {
    const loadStart = performance.now();
    const load = await call({ op: 'load', includeBuffer: false });
    const loadWallMs = performance.now() - loadStart;
    const player = await (await fetch('/local/player.json')).json();
    const pose = playerPose(player, CS2.target.defaults.p, 0, 0, 0);
    const referenceResponse = await fetch('/benchmark-reference.f32');
    const reference = referenceResponse.ok
      ? new Uint8Array(await referenceResponse.arrayBuffer())
      : undefined;
    const request = {
      op: 'scan',
      target: pose.origin,
      pose,
      settings: { spacing: 16, radius: 2048, workers },
    };
    for (const cache of ['cold', 'warm']) {
      cells = 0;
      maxProgressGapMs = 0;
      lastProgress = performance.now();
      const start = performance.now();
      const result = await call(request);
      const wallMs = performance.now() - start;
      const bytes = new Uint8Array(
        result.rows.buffer,
        result.rows.byteOffset,
        result.rows.byteLength,
      );
      const byteParity = reference
        ? bytes.length === reference.length &&
          bytes.every((byte, index) => byte === reference[index])
        : undefined;
      if (byteParity === false) throw Error('Full result bytes differ from HEAD2438bab');
      const sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', result.rows)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      report({
        workers,
        cache,
        loadWallMs,
        loadMs: load.loadMs,
        buildMs: load.buildMs,
        wallMs,
        ms: result.ms,
        startupMs: result.startupMs,
        workersUsed: result.workersUsed,
        stats: result.stats,
        placementCache: result.placementCache,
        sha256,
        byteParity,
        maxProgressGapMs,
        frames,
        maxFrameGapMs,
        sharedBytes: load.sharedBytes,
      });
    }
    cells = 0;
    const scanning = call(request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const start = performance.now();
    await call({ op: 'cancel' });
    const acknowledgementMs = performance.now() - start;
    const cancelled = await scanning;
    report({
      workers,
      cancellation: {
        acknowledgementMs,
        completionMs: performance.now() - start,
        cancelled: cancelled.cancelled,
        stats: cancelled.stats,
      },
    });
    const trace = await call({ op: 'trace', source: [77.46, 1227.8, 156.9], target: pose.aims[1] });
    const walking = await call({ op: 'walk-start', eye: [77.46, 1227.8, 156.9] });
    const step = await call({
      op: 'walk-step',
      dt: 0.016,
      yaw: 0,
      input: { forward: 1, side: 0, duck: false, jump: false },
    });
    report({ workers, postCancelTrace: trace.shot.status, walking: walking.kind, step: step.kind });
  } finally {
    cancelAnimationFrame(raf);
    worker.terminate();
  }
}
