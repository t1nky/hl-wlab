import type { CollisionMap } from './collision';
import { penetrationParameters } from './damage';
import { type AccelerationTiming, nativeAcceleration } from './native-acceleration';
import type { MapData, Metadata, V3 } from './types';

const FUNCTIONS = [
  'cs2_abi',
  'cs2_heap_base',
  'cs2_context_size',
  'cs2_column',
  'cs2_origins_ptr',
  'cs2_jobs_ptr',
  'cs2_results_ptr',
  'cs2_metrics_ptr',
  'cs2_weapon_ptr',
  'cs2_floors',
  'cs2_rejected',
  'cs2_energy_batch',
  'cs2_trace_one',
  'cs2_sweep',
  'cs2_fits',
] as const;
type Exports = Record<(typeof FUNCTIONS)[number], (...args: number[]) => number> & {
  __stack_pointer: WebAssembly.Global;
};
export interface SharedNativeScan {
  version: 1;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  mapPtr: number;
  contexts: number;
  contextSize: number;
  stackBase: number;
  stackSize: number;
  data: MapData;
  indirect: Uint32Array;
  bytes: number;
  acceleration: AccelerationTiming;
}
export interface NativeColumn {
  floors: number;
  rejectedHull: number;
  origins: { crouched: number; foot: V3 }[];
}
const imports = (memory: WebAssembly.Memory) => ({ env: { memory }, math: { pow: Math.pow } });
const align = (value: number, alignment = 64) => Math.ceil(value / alignment) * alignment;
let compiled: Promise<WebAssembly.Module> | undefined;

export class NativeScan {
  private descriptor?: SharedNativeScan;
  private exports?: Exports;
  readonly initMs: number;
  private readonly context: number;
  private origins: Float64Array;
  jobs: Float64Array;
  private results: Float64Array;
  private metrics: Float64Array;
  private weapon: Float64Array;
  private disposed = false;
  get shared() {
    if (!this.descriptor) throw Error('Native CS2 scan closed');
    return this.descriptor;
  }
  private get e() {
    if (!this.exports) throw Error('Native CS2 scan closed');
    return this.exports;
  }
  constructor(
    shared: SharedNativeScan,
    e: Exports,
    slot: number,
    initMs: number,
    metadata: Metadata,
  ) {
    if (shared.version !== 1 || slot < 0 || slot > 4 || !Number.isInteger(slot))
      throw Error('Invalid native CS2 scan context');
    this.descriptor = shared;
    this.exports = e;
    this.initMs = initMs;
    this.context = shared.contexts + slot * shared.contextSize;
    new Uint8Array(shared.memory.buffer, this.context, shared.contextSize).fill(0);
    e.__stack_pointer.value = shared.stackBase + (slot + 1) * shared.stackSize;
    const view = (fn: (p: number) => number, count: number) =>
      new Float64Array(shared.memory.buffer, fn(this.context), count);
    this.origins = view(e.cs2_origins_ptr, 512 * 4);
    this.jobs = view(e.cs2_jobs_ptr, 1024 * 6);
    this.results = view(e.cs2_results_ptr, 1024 * 3);
    this.metrics = view(e.cs2_metrics_ptr, 8);
    this.weapon = view(e.cs2_weapon_ptr, 4);
    this.setWeapon(metadata.weapon);
  }
  setWeapon(weapon: Metadata['weapon']) {
    if (this.disposed) throw Error('Native CS2 scan closed');
    this.weapon.set([weapon.damage, weapon.penetration, weapon.range, weapon.rangeModifier]);
  }
  column(x: number, y: number): NativeColumn | undefined {
    if (this.disposed) throw Error('Native CS2 scan closed');
    const count = this.e.cs2_column(this.shared.mapPtr, this.context, x, y);
    if (count < 0) return undefined;
    const origins: NativeColumn['origins'] = [];
    for (let i = 0; i < count; i++)
      origins.push({
        crouched: this.origins[i * 4],
        foot: [this.origins[i * 4 + 1], this.origins[i * 4 + 2], this.origins[i * 4 + 3]],
      });
    return {
      floors: this.e.cs2_floors(this.context),
      rejectedHull: this.e.cs2_rejected(this.context),
      origins,
    };
  }
  traceBatch(count: number): Float64Array {
    if (this.disposed) throw Error('Native CS2 scan closed');
    if (this.e.cs2_energy_batch(this.shared.mapPtr, this.context, count) !== count)
      throw Error('Invalid native CS2 ray batch');
    return this.results.subarray(0, count * 3);
  }
  counters() {
    return Array.from(this.metrics);
  }
  resetCounters() {
    this.metrics.fill(0);
  }
  trace(source: V3, target: V3, kind: 'bullet' | 'player' = 'bullet') {
    if (this.disposed) throw Error('Native CS2 scan closed');
    this.jobs.set([...source, ...target]);
    this.e.cs2_trace_one(this.shared.mapPtr, this.context, kind === 'bullet' ? 1 : 2);
    return Array.from(this.results.subarray(0, 3));
  }
  sweep(foot: V3, height: number, delta: V3) {
    if (this.disposed) throw Error('Native CS2 scan closed');
    const hit = this.e.cs2_sweep(this.shared.mapPtr, this.context, ...foot, height, ...delta);
    return hit
      ? { fraction: this.results[0], normal: Array.from(this.results.subarray(1, 4)) as V3 }
      : null;
  }
  fits(foot: V3, height: number, inside = false) {
    if (this.disposed) throw Error('Native CS2 scan closed');
    const result = this.e.cs2_fits(
      this.shared.mapPtr,
      this.context,
      ...foot,
      height,
      Number(inside),
    );
    return result < 0 ? undefined : !!result;
  }
  dispose() {
    this.disposed = true;
    // A retained closed handle must not keep the map-wide Memory/Instance alive.
    this.descriptor = undefined;
    this.exports = undefined;
    this.jobs = this.origins = this.results = this.metrics = this.weapon = new Float64Array(0);
  }
}

