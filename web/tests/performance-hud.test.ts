import {
  BoxGeometry,
  CompressedTexture,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  RED_RGTC1_Format,
  RedFormat,
  RepeatWrapping,
  Texture,
} from 'three';
import { expect, it, vi } from 'vitest';
import { estimateSceneBytes, FrameMonitor, textureBytes } from '../src/render/performance';

function context(supported = true) {
  let available = false,
    disjoint = false,
    lost = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: vi.fn(() => (supported ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null)),
    isContextLost: () => lost,
    createQuery: vi.fn(() => ({})),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    deleteQuery: vi.fn(),
    getParameter: () => disjoint,
    getQueryParameter: vi.fn((_query: unknown, field: number) =>
      field === 1 ? available : 2_500_000,
    ),
  };
  return {
    gl,
    monitor: new FrameMonitor(gl as unknown as WebGL2RenderingContext),
    ready: () => {
      available = true;
    },
    disjoint: () => {
      disjoint = true;
    },
    lost: (value: boolean) => {
      lost = value;
    },
  };
}

it('counts actual rendered frames and CPU time without making idle work', () => {
  const { gl, monitor } = context(false);
  monitor.setEnabled(true, 0);
  for (let i = 0; i < 60; i++) {
    monitor.beginFrame((i * 1000) / 60);
    monitor.endFrame(2);
  }
  expect(monitor.sample(1000)).toEqual({ fps: 60, cpuMs: 2, gpuMs: undefined });
  expect(monitor.sample(2000)).toEqual({ fps: 0, cpuMs: undefined, gpuMs: undefined });
  expect(gl.createQuery).not.toHaveBeenCalled();
  monitor.setEnabled(false, 2000);
  monitor.beginFrame(2100);
  monitor.endFrame(100);
  expect(monitor.sample(3000).fps).toBe(0);
});

it('does not turn 60 FPS into 30 when movement starts halfway through a HUD interval', () => {
  const { monitor } = context(false);
  monitor.setEnabled(true, 0);
  for (let i = 0; i < 15; i++) {
    monitor.beginFrame(250 + (i * 1000) / 60);
    monitor.endFrame(1);
  }
  expect(monitor.sample(500).fps).toBeCloseTo(60);
  expect(monitor.sample(1000).fps).toBe(0);
  for (let i = 0; i < 15; i++) {
    monitor.beginFrame(1250 + (i * 1000) / 60);
    monitor.endFrame(1);
  }
  expect(monitor.sample(1500).fps).toBeCloseTo(60);
});

it('includes actual stalls between rendered frames in the FPS reading', () => {
  const { monitor } = context(false);
  monitor.setEnabled(true, 0);
  for (const at of [0, 1000 / 60, 1000 / 30, 100, 100 + 1000 / 60]) {
    monitor.beginFrame(at);
    monitor.endFrame(1);
  }
  expect(monitor.sample(500).fps).toBeCloseTo(4000 / (100 + 1000 / 60));
});

it('reads GPU results only after completion, converts nanoseconds, and rejects disjoint results', () => {
  const state = context();
  state.monitor.setEnabled(true, 0);
  state.monitor.beginFrame(0);
  state.monitor.endFrame(1);
  expect(state.monitor.sample(500).gpuMs).toBeUndefined();
  expect(state.gl.getQueryParameter.mock.calls).toEqual([[expect.any(Object), 1]]);
  state.ready();
  state.monitor.beginFrame(600);
  state.monitor.endFrame(1);
  expect(state.monitor.sample(1000).gpuMs).toBe(2.5);
  expect(state.gl.deleteQuery).toHaveBeenCalledTimes(2);
  state.monitor.beginFrame(1100);
  state.monitor.endFrame(1);
  state.disjoint();
  expect(state.monitor.sample(1500).gpuMs).toBeUndefined();
  expect(state.gl.deleteQuery).toHaveBeenCalledTimes(3);
});

it('bounds outstanding queries, rate-limits sampling and releases work when disabled', () => {
  const { gl, monitor } = context();
  monitor.setEnabled(true, 0);
  for (let i = 0; i < 80; i++) {
    monitor.beginFrame(i * 16);
    monitor.endFrame(1);
  }
  expect(gl.createQuery).toHaveBeenCalledTimes(4);
  monitor.setEnabled(false, 2000);
  expect(gl.deleteQuery).toHaveBeenCalledTimes(4);
  monitor.beginFrame(2500);
  expect(gl.createQuery).toHaveBeenCalledTimes(4);
});

it('does not use lost-context query objects after restoration', () => {
  const state = context();
  state.monitor.setEnabled(true, 0);
  state.monitor.beginFrame(0);
  state.monitor.endFrame(1);
  state.lost(true);
  state.monitor.contextLost();
  state.lost(false);
  state.monitor.contextChanged(1000);
  expect(state.gl.deleteQuery).not.toHaveBeenCalled();
  expect(state.gl.getExtension).toHaveBeenCalledTimes(2);
  state.monitor.beginFrame(1000);
  state.monitor.endFrame(1);
  state.ready();
  expect(state.monitor.sample(1500).gpuMs).toBe(2.5);
  expect(state.gl.deleteQuery).toHaveBeenCalledTimes(1);
});

it('counts native compressed and single-channel storage rather than decoded RGBA', () => {
  const compressed = new CompressedTexture(
    [{ data: new Uint8Array(8), width: 4, height: 4 }],
    4,
    4,
    RED_RGTC1_Format,
  );
  expect(textureBytes(compressed)).toBe(8);
  const mask = new DataTexture(new Uint8Array(12), 3, 4, RedFormat);
  expect(textureBytes(mask)).toBe(12);
  const image = new Texture({ width: 4, height: 2 } as TexImageSource);
  expect(textureBytes(image)).toBe(32 + 8 + 4);
});

it('deduplicates shared geometry/UV texture clones while retaining hidden maps and GPU variants', () => {
  const group = new Group();
  const geometry = new BoxGeometry();
  const texture = new DataTexture(new Uint8Array(16), 2, 2);
  const clone = texture.clone();
  const first = new MeshBasicMaterial({ map: texture });
  first.userData.texture = texture;
  const second = new MeshBasicMaterial({ map: clone });
  group.add(new Mesh(geometry, first), new Mesh(geometry, second));
  const geometryBytes =
    Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) +
    (geometry.index?.array.byteLength ?? 0);
  expect(estimateSceneBytes(group)).toBe(geometryBytes + 16);
  first.map = null;
  expect(estimateSceneBytes(group)).toBe(geometryBytes + 16);
  clone.wrapS = RepeatWrapping;
  expect(estimateSceneBytes(group)).toBe(geometryBytes + 32);
  group.userData.cs2MaskTextures = new Set([texture]);
  second.userData.cs2Masks = [texture, texture];
  expect(estimateSceneBytes(group)).toBe(geometryBytes + 32);
});
