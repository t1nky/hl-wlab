import { candidates, readBSP } from '../engine/bsp.ts';
import { CORE_VERSION } from '../engine/engine.ts';
import type { ScanRequest, TraceInit, TraceResponse, TraceWork } from '../engine/types.ts';
import { getWeapon, weaponShotKey } from '../engine/weapons.ts';
import { dropLegacyTiles, hash, TileCache } from '../storage/cache.ts';
import type { RecordTable } from '../storage/records.ts';
import { bits } from '../storage/records.ts';
import { errorMessage } from '../ui/errors.ts';

interface Chunk {
  input: Float32Array;
  count: number;
}
interface TraceWorker extends Worker {
  ready: boolean;
  inFlight: Chunk[];
}
declare const self: {
  onmessage: ((event: MessageEvent<ScanRequest | { type: 'cancel' }>) => void) | null;
};
declare function postMessage(
  message: import('../engine/types.ts').ScanResponse,
  transfer?: Transferable[],
): void;

// Task input and result layouts are fixed by the core's sample_batch.
const CHUNK = 1024,
  INPUT = 6,
  RESULT = 14,
  GEO = 5,
  ROW = 1 + RESULT;
// Queued chunks keep trace workers busy while this thread is still preparing
// candidates or absorbing other results; preparation yields every few
// milliseconds so finished chunks are collected and refilled promptly.
const IN_FLIGHT = 4,
  YIELD_MS = 3;
const PROGRESS_MS = 100,
  CHECKPOINT_MS = 700;

// setTimeout is clamped to 4 ms once nested; a message round trip is not.
const channel = new MessageChannel(),
  resumes: (() => void)[] = [];
channel.port1.onmessage = () => resumes.shift()?.();
const yieldToEvents = () =>
  new Promise<void>((resolve) => {
    resumes.push(resolve);
    channel.port2.postMessage(0);
  });

let busy = false,
  cancelled = false;
self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') cancelled = true;
  else if (m.type === 'scan' && !busy) {
    busy = true;
    cancelled = false;
    scan(m).finally(() => {
      busy = false;
    });
  }
};

// Valid rows for the app: [stance, 14 result words], copied bit-exactly.
class Rows {
  words = new Uint32Array(ROW * 4096);
  length = 0;
  add(stance: number, source: Uint32Array, at: number) {
    if (this.length + ROW > this.words.length) {
      const grown = new Uint32Array(this.words.length * 2);
      grown.set(this.words);
      this.words = grown;
    }
    this.words[this.length] = stance;
    this.words.set(source.subarray(at, at + RESULT), this.length + 1);
    this.length += ROW;
  }
  packed() {
    return new Float32Array(this.words.buffer.slice(0, this.length * 4));
  }
}

