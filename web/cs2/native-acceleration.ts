import { BufferGeometry } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import type { CollisionMap } from './collision';

export interface NativeAcceleration {
  version: 2;
  roots: ArrayBuffer[];
  indirect: Uint32Array;
  ranks: Uint32Array;
  flags: Uint8Array;
  digest: string;
}
export interface AccelerationTiming {
  cached: boolean;
  buildMs: number;
  cacheReadMs: number;
  cacheWriteMs: number;
  bytes: number;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wallbang-cs2-native', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('acceleration');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function read(key: string): Promise<NativeAcceleration | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('acceleration').objectStore('acceleration').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
async function save(key: string, value: NativeAcceleration) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('acceleration', 'readwrite'),
        store = tx.objectStore('acceleration');
      store.clear();
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function equal(a: Uint8Array | Uint32Array, b: Uint8Array | Uint32Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** Hash every serialized byte, including bounds. Separate component hashes avoid
 * allocating a second complete index just to concatenate its buffers. */
export async function accelerationDigest(value: Omit<NativeAcceleration, 'digest'>) {
  const parts: string[] = [];
  const arrays = [
    ...value.roots.map((root) => new Uint8Array(root)),
    value.indirect,
    value.ranks,
    value.flags,
  ];
  for (const array of arrays) {
    const bytes = new Uint8Array(array.buffer as ArrayBuffer, array.byteOffset, array.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    parts.push(
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify([value.version, value.roots.length, ...parts]),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', manifest)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function valid(
  value: NativeAcceleration | undefined,
  flags: Uint8Array,
  ranks: Uint32Array,
  shapes: Uint32Array,
) {
  if (
    value?.version !== 2 ||
    !(value.indirect instanceof Uint32Array) ||
    !(value.ranks instanceof Uint32Array) ||
    !(value.flags instanceof Uint8Array) ||
    !Array.isArray(value.roots) ||
    !value.roots.length ||
    !equal(value.flags, flags) ||
    !equal(value.ranks, ranks) ||
    value.indirect.length !== ranks.length ||
    !/^[0-9a-f]{64}$/.test(value.digest) ||
    !(value.indirect.buffer instanceof ArrayBuffer) ||
    !(value.ranks.buffer instanceof ArrayBuffer) ||
    !(value.flags.buffer instanceof ArrayBuffer)
  )
    return false;
  const triangles = new Uint8Array(ranks.length),
    covered = new Uint8Array(ranks.length);
  let coverage = 0;
  for (const index of value.indirect) {
    if (index >= ranks.length || triangles[index]) return false;
    triangles[index] = 1;
  }
  for (const root of value.roots) {
    if (!(root instanceof ArrayBuffer) || !root.byteLength || root.byteLength % 32) return false;
    const f = new Float32Array(root),
      u = new Uint32Array(root),
      count = root.byteLength / 32;
    for (let node = 0; node < count; node++) {
      const at = node * 8,
        field = u[at + 7],
        index = u[at + 6];
      for (let i = 0; i < 6; i++) if (!Number.isFinite(f[at + i])) return false;
      if (f[at] > f[at + 3] || f[at + 1] > f[at + 4] || f[at + 2] > f[at + 5]) return false;
      if (field & 8) {
        const length = field >>> 8;
        if (!length || index + length > ranks.length || field & 0xf4) return false;
        let mask = 0;
        for (let i = index; i < index + length; i++) {
          if (covered[i]) return false;
          covered[i] = 1;
          coverage++;
          mask |= flags[shapes[value.indirect[i]]];
        }
        if ((field & 3) !== mask) return false;
      } else {
        if (field & ~3 || index <= node + 2 || index > count) return false;
        const left = node + 1;
        const right = u[left * 8 + 7] & 8 ? left + 1 : u[left * 8 + 6];
        if (right <= left || right >= index) return false;
        const after = u[right * 8 + 7] & 8 ? right + 1 : u[right * 8 + 6];
        if (after !== index || field !== ((u[left * 8 + 7] | u[right * 8 + 7]) & 3)) return false;
      }
    }
    if ((u[7] & 8 ? 1 : u[6]) !== count) return false;
  }
  return coverage === ranks.length;
}

/** SAH changes only the candidate index. Restore original DFS hit rank before any
 * grouping/sorting/interval decisions, including coincident and uncertain faces. */
export async function nativeAcceleration(
  map: CollisionMap,
  strategy: 'center' | 'sah',
  leafSize: number,
  persistent = true,
): Promise<{ data: NativeAcceleration; timing: AccelerationTiming }> {
  const original = map.cacheSnapshot();
  if (original.version !== 1 || !original.indirectBuffer)
    throw Error('Unsupported collision BVH version');
  const flags = Uint8Array.from(
    map.metadata.shapes,
    (shape) => Number(shape.bullet) | (Number(shape.player) << 1),
  );
  const ranks = new Uint32Array(map.data.shapes.length);
  let rank = 0;
  for (const root of original.roots) {
    const ints = new Uint32Array(root),
      shorts = new Uint16Array(root);
    for (let node = 0; node < root.byteLength / 32; node++) {
      if (shorts[node * 16 + 15] !== 65535) continue;
      const first = ints[node * 8 + 6],
        count = shorts[node * 16 + 14];
      for (let i = first; i < first + count; i++) ranks[original.indirectBuffer[i]] = rank++;
    }
  }
  const timing: AccelerationTiming = {
    cached: false,
    buildMs: 0,
    cacheReadMs: 0,
    cacheWriteMs: 0,
    bytes: 0,
  };
  const cacheable =
    persistent &&
    strategy === 'sah' &&
    typeof indexedDB !== 'undefined' &&
    /^[0-9a-f]{64}$/.test(map.metadata.binarySha256);
  const key = `cache2-abi1-three0.170-bvh0.9.8-sah${leafSize}-${map.metadata.binarySha256}`;
  const beforeRead = performance.now();
  let cached: NativeAcceleration | undefined;
  if (cacheable)
    try {
      cached = await read(key);
    } catch {
      /* Quota/availability never blocks scanning. */
    }
  if (
    cached &&
    valid(cached, flags, ranks, map.data.shapes) &&
    cached.digest === (await accelerationDigest(cached))
  )
    timing.cached = true;
  else cached = undefined;
  timing.cacheReadMs = performance.now() - beforeRead;
  if (cached) {
    timing.bytes =
      cached.roots.reduce((sum, root) => sum + root.byteLength, 0) +
      cached.indirect.byteLength +
      cached.ranks.byteLength +
      cached.flags.byteLength;
    return { data: cached, timing };
  }
  const beforeBuild = performance.now();
  const snapshot =
    strategy === 'sah'
      ? (() => {
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', map.geometry.getAttribute('position'));
          geometry.setIndex(map.geometry.index);
          const bvh = new MeshBVH(geometry, {
            strategy: SAH,
            indirect: true,
            maxLeafSize: leafSize,
          });
          const result = MeshBVH.serialize(bvh, { cloneBuffers: false }) as typeof original;
          geometry.dispose();
          return result;
        })()
      : original;
  const indirect =
    snapshot.indirectBuffer instanceof Uint32Array
      ? snapshot.indirectBuffer
      : Uint32Array.from(snapshot.indirectBuffer ?? []);
  const roots = snapshot.roots.map((root) => {
    const floats = new Float32Array(root),
      ints = new Uint32Array(root),
      shorts = new Uint16Array(root);
    const count = root.byteLength / 32;
    const buffer = new ArrayBuffer(root.byteLength),
      bounds = new Float32Array(buffer),
      fields = new Uint32Array(buffer);
    for (let node = 0; node < count; node++)
      for (let coordinate = 0; coordinate < 6; coordinate++)
        bounds[node * 8 + coordinate] = floats[node * 8 + coordinate];
    const visit = (node: number): number => {
      let escapeNode: number,
        mask = 0;
      if (shorts[node * 16 + 15] === 65535) {
        const first = ints[node * 8 + 6],
          length = shorts[node * 16 + 14];
        fields[node * 8 + 6] = first;
        for (let j = first; j < first + length; j++) mask |= flags[map.data.shapes[indirect[j]]];
        mask |= 8 | (length << 8);
        escapeNode = node + 1;
      } else {
        const right = node + ints[node * 8 + 6];
        visit(node + 1);
        escapeNode = visit(right);
        mask = (fields[(node + 1) * 8 + 7] | fields[right * 8 + 7]) & 3;
        fields[node * 8 + 6] = escapeNode;
      }
      fields[node * 8 + 7] = mask;
      return escapeNode;
    };
    if (visit(0) !== count) throw Error('Unsupported collision tree order');
    return buffer;
  });
  const data: NativeAcceleration = { version: 2, roots, indirect, ranks, flags, digest: '' };
  timing.buildMs = performance.now() - beforeBuild;
  timing.bytes =
    roots.reduce((sum, root) => sum + root.byteLength, 0) +
    indirect.byteLength +
    ranks.byteLength +
    flags.byteLength;
  if (cacheable) {
    const beforeWrite = performance.now();
    data.digest = await accelerationDigest(data);
    try {
      await save(key, data);
    } catch {
      /* An in-memory exact index remains usable. */
    }
    timing.cacheWriteMs = performance.now() - beforeWrite;
  }
  return { data, timing };
}
