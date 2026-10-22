import { materialTable, textureMaterial } from './bsp.ts';
import type { Brush, Pose, Texture } from './types.ts';
import { DEFAULT_WEAPON, getWeapon, type WeaponID, type WeaponPreset } from './weapons.ts';

const CORE_FUNCTIONS = [
  'map_ptr',
  'map_load',
  'set_material',
  'set_brush',
  'trace',
  'io_ptr',
  'clear_target',
  'add_hitbox',
  'set_aim',
  'jobs_ptr',
  'sample_batch',
  'results_ptr',
  'fire',
  'set_weapon',
] as const;
type CoreExports = { memory: WebAssembly.Memory } & Record<
  (typeof CORE_FUNCTIONS)[number],
  (...args: number[]) => number
>;
export type Engine = Awaited<ReturnType<typeof makeEngine>>;

export const CORE_VERSION = 'bsp-awp-experiment-3';
// `core` may be the module bytes (ArrayBuffer/Uint8Array) or a compiled
// WebAssembly.Module, so workers can share one compilation.
export async function makeEngine(
  buffer: ArrayBuffer,
  bsp: { textures: Pick<Texture, 'name'>[]; brushes: Brush[] },
  materials: string,
  core: WebAssembly.Module | BufferSource | null = null,
  weapon: WeaponID = DEFAULT_WEAPON,
) {
  const source =
    core || (await (await fetch(new URL('./lab.wasm', import.meta.url))).arrayBuffer());
  const imports = {
    math: { pow: Math.pow, sin: Math.sin, cos: Math.cos },
  };
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (await WebAssembly.instantiate(source, imports)).instance;
  if (
    !(instance.exports.memory instanceof WebAssembly.Memory) ||
    CORE_FUNCTIONS.some((name) => typeof instance.exports[name] !== 'function')
  ) {
    throw Error('Incompatible WebAssembly scanner interface');
  }
  const e = instance.exports as CoreExports;
  const mapPtr = e.map_ptr(buffer.byteLength);
  if (!mapPtr) throw Error('The WASM core could not reserve memory for this BSP');
  new Uint8Array(e.memory.buffer, mapPtr, buffer.byteLength).set(new Uint8Array(buffer));
  if (!e.map_load(buffer.byteLength)) throw Error('The WASM core rejected this BSP');
  const table = materialTable(materials);
  bsp.textures.forEach((t, i) => {
    e.set_material(i, textureMaterial(t.name, table));
  });
  function syncBrushes() {
    for (const b of bsp.brushes.slice(1))
      e.set_brush(b.index, b.solid ? 1 : 0, ...b.origin, ...b.angles);
  }
  syncBrushes();
  function setWeapon(preset: WeaponPreset) {
    if (
      !e.set_weapon(
        preset.damage,
        preset.maxDistance,
        preset.impacts,
        preset.power,
        preset.penetrationDistance,
        preset.rangeModifier,
        preset.pellets > 1 ? 1 : 0,
      )
    ) {
      throw Error('The WASM core rejected this weapon preset');
    }
  }
  setWeapon(getWeapon(weapon));
  return {
    e,
    setWeapon,
    syncBrushes,
    trace(s: number[], t: number[], hull = 0) {
      e.trace(...s, ...t, hull);
      return Array.from(new Float32Array(e.memory.buffer, e.io_ptr(), 11));
    },
    target(pose: Pose, expansion = 0.5) {
      e.clear_target();
      const io = new Float32Array(e.memory.buffer, e.io_ptr(), 128);
      for (const b of pose.boxes) {
        if (b.group === 8) continue;
        io.set([...b.matrix, ...b.mins, ...b.maxs]);
        e.add_hitbox(b.group, expansion);
      }
      pose.aims.forEach((a, i) => {
        e.set_aim(i, ...a);
      });
    },
    sample(input: Float32Array, count: number) {
      new Float32Array(e.memory.buffer, e.jobs_ptr(), count * 6).set(input.subarray(0, count * 6));
      e.sample_batch(count);
      return new Float32Array(e.memory.buffer, e.results_ptr(), count * 14).slice();
    },
    fire(eye: number[], aim: number[]) {
      e.fire(...eye, ...aim);
      return Array.from(new Float32Array(e.memory.buffer, e.io_ptr(), 3));
    },
  };
}
export function damage(
  raw: number,
  group: number,
  armorType: number,
  armorValue: number,
  armorRatio = getWeapon().armorRatio,
) {
  const protectedPart =
    armorType > 0 && ([0, 2, 3, 4, 5].includes(group) || (group === 1 && armorType === 2));
  if (protectedPart && armorValue > 0) {
    const reduced = Math.fround(raw * Math.fround(armorRatio)),
      cost = Math.fround(Math.fround(raw - reduced) * 0.5);
    raw = cost > armorValue ? Math.fround(raw - armorValue * 2) : reduced;
  }
  return Math.floor(raw);
}
