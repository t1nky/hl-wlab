import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageBase } from '../cs2/package';
import { LocalCs2Library, mapResources } from '../local-cs2-library';

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'wlab-cs2-library-'));
  folders.push(folder);
  return folder;
}
function vpk(entries: [string, string, string][]) {
  const groups = new Map<string, Map<string, string[]>>();
  for (const [extension, path, name] of entries) {
    const paths = groups.get(extension) ?? new Map();
    const names = paths.get(path) ?? [];
    names.push(name);
    paths.set(path, names);
    groups.set(extension, paths);
  }
  const parts: Buffer[] = [];
  const text = (s: string) => parts.push(Buffer.from(`${s}\0`));
  for (const [extension, paths] of groups) {
    text(extension);
    for (const [path, names] of paths) {
      text(path);
      for (const name of names) {
        text(name);
        const entry = Buffer.alloc(18);
        entry.writeUInt16LE(0xffff, 16);
        parts.push(entry);
      }
      text('');
    }
    text('');
  }
  text('');
  const tree = Buffer.concat(parts),
    header = Buffer.alloc(28);
  header.writeUInt32LE(0x55aa1234);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(tree.length, 8);
  return Buffer.concat([header, tree]);
}
it('discovers named map worlds from VPK directory entries, excluding skies without collision', async () => {
  const folder = await fixture();
  const game = join(folder, 'game-install');
  await mkdir(join(game, 'game/csgo/maps'), { recursive: true });
  await writeFile(join(game, 'game/csgo/steam.inf'), 'fixture');
  const source = join(game, 'game/csgo/maps/custom-map.vpk');
  await writeFile(
    source,
    vpk([
      ['vmap_c', 'maps', 'custom-map'],
      ['vmap_c', 'maps', 'custom_sky'],
      ['vrman_c', 'maps/custom-map', 'world_physics'],
    ]),
  );
  expect(await mapResources(source)).toEqual(['maps/custom-map.vmap']);
  vi.stubEnv('CS2_GAME', game);
  const library = new LocalCs2Library(join(folder, 'cache'), folder);
  expect((await library.catalog()).maps).toEqual([
    { id: 'custom-map', name: 'custom-map', installed: true, ready: false },
  ]);
  await expect(library.prepare('../custom-map')).rejects.toThrow('Invalid');
  await expect(library.prepare('unknown')).rejects.toThrow('not found');
  await writeFile(source, vpk([['vmap_c', 'maps', 'custom-map']]).subarray(0, 32));
  await expect(mapResources(source)).rejects.toThrow('Truncated');
});
it('loads transferred cached packages without Steam; rejects mismatched or incomplete packages', async () => {
  const folder = await fixture();
  const root = join(folder, 'cache'),
    map = join(root, 'custom-map');
  vi.stubEnv('CS2_GAME', join(folder, 'not-installed'));
  await mkdir(join(map, 'render'), { recursive: true });
  await writeFile(
    join(map, 'map.json'),
    JSON.stringify({
      schema: 1,
      map: 'custom-map',
      fingerprint: 'physics',
      steamInf: 'build',
      binaryBytes: 4,
    }),
  );
  await writeFile(join(map, 'map.cs2map'), '1234');
  await writeFile(join(map, 'player.json'), JSON.stringify({ steamInf: 'build' }));
  await writeFile(join(map, 'render/chunk.gltf'), 'gltf');
  const render = {
    schema: 1,
    collisionFingerprint: 'physics',
    compression: { codec: 'EXT_meshopt_compression v0' },
    files: [{ path: 'render/chunk.gltf', bytes: 4 }],
  };
  await writeFile(join(map, 'render.json'), JSON.stringify(render));
  const library = new LocalCs2Library(root, folder);
  expect(await library.catalog()).toMatchObject({
    sourceAvailable: false,
    maps: [{ id: 'custom-map', installed: false, ready: true }],
  });
  expect((await library.prepare('custom-map')).status).toBe('complete');
  await writeFile(
    join(map, 'render.json'),
    JSON.stringify({ ...render, collisionFingerprint: 'other-map' }),
  );
  expect((await library.catalog()).maps).toEqual([]);
  await writeFile(join(map, 'render.json'), JSON.stringify(render));
  await rm(join(map, 'render/chunk.gltf'));
  expect((await library.catalog()).maps).toEqual([]);
});
it('keeps arbitrary map package URLs separate and rejects path traversal', () => {
  expect(packageBase('de_mirage')).toBe('/local/maps/de_mirage/');
  expect(packageBase('custom-map-123')).toBe('/local/maps/custom-map-123/');
  expect(packageBase()).toBe('/local/');
  for (const id of ['', '..', '../de_inferno', 'foo/bar', 'foo\\bar', 'foo?map=bar'])
    expect(() => packageBase(id)).toThrow('Invalid');
});
