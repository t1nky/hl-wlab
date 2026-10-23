import type { CollisionCache, CollisionMap } from './collision';
import { CS2_ROW, type ScanStats, type scanMap } from './scan';
import type { MapData, Metadata } from './types';

export type ScanResult = Awaited<ReturnType<typeof scanMap>>;
export interface SharedCollision {
  data: MapData;
  metadata: Metadata;
  cache: CollisionCache;
  bytes: number;
}
/** Copy each backing store once, retaining package views/offsets. All recipients only read. */
export function shareCollision(map: CollisionMap): SharedCollision {
  const stores = new Map<ArrayBufferLike, SharedArrayBuffer>();
  const share = (source: ArrayBufferLike) => {
    let shared = stores.get(source);
    if (!shared) {
      shared = new SharedArrayBuffer(source.byteLength);
      new Uint8Array(shared).set(new Uint8Array(source));
      stores.set(source, shared);
    }
    return shared;
  };
  const data = Object.fromEntries(
    Object.entries(map.data).map(([key, array]) => [
      key,
      key === 'positions'
        ? new Float32Array(share(array.buffer), array.byteOffset, array.length)
        : new Uint32Array(share(array.buffer), array.byteOffset, array.length),
    ]),
  ) as unknown as MapData;
  const snapshot = map.cacheSnapshot();
  const indirect = snapshot.indirectBuffer;
  if (!indirect) throw Error('Indirect collision BVH required');
  const cache: CollisionCache = {
    ...snapshot,
    roots: snapshot.roots.map((root) => share(root) as unknown as ArrayBuffer),
    indirectBuffer:
      indirect instanceof Uint16Array
        ? new Uint16Array(share(indirect.buffer), indirect.byteOffset, indirect.length)
        : new Uint32Array(share(indirect.buffer), indirect.byteOffset, indirect.length),
  };
  return {
    data,
    cache,
    metadata: map.metadata,
    bytes: [...stores.values()].reduce((sum, buffer) => sum + buffer.byteLength, 0),
  };
}

export function sumScanStats(parts: ScanStats[]): ScanStats {
  const result = { ...parts[0] };
  for (const key of Object.keys(result) as (keyof ScanStats)[])
    if (key !== 'total') result[key] = parts.reduce((sum, part) => sum + part[key], 0);
  return result;
}

/** Striped execution is balanced across the circle; output is still strict row-major order. */
export function mergeScanParts(parts: ScanResult[]): ScanResult {
  if (!parts.length) throw Error('No scan partitions');
  const width = parts[0].rowCounts.length;
  if (parts.some((part) => part.rowCounts.length !== width)) throw Error('Scan partition mismatch');
  const offsets = parts.map(() => 0);
  const rowCounts = new Uint32Array(width);
  const rows = new Float32Array(parts.reduce((sum, part) => sum + part.rows.length, 0));
  let used = 0;
  for (let y = 0; y < width; y++) {
    const index = y % parts.length;
    const count = parts[index].rowCounts[y];
    rowCounts[y] = count;
    const length = count * CS2_ROW;
    rows.set(parts[index].rows.subarray(offsets[index], offsets[index] + length), used);
    offsets[index] += length;
    used += length;
  }
  if (offsets.some((offset, i) => offset !== parts[i].rows.length))
    throw Error('Scan partition row accounting mismatch');
  return {
    rows,
    rowCounts,
    stats: sumScanStats(parts.map((part) => part.stats)),
    cancelled: parts.some((part) => part.cancelled),
    placementCache: Object.fromEntries(
      ['hits', 'misses', 'entries', 'limit'].map((key) => [
        key,
        parts.reduce((sum, part) => sum + part.placementCache[key as 'hits'], 0),
      ]),
    ) as ScanResult['placementCache'],
  };
}
