import { materialTable } from '../engine/bsp.ts';
import { postureSequence } from '../engine/placement.ts';
import { readStudio } from '../engine/studio.ts';
import type { Assets, BSP, SkySide } from '../engine/types.ts';
import { readWadIndex, readWadTexture } from '../engine/wad.ts';
import { readTGA, SKY_SIDES } from '../render/skybox.ts';
import { get, hash, put } from './cache.ts';
import { chooseFiles, mapDependencies } from './game-files.ts';
import type { GameFile, ImportProgress, LibraryCatalog, LibraryMapRef } from './library-types.ts';
import { type LibraryStore, opfsStore } from './opfs.ts';

export const LIBRARY_KEY = 'game-library-v1';
export const getLibrary = () => get<LibraryCatalog>('assets', LIBRARY_KEY);
export function assetRecord(assets: Assets): Assets {
  return assets.library
    ? {
        library: assets.library,
        mapName: assets.mapName,
        snapshot: assets.snapshot,
        skyOverride: assets.skyOverride,
      }
    : assets;
}
export interface ImportOptions {
  store: LibraryStore;
  progress?: (message: ImportProgress) => void;
  cancelled?: () => boolean;
  publish?: (catalog: LibraryCatalog) => Promise<void>;
}
export async function importGameFiles(
  files: GameFile[],
  options: ImportOptions,
): Promise<LibraryCatalog> {
  const plan = chooseFiles(files);
  const warnings: string[] = [];
  let bytes = 0,
    done = 0;
  const checkpoint = () => {
    if (options.cancelled?.()) throw new DOMException('Import cancelled', 'AbortError');
  };
  function progress(phase: string, total: number) {
    checkpoint();
    options.progress?.({ type: 'progress', phase, done, total, bytes });
  }
  const used = new Map<string, string>();
  async function save(source: GameFile, buffer: ArrayBuffer) {
    checkpoint();
    const digest = await hash(buffer);
    await options.store.write(digest, buffer);
    checkpoint();
    if (!used.has(digest)) bytes += buffer.byteLength;
    used.set(digest, source.path);
    return digest;
  }
  let model: string | undefined;
  for (const source of plan.models) {
    progress('Checking player model', 0);
    try {
      if (source.file.size > 16 * 1048576) throw Error('Player model exceeds 16 MiB');
      const buffer = await source.file.arrayBuffer(),
        parsed = readStudio(buffer);
      for (const duck of [false, true]) {
        const seq = postureSequence(parsed.sequences, duck);
        if (!seq) throw Error('Model has no supported standing/crouching pose');
        parsed.pose(seq.index, [0, 0, 0], 0, 0, true, { gait: 1 });
      }
      model = await save(source, buffer);
      break;
    } catch (e) {
      if (e instanceof DOMException) throw e;
      warnings.push(`${source.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!model)
    throw Error(
      'No supported CS player model found. Import a model with embedded standing/crouching animations.',
    );
  done++;
  if (plan.materials.file.size > 2 * 1048576) throw Error('materials.txt exceeds 2 MiB');
  const materialBytes = await plan.materials.file.arrayBuffer();
  if (!materialTable(new TextDecoder().decode(materialBytes)).size)
    throw Error('materials.txt has no material definitions');
  const materials = await save(plan.materials, materialBytes);
  done++;
  const maps: { source: GameFile; map: string; sky: string; wads: string[]; external: string[] }[] =
    [];
  for (const source of plan.maps) {
    progress(`Importing ${source.file.name}`, 0);
    try {
      if (source.file.size > 32 * 1048576) throw Error('Map exceeds 32 MiB');
      const buffer = await source.file.arrayBuffer();
      const dependencies = mapDependencies(buffer);
      maps.push({ source, map: await save(source, buffer), ...dependencies });
    } catch (e) {
      if (e instanceof DOMException) throw e;
      warnings.push(`${source.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    done++;
  }
  if (!maps.length) throw Error('No supported GoldSrc BSP v30 maps found');
  const neededWads = [...new Set(maps.flatMap((m) => m.wads))];
  const external = new Set(maps.flatMap((m) => m.external));
  const neededSkies = [...new Set(maps.map((m) => m.sky))];
  const total = plan.maps.length + 2 + neededWads.length + neededSkies.length * 6;
  const wads = new Map<string, string>();
  for (const name of neededWads) {
    progress(`Importing ${name}`, total);
    const source = plan.wads.get(name);
    if (source) {
      try {
        const entries = await readWadIndex(source.file);
        if ([...external].some((texture) => entries.has(texture)))
          wads.set(name, await save(source, await source.file.arrayBuffer()));
      } catch (e) {
        if (e instanceof DOMException) throw e;
        warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else
      warnings.push(`WAD not found: ${name} (only needed for textures not embedded in the BSP)`);
    done++;
  }
  const skies = new Map<string, Record<SkySide, string>>();
  for (const sky of neededSkies) {
    const faces = {} as Record<SkySide, string>;
    const dimensions: number[] = [];
    for (const side of SKY_SIDES) {
      progress(`Importing ${sky}${side}.tga`, total);
      const source = plan.skies.get(`${sky}${side}.tga`);
      if (source) {
        try {
          if (source.file.size > 8 * 1048576) throw Error('Sky TGA exceeds 8 MiB');
          const buffer = await source.file.arrayBuffer(),
            decoded = readTGA(buffer);
          if (decoded.width !== decoded.height) throw Error('Sky TGA must be square');
          dimensions.push(decoded.width);
          faces[side] = await save(source, buffer);
        } catch (e) {
          if (e instanceof DOMException) throw e;
          warnings.push(`${source.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      done++;
    }
    if (SKY_SIDES.every((side) => !!faces[side]) && dimensions.every((n) => n === dimensions[0]))
      skies.set(sky, faces);
    else warnings.push(`Sky not imported: ${sky} (six matching TGAs are needed)`);
  }
  checkpoint();
  const selectedModel = model;
  const catalog: LibraryCatalog = {
    version: 1,
    imported: Date.now(),
    bytes,
    files: used.size,
    warnings,
    maps: maps.map((m) => ({
      version: 1,
      name: m.source.file.name.replace(/\.bsp$/i, ''),
      map: m.map,
      model: selectedModel,
      materials,
      wads: m.wads.map((n) => wads.get(n)).filter((n): n is string => !!n),
      ...(skies.has(m.sky)
        ? { skybox: { name: m.sky, faces: skies.get(m.sky) as Record<SkySide, string> } }
        : {}),
    })),
  };
  await (options.publish || ((value) => put('assets', LIBRARY_KEY, value)))(catalog);
  options.progress?.({ type: 'progress', phase: 'Imported', done: total, total, bytes });
  return catalog;
}

export async function loadLibraryAssets(
  library: LibraryMapRef,
  store?: LibraryStore,
): Promise<Assets> {
  store ||= await opfsStore();
  const read = async (key: string) => (await store.read(key)).arrayBuffer();
  const [map, model, materialBytes] = await Promise.all([
    read(library.map),
    read(library.model),
    read(library.materials),
  ]);
  const sky = library.skybox;
  const skybox = sky
    ? {
        name: sky.name,
        faces: Object.fromEntries(
          await Promise.all(SKY_SIDES.map(async (side) => [side, await read(sky.faces[side])])),
        ) as Record<SkySide, ArrayBuffer>,
      }
    : null;
  return {
    map,
    model,
    materials: new TextDecoder().decode(materialBytes),
    mapName: library.name,
    library,
    skybox,
    snapshot: undefined,
  };
}

export async function hydrateMapTextures(bsp: BSP, library: LibraryMapRef, store?: LibraryStore) {
  const missing = new Map(
    bsp.textures.filter((t) => !t.rgba).map((t) => [t.name.toLowerCase(), t]),
  );
  if (!missing.size || !library.wads.length) return;
  store ||= await opfsStore();
  for (const key of library.wads) {
    if (!missing.size) break;
    const file = await store.read(key),
      entries = await readWadIndex(file);
    for (const [name, target] of missing) {
      const entry = entries.get(name);
      if (!entry) continue;
      const texture = readWadTexture(
        await file.slice(entry.offset, entry.offset + entry.size).arrayBuffer(),
      );
      if (texture.name.toLowerCase() !== name)
        throw Error('WAD texture name does not match directory');
      Object.assign(target, texture);
      missing.delete(name);
    }
  }
}
