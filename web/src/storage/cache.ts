import { RecordTable } from './records.ts';

export const request = <T>(q: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
export const transaction = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error('Storage transaction aborted'));
  });
let database: IDBDatabase | undefined;
export async function db() {
  if (!database)
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open('wallbang-web-v1', 1);
      q.onupgradeneeded = () => {
        for (const s of ['assets', 'tiles']) q.result.createObjectStore(s);
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  return database;
}
export async function get<T = unknown>(store: string, key: string): Promise<T | undefined> {
  const d = await db();
  return request(d.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}
export async function put(store: string, key: string, value: unknown) {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return transaction(tx);
}
export async function hash(data: string | BufferSource) {
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
const range = (prefix: string) => IDBKeyRange.bound(`${prefix}/`, `${prefix}/\uffff`);

// Tiles written before packed records used string-keyed arrays under these
// namespaces. Nothing reads them any more, so they would only consume quota.
export async function dropLegacyTiles() {
  const d = await db(),
    tx = d.transaction('tiles', 'readwrite'),
    s = tx.objectStore('tiles');
  for (const prefix of ['geo', 'shot']) s.delete(range(prefix));
  return transaction(tx);
}

// Persistent cache partitioned into 256-unit XY tiles. Each tile is a
// RecordTable stored in IndexedDB as one ArrayBuffer, so checkpoints and
// reads are buffer copies rather than per-entry structured clones.
export class TileCache {
  namespace: string;
  width: number;
  tiles: Map<string, RecordTable>;
  lastX: number;
  lastY: number;
  last: RecordTable | null;
  constructor(namespace: string, valueWords: number) {
    this.namespace = namespace;
    this.width = 4 + valueWords;
    this.tiles = new Map();
    this.lastX = NaN;
    this.lastY = NaN;
    this.last = null;
  }
  async open() {
    const d = await db(),
      store = d.transaction('tiles').objectStore('tiles'),
      r = range(this.namespace),
      [values, keys] = await Promise.all([request(store.getAll(r)), request(store.getAllKeys(r))]);
    for (let i = 0; i < values.length; i++)
      if (values[i] instanceof ArrayBuffer && values[i].byteLength % (this.width * 4) === 0)
        this.tiles.set(
          String(keys[i]).slice(this.namespace.length + 1),
          new RecordTable(this.width, new Uint32Array(values[i])),
        );
    return this;
  }
  // Consecutive candidates usually share a tile, so the last one is memoized.
  tile(x: number, y: number) {
    const tx = Math.floor(x / 256),
      ty = Math.floor(y / 256);
    if (tx !== this.lastX || ty !== this.lastY) {
      const name = `${tx},${ty}`;
      let t = this.tiles.get(name);
      if (!t) {
        t = new RecordTable(this.width);
        this.tiles.set(name, t);
      }
      this.lastX = tx;
      this.lastY = ty;
      this.last = t;
    }
    if (!this.last) throw Error('Invalid tile coordinates');
    return this.last;
  }
  // Tables only grow, and IndexedDB commits readwrite transactions on one
  // store in creation order, so overlapping flushes still end with the newest.
  async flush() {
    const d = await db(),
      dirty = [...this.tiles].filter(([, t]) => t.dirty);
    if (!dirty.length) return;
    try {
      const tx = d.transaction('tiles', 'readwrite'),
        s = tx.objectStore('tiles');
      for (const [name, t] of dirty) {
        s.put(t.snapshot().buffer, `${this.namespace}/${name}`);
        t.dirty = false;
      }
      await transaction(tx);
    } catch (e) {
      for (const [, t] of dirty) t.dirty = true;
      throw e;
    }
  }
}