export async function attachNativeScan(shared: SharedNativeScan, slot: number, metadata: Metadata) {
  const start = performance.now();
  const instance = await WebAssembly.instantiate(shared.module, imports(shared.memory));
  return new NativeScan(
    shared,
    instance.exports as Exports,
    slot,
    performance.now() - start,
    metadata,
  );
}

/** One map-wide imported shared memory, immutable numeric arrays + five private contexts.
 * The caller may adopt data views to release the original package store.
 * The accelerated indirect order belongs to WASM only; JS retains its original BVH. */
export async function createNativeScan(
  map: CollisionMap,
  source?: BufferSource,
  strategy: 'center' | 'sah' = 'sah',
  leafSize = 8,
): Promise<NativeScan> {
  const start = performance.now();
  if (map.metadata.shapes.length > 16384 || map.metadata.materials.length > 1024)
    throw Error('Native CS2 metadata capacity exceeded');
  if (!source && !compiled) {
    compiled = (async () => {
      const response = await fetch(new URL('./scan.wasm', import.meta.url));
      if (!response.ok) throw Error('CS2 scan WASM unavailable');
      return WebAssembly.compile(await response.arrayBuffer());
    })().catch((error) => {
      compiled = undefined;
      throw error;
    });
  }
  const module = source ? await WebAssembly.compile(source) : await compiled;
  if (!module) throw Error('CS2 scan WASM unavailable');
  const probe = await WebAssembly.instantiate(
    module,
    imports(new WebAssembly.Memory({ initial: 32, maximum: 32768, shared: true })),
  );
  const e = probe.exports as Exports;
  if (
    FUNCTIONS.some((name) => typeof e[name] !== 'function') ||
    !(e.__stack_pointer instanceof WebAssembly.Global)
  )
    throw Error('Incompatible native CS2 scan interface');
  if (e.cs2_abi() !== 1) throw Error('Incompatible native CS2 scan ABI');
  let cursor = align(e.cs2_heap_base());
  const allocations: { offset: number; bytes: Uint8Array }[] = [];
  const allocate = (bytes: number) => {
    const at = cursor;
    cursor = align(cursor + bytes);
    return at;
  };
  const stage = (array: ArrayBufferView) => {
    const offset = allocate(array.byteLength);
    allocations.push({
      offset,
      bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    });
    return offset;
  };
  const mapPtr = allocate(144);
  const positions = stage(map.data.positions),
    indices = stage(map.data.indices),
    materials = stage(map.data.materials),
    shapes = stage(map.data.shapes);
  const acceleration = await nativeAcceleration(map, strategy, leafSize);
  const rankPtr = strategy === 'sah' ? stage(acceleration.data.ranks) : 0;
  const indirect = stage(acceleration.data.indirect);
  const rootRecords = new Uint32Array(acceleration.data.roots.length * 2);
  acceleration.data.roots.forEach((root, i) => {
    rootRecords[i * 2] = stage(new Uint8Array(root));
    rootRecords[i * 2 + 1] = root.byteLength / 32;
  });
  const roots = stage(rootRecords);
  const shapeInfo = new Uint32Array(map.metadata.shapes.length * 4),
    planes: number[] = [];
  map.metadata.shapes.forEach((shape, i) => {
    shapeInfo.set(
      [
        Number(shape.kind === 'hull'),
        Number(shape.bullet) |
          (Number(shape.player) << 1) |
          (Number(shape.tags.includes('sky')) << 2),
        planes.length / 4,
        shape.planes.length,
      ],
      i * 4,
    );
    for (const plane of shape.planes) planes.push(...plane);
  });
  const shapePtr = stage(shapeInfo),
    planePtr = stage(Float64Array.from(planes));
  const materialInfo = new Float64Array(map.metadata.materials.length * 2);
  map.metadata.materials.forEach((material, i) => {
    materialInfo.set(
      [material.distanceModifier ?? -1, Number(material.name === 'blockbullets')],
      i * 2,
    );
  });
  const materialPtr = stage(materialInfo);
  const count = map.metadata.materials.length,
    pairs = new Float64Array(count * count * 2);
  map.metadata.materials.forEach((entry, i) => {
    map.metadata.materials.forEach((exit, j) => {
      const pair = penetrationParameters(entry, exit);
      pairs.set([pair?.modifier ?? -1, pair?.fraction ?? 0], (i * count + j) * 2);
    });
  });
  const pairPtr = stage(pairs);
  const contextSize = align(e.cs2_context_size());
  const contexts = allocate(contextSize * 5),
    stackSize = 1048576,
    stackBase = allocate(stackSize * 5);
  const pages = Math.ceil(cursor / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  for (const { offset, bytes } of allocations)
    new Uint8Array(memory.buffer, offset, bytes.length).set(bytes);
  new Uint32Array(memory.buffer, mapPtr, 14).set([
    positions,
    indices,
    materials,
    shapes,
    indirect,
    roots,
    acceleration.data.roots.length,
    shapePtr,
    planePtr,
    materialPtr,
    pairPtr,
    map.metadata.shapes.length,
    count,
    rankPtr,
  ]);
  const bounds = map.geometry.boundingBox;
  if (!bounds) throw Error('Missing collision bounds');
  new Float64Array(memory.buffer, mapPtr + 56, 11).set([
    map.far,
    ...bounds.min.toArray(),
    ...bounds.max.toArray(),
    map.metadata.weapon.damage,
    map.metadata.weapon.penetration,
    map.metadata.weapon.range,
    map.metadata.weapon.rangeModifier,
  ]);
  const shared: SharedNativeScan = {
    version: 1,
    module,
    memory,
    mapPtr,
    contextSize,
    contexts,
    stackBase,
    stackSize,
    data: {
      positions: new Float32Array(memory.buffer, positions, map.data.positions.length),
      indices: new Uint32Array(memory.buffer, indices, map.data.indices.length),
      materials: new Uint32Array(memory.buffer, materials, map.data.materials.length),
      shapes: new Uint32Array(memory.buffer, shapes, map.data.shapes.length),
    },
    indirect: new Uint32Array(memory.buffer, indirect, acceleration.data.indirect.length),
    bytes: memory.buffer.byteLength,
    acceleration: acceleration.timing,
  };
  const instance = await WebAssembly.instantiate(module, imports(memory));
  return new NativeScan(
    shared,
    instance.exports as Exports,
    0,
    performance.now() - start,
    map.metadata,
  );
}
