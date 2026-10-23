import { CollisionMap } from './collision';
import { type ScanRequestData, scanMap } from './scan';
import type { SharedCollision } from './scan-parallel';

let map: CollisionMap;
let cancelled = false;
self.onmessage = async ({
  data,
}: MessageEvent<
  | { op: 'init'; shared: SharedCollision }
  | { op: 'scan'; request: ScanRequestData; cancel: Int32Array }
  | { op: 'cancel' }
>) => {
  try {
    if (data.op === 'init') {
      map?.dispose();
      map = new CollisionMap(data.shared.data, data.shared.metadata, data.shared.cache);
      self.postMessage({ kind: 'ready' });
    } else if (data.op === 'cancel') cancelled = true;
    else {
      cancelled = false;
      const result = await scanMap(
        map,
        data.request,
        (stats) => self.postMessage({ kind: 'progress', stats }),
        () => cancelled || Atomics.load(data.cancel, 0) !== 0,
      );
      self.postMessage(
        { kind: 'result', result },
        { transfer: [result.rows.buffer, result.rowCounts.buffer] },
      );
    }
  } catch (error) {
    self.postMessage({ kind: 'error', error: String(error) });
  }
};
