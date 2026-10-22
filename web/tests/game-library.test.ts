import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readBSP } from '../src/engine/bsp.ts';
import { readWadIndex, readWadTexture } from '../src/engine/wad.ts';
import {
  chooseFiles,
  filesFromUpload,
  gamePath,
  mapDependencies,
} from '../src/storage/game-files.ts';
import {
  assetRecord,
  hydrateMapTextures,
  importGameFiles,
  loadLibraryAssets,
} from '../src/storage/game-library.ts';
import type { GameFile, LibraryCatalog } from '../src/storage/library-types.ts';
import type { LibraryStore } from '../src/storage/opfs.ts';
import { gameMap, mipTexture, playerModel, skyTGA, wadFile } from './helpers/game-files.ts';

class MemoryStore implements LibraryStore {
  files = new Map<string, File>();
  writes = 0;
  async write(key: string, data: ArrayBuffer) {
    if (this.files.has(key)) return false;
    this.files.set(key, new File([data], key));
    this.writes++;
    return true;
  }
  async read(key: string) {
    const file = this.files.get(key);
    if (!file) throw Error('File missing');
    return file;
  }
}
function source(path: string, data: ArrayBuffer | string): GameFile {
  return { path, file: new File([data], path.split('/').at(-1) || 'file') };
}
function fixtures(external = true) {
  return [
    source('Half-Life/cstrike/maps/de_test.bsp', gameMap(external)),
    source('Half-Life/cstrike/models/player.mdl', playerModel()),
    source('Half-Life/cstrike/sound/materials.txt', 'M metal\nW wood\n'),
    source('Half-Life/cstrike/test.wad', wadFile()),
    ...['rt', 'bk', 'lf', 'ft', 'up', 'dn'].map((side) =>
      source(`Half-Life/valve/gfx/env/testsky${side}.tga`, skyTGA()),
    ),
  ];
}
const setup = () => {
  const store = new MemoryStore();
  let published: LibraryCatalog | undefined;
  return {
    store,
    get published() {
      return published;
    },
    options: {
      store,
      publish: async (catalog: LibraryCatalog) => {
        published = catalog;
      },
    },
  };
};

test('folder allowlist normalizes game paths while excluding unrelated and unsafe files', () => {
  assert.equal(gamePath('Half-Life/CSTRIKE/Maps/DE_TEST.BSP'), 'cstrike/maps/de_test.bsp');
  assert.equal(
    gamePath('cstrike/models/player/leet/leet.mdl'),
    'cstrike/models/player/leet/leet.mdl',
  );
  for (const path of [
    'Half-Life/steam.cfg',
    'cstrike/config.cfg',
    'cstrike/models/v_awp.mdl',
    'cstrike/../valve/halflife.wad',
    'valve/maps/c1a0.bsp',
    'cstrike/demos/a.dem',
    'cstrike/models/player/leet/leetT.mdl',
  ])
    assert.equal(gamePath(path), null, path);
  const a = fixtures();
  const duplicate = source('Half-Life/cstrike_downloads/maps/de_test.bsp', 'download');
  assert.equal(chooseFiles([duplicate, ...a]).maps[0].file, a[0].file);
  assert.equal(chooseFiles([...a].reverse()).maps[0].file, a[0].file);
  assert.throws(() => chooseFiles([]), /No Counter-Strike maps/);
  assert.throws(() => chooseFiles([a[0]]), /player model/);
  assert.throws(() => chooseFiles(a.filter((f) => f.path !== a[2].path)), /materials/);
});

test('folder upload filters unrelated files without reading or copying file contents', () => {
  const sources = [
    ...fixtures(),
    source('Half-Life/cstrike/config.cfg', 'ignored'),
    source('Half-Life/cstrike/models/v_awp.mdl', 'ignored'),
  ];
  const files = sources.map(({ path, file }) => {
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        throw Error('File contents read during discovery');
      },
    });
    return file;
  });
  const selected = filesFromUpload(files);
  assert.equal(selected.length, fixtures().length);
  assert.equal(selected[0].file, files[0]);
  assert.equal(selected[0].path, 'cstrike/maps/de_test.bsp');
  assert.ok(selected.every((item) => gamePath(item.path) === item.path));
  assert.deepEqual(filesFromUpload([]), []);
});

