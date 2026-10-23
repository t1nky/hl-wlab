import type { ScanRequestData, ScanStats } from './scan';
import {
  mergeScanParts,
  type ScanResult,
  type SharedCollision,
  sumScanStats,
} from './scan-parallel';

export class ScanPool {
  private workers: Worker[] = [];
  private active?: { reject: (error: Error) => void; cancel: Int32Array };
  private readonly shared: SharedCollision;
  constructor(shared: SharedCollision) {
    this.shared = shared;
  }
  dispose() {
    this.cancel();
    this.active?.reject(Error('CS2 scan pool closed'));
    this.active = undefined;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
  cancel() {
    if (this.active) Atomics.store(this.active.cancel, 0, 1);
  }
  async scan(count: number, request: ScanRequestData, progress: (stats: ScanStats) => void) {
    if (this.active) throw Error('A scan is already running');
    if (![1, 2, 4].includes(count)) throw Error('Unsupported CS2 worker count');
    if (this.workers.length !== count) this.dispose();
    const start = performance.now();
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    let startupMs = 0;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await new Promise<ScanResult>((resolve, reject) => {
      this.active = { reject, cancel };
      const results: ScanResult[] = [];
      const n = Math.floor(request.settings.radius / request.settings.spacing);
      const latest = Array.from(
        { length: count },
        (): ScanStats => ({
          cells: 0,
          total: (n * 2 + 1) ** 2,
          floors: 0,
          noFloor: 0,
          rejectedHull: 0,
          standing: 0,
          crouching: 0,
        }),
      );
      let completed = 0;
      const fail = (error: Error) => {
        reject(error);
        this.dispose();
      };
      const run = (worker: Worker, index: number) =>
        worker.postMessage({
          op: 'scan',
          cancel,
          request: { ...request, partition: { index, count } },
        });
      const fresh = !this.workers.length;
      let ready = 0;
      for (let index = 0; index < count; index++) {
        const worker =
          this.workers[index] ??
          new Worker(new URL('./scan-part.worker.ts', import.meta.url), { type: 'module' });
        this.workers[index] = worker;
        worker.onerror = (event) => fail(Error(event.message));
        worker.onmessageerror = () => fail(Error('CS2 scan worker message could not be decoded'));
        worker.onmessage = ({ data }) => {
          if (data.kind === 'error') {
            fail(Error(data.error));
            return;
          }
          if (data.kind === 'ready') {
            if (++ready === count) {
              clearTimeout(startupTimer);
              startupMs = performance.now() - start;
              this.workers.forEach(run);
            }
          } else if (data.kind === 'progress') {
            latest[index] = data.stats;
            progress(sumScanStats(latest));
          } else if (data.kind === 'result') {
            results[index] = data.result;
            latest[index] = data.result.stats;
            progress(sumScanStats(latest));
            if (++completed === count) {
              try {
                resolve(mergeScanParts(results));
              } catch (error) {
                fail(error as Error);
              }
            }
          }
        };
        if (fresh) worker.postMessage({ op: 'init', shared: this.shared, slot: index + 1 });
        else run(worker, index);
      }
      if (fresh)
        startupTimer = setTimeout(() => fail(Error('CS2 scan workers did not initialize')), 15000);
    })
      .catch((error) => {
        this.dispose();
        throw error;
      })
      .finally(() => {
        clearTimeout(startupTimer);
        this.active = undefined;
        for (const worker of this.workers) {
          worker.onmessage = null;
          worker.onerror = () => this.dispose();
          worker.onmessageerror = () => this.dispose();
        }
      });
    return { ...result, workersUsed: count, startupMs };
  }
}
