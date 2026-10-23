import type { ScanSettings } from '../src/games/contracts';
import type { TargetPose } from '../src/games/target';
import { type CollisionCache, CollisionMap } from './collision';
import { WalkController, type WalkInput } from './movement';
import { CS2_ROW, type ScanStats, scanMap } from './scan';
import { decodeMap, type Metadata, type V3 } from './types';

type Request = { id: number } & (
  | { op: 'load'; includeBuffer?: boolean }
  | { op: 'trace'; source: V3; target: V3 }
  | { op: 'pick'; source: V3; direction: V3; maxZ: number }
  | { op: 'scan'; target: V3; settings?: ScanSettings; pose?: TargetPose }
  | { op: 'cancel' }
  | { op: 'walk-start'; eye: V3; crouched?: boolean }
  | { op: 'walk-reset' }
  | { op: 'walk-step'; dt: number; input: WalkInput; yaw: number }
);
let map: CollisionMap;
let walker: WalkController;
let walkEye: V3;
let cancelled = false;
let scanning = false;
const scope = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
function send(id: number, value: object) {
  scope.postMessage({ id, ...value });
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wallbang-cs2-poc', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('bvh');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readCache(key: string): Promise<CollisionCache | undefined> {
  try {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('bvh').objectStore('bvh').get(key);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  } catch {
    return undefined;
  }
}
async function saveCache(key: string, bvh: CollisionCache) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('bvh', 'readwrite');
      const store = tx.objectStore('bvh');
      store.clear();
      store.put(bvh, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function load(id: number, includeBuffer = true) {
  const start = performance.now();
  const response = await fetch('/local/map.json');
  if (!response.ok) throw Error('Prepare the installed map first: bun run cs2:prepare');
  const meta: Metadata = await response.json();
  if (meta.schema !== 1) throw Error('Unsupported map package schema');
  const binary = await fetch(`/local/map.cs2map?v=${meta.fingerprint}`);
  if (!binary.ok) throw Error('Map collision data unavailable');
  const buffer = await binary.arrayBuffer();
  const fetchMs = performance.now() - start;
  const hashStart = performance.now();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== meta.binarySha256) throw Error('Collision package hash mismatch; prepare again');
  const hashMs = performance.now() - hashStart;
  const cacheKey = `three0.170-bvh0.9.8-slim1-${hash}`;
  const cacheStart = performance.now();
  let cached = await readCache(cacheKey);
  const cacheReadMs = performance.now() - cacheStart;
  const buildStart = performance.now();
  try {
    map = new CollisionMap(decodeMap(buffer), meta, cached);
  } catch (error) {
    if (!cached) throw error;
    cached = undefined;
    map = new CollisionMap(decodeMap(buffer), meta);
  }
  const buildMs = performance.now() - buildStart;
  walker = new WalkController(map);
  let cacheSaved = !!cached;
  const saveStart = performance.now();
  if (!cached) {
    try {
      // IndexedDB snapshots these buffers itself. Do not first clone another BVH and
      // the entire collision index; indirect BVHs restore against the package's index.
      await saveCache(cacheKey, map.cacheSnapshot());
      cacheSaved = true;
    } catch {
      /* Quota/private browsing must not prevent tracing. */
    }
  }
  const cacheWriteMs = performance.now() - saveStart;
  const transferStart = performance.now();
  const render = includeBuffer ? buffer.slice(0) : undefined;
  const transferCopyMs = performance.now() - transferStart;
  scope.postMessage(
    {
      id,
      kind: 'ready',
      meta,
      buffer: render,
      loadMs: performance.now() - start,
      buildMs,
      cached: !!cached,
      cacheSaved,
      timings: { fetchMs, hashMs, cacheReadMs, cacheWriteMs, transferCopyMs },
      collisionBytes: buffer.byteLength,
    },
    render ? [render] : [],
  );
}
async function scan(id: number, target: V3, settings?: ScanSettings, pose?: TargetPose) {
  if (scanning) throw Error('A scan is already running');
  scanning = true;
  cancelled = false;
  const start = performance.now();
  try {
    const result = await scanMap(
      map,
      { target, settings: settings ?? { spacing: 64, radius: 768, workers: 1 }, pose },
      (stats: ScanStats) =>
        send(id, { kind: 'progress', tested: stats.cells, total: stats.total, stats }),
      () => cancelled,
    );
    // Compatibility for the isolated diagnostic page; the shared UI uses compact typed rows.
    const points = pose
      ? undefined
      : Array.from({ length: result.rows.length / CS2_ROW }, (_, i) => {
          const r = result.rows.subarray(i * CS2_ROW, (i + 1) * CS2_ROW);
          return {
            source: [r[1], r[2], r[4]],
            damage: r[5] < 0 ? null : r[5],
            status: ['clear', 'estimated-penetration', 'blocked', 'indeterminate'][r[6]],
          };
        });
    scope.postMessage(
      {
        id,
        kind: 'scan',
        ...result,
        points,
        tested: result.stats.cells,
        ms: performance.now() - start,
      },
      [result.rows.buffer],
    );
  } finally {
    scanning = false;
  }
}
scope.onmessage = async ({ data }) => {
  try {
    switch (data.op) {
      case 'load':
        await load(data.id, data.includeBuffer);
        break;
      case 'trace':
        send(data.id, { kind: 'shot', shot: map.trace(data.source, data.target) });
        break;
      case 'pick':
        send(data.id, {
          kind: 'pick',
          hit: map.pick(data.source, data.direction, 'bullet', data.maxZ),
        });
        break;
      case 'scan':
        await scan(data.id, data.target, data.settings, data.pose);
        break;
      case 'cancel':
        cancelled = true;
        send(data.id, { kind: 'cancelled' });
        break;
      case 'walk-start': {
        const start = performance.now();
        const result = walker.start(data.eye, data.crouched);
        walkEye = data.eye;
        send(data.id, { kind: 'walk', ...result, ms: performance.now() - start });
        break;
      }
      case 'walk-reset': {
        if (!walkEye) throw Error('Start walking first');
        const start = performance.now();
        send(data.id, { kind: 'walk', ...walker.start(walkEye), ms: performance.now() - start });
        break;
      }
      case 'walk-step': {
        if (!walkEye) throw Error('Start walking first');
        const start = performance.now();
        const state = walker.step(data.dt, data.input, data.yaw);
        send(data.id, { kind: 'walk', state, ms: performance.now() - start });
        break;
      }
    }
  } catch (error) {
    send(data.id, { kind: 'error', error: String(error) });
  }
};