async function scan(m: ScanRequest) {
  const started = performance.now(),
    workers: TraceWorker[] = [],
    rows = new Rows();
  const stanceBits = [bits(0), bits(1)];
  let geo: TileCache | undefined,
    shots: TileCache | undefined,
    total = 0,
    done = 0,
    reused = 0,
    placementReused = 0,
    computed = 0,
    valid = 0;
  const emit = (phase: string) =>
    postMessage({
      type: 'progress',
      phase,
      total,
      done,
      reused,
      placementReused,
      computed,
      valid,
      seconds: (performance.now() - started) / 1000,
      workers: workers.length,
    });
  try {
    const bsp = readBSP(m.map, { pixels: false });
    bsp.brushes = m.brushes;
    const core = await (await fetch(new URL('../engine/lab.wasm', import.meta.url))).arrayBuffer(),
      compiled = WebAssembly.compile(core);
    const [coreHash, mapHash, materialsHash] = await Promise.all([
      hash(core),
      hash(m.map),
      hash(m.materials),
    ]);
    const identity = await hash(CORE_VERSION + coreHash + mapHash + JSON.stringify(m.brushes));
    const shotID = await hash(
      identity +
        materialsHash +
        m.modelHash +
        JSON.stringify(m.pose) +
        m.expansion +
        weaponShotKey(getWeapon(m.weapon)),
    );
    postMessage({ type: 'progress', phase: 'Opening persistent cache', done: 0, total: 0 });
    try {
      await dropLegacyTiles();
      [geo, shots] = await Promise.all([
        new TileCache(`geo2/${identity}`, GEO).open(),
        new TileCache(`shot2/${shotID}`, RESULT).open(),
      ]);
    } catch (e) {
      throw Error(`Cannot open persistent cache: ${errorMessage(e)}`);
    }

    // Uncached tasks are traced while candidates are still being prepared.
    // One compilation is shared: instances created from the same Module reuse its code.
    const queue: Chunk[] = [],
      init: TraceInit = {
        ...m,
        type: 'init',
        textures: bsp.textures.map(({ name }) => ({ name })),
        core: await compiled,
      };
    let chunk = new Float32Array(CHUNK * INPUT),
      filled = 0,
      chunks = 0,
      prepared = false;
    let finish!: () => void,
      fail!: (error: unknown) => void,
      failed = false,
      saving = Promise.resolve(),
      lastProgress = performance.now(),
      lastCheckpoint = lastProgress;
    const traced = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = (e) => {
        failed = true;
        reject(e);
      };
    });
    traced.catch(() => {}); // observed by the await after preparation
    const idle = () =>
      prepared && (cancelled || !queue.length) && workers.every((w) => !w.inFlight.length);

    function startWorker() {
      const w = Object.assign(
        new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' }),
        { ready: false, inFlight: [] as Chunk[] },
      );
      w.onerror = (e) => fail(Error(errorMessage(e)));
      w.onmessage = ({ data: r }: MessageEvent<TraceResponse>) => {
        if (r.type === 'error') fail(Error(r.message));
        else if (r.type === 'ready') {
          w.ready = true;
          dispatch();
        } else if (r.type === 'result') {
          const chunk = w.inFlight.shift();
          if (!chunk) {
            fail(Error('Unexpected worker result'));
            return;
          }
          absorb(chunk, r.result);
          dispatch();
          if (idle()) finish();
        }
      };
      w.postMessage(init);
      workers.push(w);
    }
    function dispatch() {
      if (cancelled) return;
      // Like the former up-front split: never more workers than chunks.
      while (workers.length < Math.min(m.workers, chunks)) startWorker();
      for (const w of workers)
        while (w.ready && w.inFlight.length < IN_FLIGHT && queue.length) {
          const next = queue.shift();
          if (!next) break;
          w.inFlight.push(next);
          w.postMessage({ type: 'work', input: next.input, count: next.count } satisfies TraceWork);
        }
    }
    function enqueue(stance: number, p: number[], geoTile: RecordTable, g: number) {
      const o = filled * INPUT;
      chunk[o] = stance;
      chunk[o + 1] = p[0];
      chunk[o + 2] = p[1];
      chunk[o + 3] = p[2];
      if (g >= 0) {
        chunk[o + 4] = 1;
        chunk[o + 5] = geoTile.floats[g * geoTile.width + 4 + 3];
      }
      if (++filled === CHUNK) seal();
    }
    function seal() {
      if (!filled) return;
      queue.push({ input: chunk, count: filled });
      chunks++;
      chunk = new Float32Array(CHUNK * INPUT);
      filled = 0;
      dispatch();
    }
    function absorb({ input, count }: Chunk, result: Float32Array) {
      const inputWords = new Uint32Array(input.buffer),
        resultWords = new Uint32Array(result.buffer);
      for (let i = 0; i < count; i++) {
        const o = i * INPUT,
          at = i * RESULT,
          stance = input[o],
          x = bits(input[o + 1]),
          y = bits(input[o + 2]),
          z = bits(input[o + 3]);
        // Preparation found these keys absent, and each key is queued once.
        if (input[o + 4]) placementReused++;
        else geo?.tile(input[o + 1], input[o + 2]).append(stance, x, y, z, resultWords, at);
        if (result[at]) {
          shots?.tile(input[o + 1], input[o + 2]).append(stance, x, y, z, resultWords, at);
          rows.add(inputWords[o], resultWords, at);
          valid++;
        }
        computed++;
        done++;
      }
      const now = performance.now();
      if (now - lastProgress > PROGRESS_MS) {
        lastProgress = now;
        emit(
          cancelled ? 'Stopping' : prepared ? 'Tracing in WebAssembly' : 'Preparing aligned grid',
        );
      }
      if (now - lastCheckpoint > CHECKPOINT_MS) {
        lastCheckpoint = now;
        saving = saving
          .then(async () => {
            await Promise.all([geo?.flush(), shots?.flush()]);
          })
          .catch(fail);
      }
    }

    let lastYield = performance.now();
    for (const p of candidates(bsp, m.spacing, m.radius, m.target)) {
      if (cancelled || failed) break;
      const x = bits(p[0]),
        y = bits(p[1]),
        z = bits(p[2]),
        geoTile = geo.tile(p[0], p[1]),
        shotTile = shots.tile(p[0], p[1]);
      for (let stance = 0; stance < 2; stance++) {
        total++;
        const s = shotTile.find(stance, x, y, z);
        if (s >= 0) {
          done++;
          reused++;
          if (shotTile.floats[s * shotTile.width + 4]) {
            rows.add(stanceBits[stance], shotTile.words, s * shotTile.width + 4);
            valid++;
          }
          continue;
        }
        const g = geoTile.find(stance, x, y, z);
        if (g >= 0 && !geoTile.floats[g * geoTile.width + 4]) {
          done++;
          reused++;
        } else enqueue(stance, p, geoTile, g);
      }
      const now = performance.now();
      if (now - lastYield > YIELD_MS) {
        if (now - lastProgress > PROGRESS_MS) {
          lastProgress = now;
          emit('Preparing aligned grid');
        }
        await yieldToEvents();
        lastYield = performance.now();
      }
    }
    seal();
    prepared = true;
    emit('Tracing in WebAssembly');
    if (idle()) finish();
    await traced;
    for (const w of workers) w.terminate();
    workers.length = 0;
    emit('Saving cache');
    await saving;
    await Promise.all([geo.flush(), shots.flush()]);
    const packed = rows.packed();
    postMessage(
      {
        type: 'complete',
        cancelled,
        total,
        done,
        reused,
        placementReused,
        computed,
        valid,
        seconds: (performance.now() - started) / 1000,
        rows: packed,
        identity,
        shotID,
      },
      [packed.buffer],
    );
  } catch (e) {
    for (const w of workers) w.terminate();
    try {
      await Promise.all([geo?.flush(), shots?.flush()]);
    } catch {}
    postMessage({ type: 'error', message: errorMessage(e) });
  }
}
