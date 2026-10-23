import { Group } from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeRenderViews } from '../cs2/render-decode';
import * as renderMap from '../cs2/render-map';
import type { Pose } from '../src/engine/types';
import { Cs2Game } from '../src/games/cs2';
import { GoldsrcAnalysis } from '../src/games/goldsrc';
import type { TargetPose } from '../src/games/target';

class MockWorker {
  static instances: MockWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: { id?: number; op?: string }[] = [];
  postMessage = vi.fn((value) => {
    if (MockWorker.failPost) throw new DOMException('Cannot clone message', 'DataCloneError');
    this.messages.push(value);
  });
  terminate = vi.fn();
  constructor() {
    MockWorker.instances.push(this);
  }
  reply(data: object) {
    this.onmessage?.({ data: { id: this.messages.at(-1)?.id, ...data } } as MessageEvent);
  }
}
const target: TargetPose = {
  origin: [0, 0, 0],
  aims: [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  shapes: [],
  label: 'test',
};
beforeEach(() => {
  MockWorker.instances = [];
  MockWorker.failPost = false;
  vi.stubGlobal('Worker', MockWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('terminates a render worker and clears handlers when cloning or decoding a message fails', async () => {
  MockWorker.failPost = true;
  await expect(decodeRenderViews([], [], '', '')).rejects.toThrow('Cannot clone');
  const first = MockWorker.instances[0];
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(first.onmessage).toBeNull();
  MockWorker.failPost = false;
  const pending = decodeRenderViews([], [], '', '');
  const second = MockWorker.instances[1];
  second.onmessageerror?.({} as MessageEvent);
  await expect(pending).rejects.toThrow('could not be decoded');
  expect(second.terminate).toHaveBeenCalledOnce();
  expect(second.onmessageerror).toBeNull();
});

it('does not resurrect scan rows from a reply settled just before map disposal', async () => {
  const game = new Cs2Game(vi.fn(), vi.fn());
  game.targetPose = target;
  const scanned = game.scan({ spacing: 64, radius: 128, workers: 1 }, vi.fn());
  const worker = MockWorker.instances[0];
  worker.reply({ kind: 'scan', rows: new Float32Array(17), stats: {} });
  game.dispose();
  await expect(scanned).rejects.toThrow();
  expect(game.rows).toHaveLength(0);
  expect(game.render).toBeUndefined();
  expect(worker.onmessage).toBeNull();
  game.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects a load and releases its worker when a CS2 reply cannot be decoded', async () => {
  const game = new Cs2Game(vi.fn(), vi.fn());
  const loading = game.load(vi.fn());
  const worker = MockWorker.instances[0];
  worker.onmessageerror?.({} as MessageEvent);
  await expect(loading).rejects.toThrow('could not be decoded');
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessageerror).toBeNull();
});

it('disposes a render load that finishes after its game was closed', async () => {
  let resolve!: (map: renderMap.RenderMap) => void;
  const pending = new Promise<renderMap.RenderMap>((done) => {
    resolve = done;
  });
  const load = vi.spyOn(renderMap, 'loadRenderMap').mockReturnValue(pending);
  vi.stubGlobal('fetch', async () => Response.json({ steamInf: 'test' }));
  const game = new Cs2Game(vi.fn(), vi.fn());
  const loading = game.load(vi.fn());
  MockWorker.instances[0].reply({ kind: 'ready', meta: { steamInf: 'test', spawns: [] } });
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  game.dispose();
  const dispose = vi.fn();
  resolve({ group: new Group(), dispose, metadata: {} as renderMap.RenderMetadata });
  await expect(loading).rejects.toThrow('closed');
  expect(dispose).toHaveBeenCalledOnce();
  expect(game.render).toBeUndefined();
  expect(game.group.children).toHaveLength(0);
});

it('cleans up a GoldSrc worker after cancellation and a synchronous posting failure', async () => {
  const context = (() => ({
    assets: { map: new ArrayBuffer(4), materials: '' },
    bsp: { brushes: [] },
    modelHash: 'test',
    weapon: 'awp',
  })) as unknown as ConstructorParameters<typeof GoldsrcAnalysis>[0];
  const game = new GoldsrcAnalysis(context);
  game.nativePose = {} as Pose;
  game.targetPose = target;
  const settings = { spacing: 64, radius: 128, workers: 1 };
  MockWorker.failPost = true;
  await expect(game.scan(settings, vi.fn())).rejects.toThrow('Cannot clone');
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
  MockWorker.failPost = false;
  const scanning = game.scan(settings, vi.fn());
  const worker = MockWorker.instances[1];
  game.cancel();
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel' });
  worker.reply({ type: 'complete', cancelled: true, rows: new Float32Array(), done: 0, total: 1 });
  await expect(scanning).resolves.toMatchObject({ cancelled: true });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
});
