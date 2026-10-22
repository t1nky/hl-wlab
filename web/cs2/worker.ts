import { Vector3 } from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import { CollisionMap } from './collision';
import { WalkController, type WalkInput } from './movement';
import { decodeMap, type Metadata, type V3 } from './types';

type Request = { id: number } & (
  | { op: 'load'; includeBuffer?: boolean }
  | { op: 'trace'; source: V3; target: V3 }
  | { op: 'pick'; source: V3; direction: V3; maxZ: number }
  | { op: 'scan'; target: V3 }
  | { op: 'cancel' }
  | { op: 'walk-start'; eye: V3 }
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
async function readCache(key: string): Promise<SerializedBVH | undefined> {
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
async function saveCache(key: string, bvh: SerializedBVH) {
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
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== meta.binarySha256) throw Error('Collision package hash mismatch; prepare again');
  const cacheKey = `three0.170-bvh0.9.8-${hash}`;
  const cached = await readCache(cacheKey);
  const buildStart = performance.now();
  try {
    map = new CollisionMap(decodeMap(buffer), meta, cached);
  } catch (error) {
    if (!cached) throw error;
    map = new CollisionMap(decodeMap(buffer), meta);
  }
  const buildMs = performance.now() - buildStart;
  walker = new WalkController(map);
  let cacheSaved = !!cached;
  if (!cached) {
    try {
      await saveCache(cacheKey, MeshBVH.serialize(map.bvh));
      cacheSaved = true;
    } catch {
      /* Quota/private browsing must not prevent tracing. */
    }
  }
  const render = includeBuffer ? buffer.slice(0) : undefined;
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
    },
    render ? [render] : [],
  );
}
async function scan(id: number, target: V3) {
  if (scanning) throw Error('A scan is already running');
  scanning = true;
  cancelled = false;
  const start = performance.now();
  const points: { source: V3; damage: number | null; status: string }[] = [];
  let tested = 0;
  try {
    for (let y = -12; y <= 12 && !cancelled; y++) {
      for (let x = -12; x <= 12 && !cancelled; x++) {
        tested++;
        const ground = map.pick(
          [target[0] + x * 64, target[1] + y * 64, target[2] + 128],
          [0, 0, -1],
          'player',
        );
        if (!ground || ground.normal[2] < 0.7 || ground.point[2] < target[2] - 256) continue;
        const foot = ground.point as V3;
        const support = [
          [-15, -15],
          [15, -15],
          [-15, 15],
          [15, 15],
        ].every(([dx, dy]) => {
          const hit = map.pick([foot[0] + dx, foot[1] + dy, foot[2] + 3], [0, 0, -1], 'player');
          return hit && hit.normal[2] > 0.7 && Math.abs(hit.point[2] - foot[2]) < 2;
        });
        if (!support || !map.standable(foot)) continue;
        const source: V3 = [foot[0], foot[1], foot[2] + 64];
        if (new Vector3(...source).distanceTo(new Vector3(...target)) < 1) continue;
        const result = map.trace(source, target);
        points.push({ source, damage: result.damage, status: result.status });
      }
      send(id, { kind: 'progress', tested, total: 625 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    send(id, { kind: 'scan', points, tested, cancelled, ms: performance.now() - start });
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
        await scan(data.id, data.target);
        break;
      case 'cancel':
        cancelled = true;
        send(data.id, { kind: 'cancelled' });
        break;
      case 'walk-start': {
        const start = performance.now();
        const result = walker.start(data.eye);
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