test('BSP dependencies include only external WAD needs, with Windows paths normalized', () => {
  assert.deepEqual(mapDependencies(gameMap()), {
    sky: 'testsky',
    wads: ['test.wad', 'halflife.wad'],
    external: ['{test'],
  });
  assert.deepEqual(mapDependencies(gameMap(false)).wads, []);
  assert.throws(() => mapDependencies(new ArrayBuffer(10)), /BSP v30/);
  const corrupt = gameMap();
  new DataView(corrupt).setInt32(4, corrupt.byteLength, true);
  assert.throws(() => mapDependencies(corrupt), /Invalid BSP/);
});

test('WAD3 palette decoding preserves colors and masked transparency and rejects malformed ranges', async () => {
  const file = new File([wadFile()], 'test.wad'),
    entries = await readWadIndex(file),
    entry = entries.get('{test');
  assert.ok(entry);
  const texture = readWadTexture(
    await file.slice(entry.offset, entry.offset + entry.size).arrayBuffer(),
  );
  assert.equal(texture.width, 16);
  assert.ok(texture.rgba);
  assert.equal(texture.rgba[3], 0);
  assert.deepEqual(Array.from(texture.rgba.slice(4, 8)), [17, 33, 65, 255]);
  const bad = mipTexture();
  new DataView(bad).setUint32(24, 0xffffffff, true);
  assert.throws(() => readWadTexture(bad), /mip range/);
  await assert.rejects(readWadIndex(new Blob(['not a wad'])), /WAD size/);
});

test('complete folder import, OPFS-style file deduplication, map load and lazy WAD hydration', async () => {
  const env = setup(),
    progress: number[] = [];
  const catalog = await importGameFiles(fixtures(), {
    ...env.options,
    progress: (p) => progress.push(p.done),
  });
  assert.equal(env.published, catalog);
  assert.equal(catalog.maps.length, 1);
  assert.equal(env.store.writes, 5); // one map/model/material/WAD and identical six sky faces
  assert.equal(catalog.files, 5);
  assert.equal(catalog.maps[0].skybox?.name, 'testsky');
  assert.equal(progress.at(-1), 11);
  const assets = await loadLibraryAssets(catalog.maps[0], env.store);
  assert.ok(assets.map);
  assert.ok(assets.model);
  assert.ok(assets.skybox);
  assert.equal(assets.mapName, 'de_test');
  assert.equal(assets.materials, 'M metal\nW wood\n');
  const bsp = readBSP(assets.map);
  assert.equal(Boolean(bsp.textures[0].rgba), false);
  await hydrateMapTextures(bsp, catalog.maps[0], env.store);
  assert.ok(bsp.textures[0].rgba);
  assert.deepEqual(Array.from(bsp.textures[0].rgba.slice(4, 8)), [17, 33, 65, 255]);
  const record = assetRecord(assets);
  assert.equal(record.map, undefined);
  assert.equal(record.model, undefined);
  assert.equal(record.materials, undefined);
  assert.equal(record.skybox, undefined);
  assert.deepEqual(record.library, catalog.maps[0]);
  await importGameFiles(fixtures(), env.options);
  assert.equal(env.store.writes, 5);
});

test('fully embedded maps do not copy WAD archives they do not need', async () => {
  const env = setup();
  const catalog = await importGameFiles(fixtures(false), env.options);
  assert.equal(env.store.writes, 4);
  assert.deepEqual(catalog.maps[0].wads, []);
  assert.equal(catalog.warnings.length, 0);
});

test('incomplete sky sets and unsupported maps are reported while usable maps remain available', async () => {
  const env = setup();
  const files = fixtures().filter((f) => !f.path.endsWith('testskydn.tga'));
  files.push(source('cstrike/maps/de_bad.bsp', 'not a map'));
  const catalog = await importGameFiles(files, env.options);
  assert.equal(catalog.maps.length, 1);
  assert.equal(catalog.maps[0].skybox, undefined);
  assert.ok(catalog.warnings.some((s) => s.includes('de_bad.bsp')));
  assert.ok(catalog.warnings.some((s) => s.includes('Sky not imported')));
});

test('cancellation and storage errors never publish a partial library', async () => {
  const env = setup();
  let cancelled = false;
  await assert.rejects(
    importGameFiles(fixtures(), {
      ...env.options,
      cancelled: () => cancelled,
      progress: (p) => {
        if (p.phase.startsWith('Importing')) cancelled = true;
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(env.published, undefined);
  const failed = setup();
  failed.store.write = async () => {
    throw new DOMException('Full', 'QuotaExceededError');
  };
  await assert.rejects(importGameFiles(fixtures(), failed.options), { name: 'QuotaExceededError' });
  assert.equal(failed.published, undefined);
});
