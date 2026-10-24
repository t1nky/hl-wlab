import type { Object3D, WebGLRenderer } from 'three';
import { FrameDiagnostics, type SlowFrame } from '../render/frame-diagnostics';
import { estimateSceneBytes, FrameMonitor } from '../render/performance';
import './performance.css';

const memory = (bytes?: number) =>
  bytes === undefined
    ? '—'
    : bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
      : `${Math.round(bytes / 1024 ** 2)} MiB`;
const milliseconds = (value?: number) => (value === undefined ? '—' : `${value.toFixed(1)} ms`);

export function createPerformanceHUD(
  renderer: WebGLRenderer,
  scene: Object3D,
  viewport: HTMLElement,
  context: () => Record<string, unknown> = () => ({}),
) {
  const panel = document.createElement('dl');
  panel.id = 'performanceHud';
  panel.className = 'performance-hud';
  panel.setAttribute('aria-label', 'Performance');
  panel.hidden = true;
  const values = new Map<string, HTMLElement>();
  const labels = new Map<string, HTMLElement>();
  for (const [id, label, title] of [
    ['fps', 'FPS', 'Rendered frame cadence. Static views sleep instead of redrawing.'],
    [
      'cpu',
      'CPU',
      'Main-thread render submission time per frame; last sample while idle. Not system or scan-worker CPU usage.',
    ],
    [
      'gpu',
      'GPU',
      'GPU frame time from asynchronous WebGL timer queries; last sample while idle. — if unavailable.',
    ],
    [
      'ram',
      'RAM (JS)',
      'JavaScript heap only, if exposed by this browser. Excludes native/worker memory and is not total process RAM.',
    ],
    [
      'vram',
      'VRAM ≈',
      'Loaded scene geometry and texture storage estimate. Actual driver allocation, framebuffers and other applications are excluded.',
    ],
  ]) {
    const term = document.createElement('dt');
    term.textContent = label;
    term.title = title;
    labels.set(id, term);
    const value = document.createElement('dd');
    value.textContent = '—';
    value.dataset.metric = id;
    value.title = title;
    values.set(id, value);
    panel.append(term, value);
  }
  viewport.append(panel);
  // Three r170 requires WebGL2; its type retains the older context union.
  const monitor = new FrameMonitor(renderer.getContext() as WebGL2RenderingContext);
  let enabled = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let memoryAt = -Infinity,
    graphicsBytes = 0;
  let lastCpu: number | undefined, lastGpu: number | undefined;
  const diagnostics = new FrameDiagnostics();
  let gpuSampleAt = -Infinity;
  let lastWarningAt = -Infinity,
    lastIdleInfoAt = -Infinity;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingWarning:
    | {
        firstAt: number;
        lastAt: number;
        count: number;
        worst: SlowFrame;
        details: Record<string, unknown>;
      }
    | undefined;
  const details = () => ({
    ...context(),
    pageVisible: !document.hidden,
    pageFocused: document.hasFocus(),
    draws: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    size: [renderer.domElement.width, renderer.domElement.height],
    gpuLastMs: lastGpu,
    gpuSampleAgeMs: lastGpu === undefined ? undefined : performance.now() - gpuSampleAt,
    jsHeapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      ?.usedJSHeapSize,
    sceneGpuBytesEstimate: graphicsBytes || undefined,
    activity: diagnostics.activity(),
  });
  const severity = (frame: SlowFrame) =>
    Math.max(frame.gapMs ?? 0, frame.queueMs, frame.frameCpuMs, frame.cpuMs);
  function warn(frame: SlowFrame) {
    const now = performance.now();
    if (now - lastWarningAt >= 1000 && !pendingWarning) {
      console.warn('[Wallbang performance] slow frame', { count: 1, ...frame, ...details() });
      lastWarningAt = now;
      return;
    }
    if (!pendingWarning)
      pendingWarning = {
        firstAt: frame.at,
        lastAt: frame.at,
        count: 0,
        worst: frame,
        details: details(),
      };
    pendingWarning.count++;
    pendingWarning.lastAt = frame.at;
    if (severity(frame) > severity(pendingWarning.worst)) {
      pendingWarning.worst = frame;
      pendingWarning.details = details();
    }
    warningTimer ??= setTimeout(
      () => {
        warningTimer = undefined;
        if (!pendingWarning) return;
        console.warn('[Wallbang performance] slow frames', {
          ...pendingWarning.worst,
          firstAt: pendingWarning.firstAt,
          lastAt: pendingWarning.lastAt,
          count: pendingWarning.count,
          ...pendingWarning.details,
        });
        pendingWarning = undefined;
        lastWarningAt = performance.now();
      },
      Math.max(0, 1000 - (now - lastWarningAt)),
    );
  }
  function resetDiagnostics() {
    diagnostics.reset();
    clearTimeout(warningTimer);
    warningTimer = pendingWarning = undefined;
  }
  const text = (key: string, text: string) => {
    const value = values.get(key);
    if (value && value.textContent !== text) value.textContent = text;
  };
  function refresh() {
    const now = performance.now();
    const frame = monitor.sample(now);
    if (frame.cpuMs !== undefined) {
      lastCpu = frame.cpuMs;
      lastGpu = frame.gpuMs;
    } else if (frame.gpuMs !== undefined) lastGpu = frame.gpuMs;
    if (frame.gpuSampleAt !== undefined) gpuSampleAt = frame.gpuSampleAt;
    if (
      frame.idleBreaks &&
      frame.spanFps !== undefined &&
      frame.spanFps < 55 &&
      frame.fps >= 55 &&
      now - lastIdleInfoAt >= 1000
    ) {
      console.info('[Wallbang performance] idle gap excluded from FPS', {
        spanFps: frame.spanFps,
        activeFps: frame.fps,
        frames: frame.frames,
        idleBreaks: frame.idleBreaks,
        ...details(),
      });
      lastIdleInfoAt = now;
    }
    text('fps', frame.fps ? String(Math.round(frame.fps)) : 'Idle');
    const cpuLabel = labels.get('cpu'),
      gpuLabel = labels.get('gpu');
    if (cpuLabel) cpuLabel.textContent = !frame.fps && lastCpu !== undefined ? 'CPU (last)' : 'CPU';
    if (gpuLabel) gpuLabel.textContent = !frame.fps && lastGpu !== undefined ? 'GPU (last)' : 'GPU';
    text('cpu', milliseconds(lastCpu));
    text('gpu', milliseconds(lastGpu));
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    text(
      'ram',
      memory(heap && Number.isFinite(heap.usedJSHeapSize) ? heap.usedJSHeapSize : undefined),
    );
    if (now - memoryAt >= 2000) {
      graphicsBytes = estimateSceneBytes(scene);
      memoryAt = now;
    }
    text('vram', memory(graphicsBytes));
  }
  function resume() {
    clearInterval(interval);
    interval = undefined;
    const active = enabled && !document.hidden;
    monitor.setEnabled(active, performance.now());
    lastCpu = lastGpu = undefined;
    if (active) {
      memoryAt = -Infinity;
      refresh();
      interval = setInterval(refresh, 500);
    }
  }
  const visibility = () => {
    resetDiagnostics();
    resume();
  };
  const restored = () => {
    resetDiagnostics();
    monitor.contextChanged(performance.now());
  };
  const lost = () => {
    resetDiagnostics();
    monitor.contextLost();
  };
  document.addEventListener('visibilitychange', visibility);
  renderer.domElement.addEventListener('webglcontextlost', lost);
  renderer.domElement.addEventListener('webglcontextrestored', restored);
  return {
    requestFrame(now: number) {
      monitor.requestFrame(now);
      if (!document.hidden) diagnostics.request(now);
    },
    frameStarted(now: number) {
      if (!document.hidden) diagnostics.begin(now);
    },
    frameEnded(now: number, cpuMs: number, queued: boolean) {
      if (document.hidden) return;
      const slow = diagnostics.end(now, cpuMs);
      if (slow) warn(slow);
      if (!queued) monitor.idle(now);
    },
    beginFrame: (now: number) => monitor.beginFrame(now),
    endFrame: (cpuMs: number) => monitor.endFrame(cpuMs),
    setEnabled(value: boolean) {
      enabled = value;
      panel.hidden = !value;
      resume();
    },
    dispose() {
      resetDiagnostics();
      clearInterval(interval);
      monitor.setEnabled(false, performance.now());
      document.removeEventListener('visibilitychange', visibility);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      panel.remove();
    },
  };
}
