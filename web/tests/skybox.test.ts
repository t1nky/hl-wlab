import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { DataTexture } from 'three';
import { test } from 'vitest';
import type { Skybox } from '../src/engine/types.ts';
import {
  buildSkybox,
  fetchSkybox,
  importSkyFiles,
  readTGA,
  SKY_SIDES,
  skyName,
} from '../src/render/skybox.ts';

function tga({ flags = 32, depth = 24, rle = false } = {}) {
  const header = new Uint8Array(18);
  header[2] = rle ? 10 : 2;
  header[12] = header[14] = 2;
  header[16] = depth;
  header[17] = flags;
  const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ],
    data = [];
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      const rgb = colors[(flags & 32 ? y : 1 - y) * 2 + (flags & 16 ? 1 - x : x)];
      data.push(...rgb.toReversed());
      if (depth === 32) data.push(47);
    }
  return Uint8Array.from([...header, ...(rle ? [3, ...data] : data)]).buffer;
}
test('TGA decoder handles BGR/BGRA, four origins and raw RLE packets with opaque sky pixels', () => {
  const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255];
  for (const flags of [0, 16, 32, 48])
    for (const depth of [24, 32])
      for (const rle of [false, true])
        assert.deepEqual([...readTGA(tga({ flags, depth, rle })).rgba], expected);
  const data = new Uint8Array(22);
  data.set(new Uint8Array(tga()).subarray(0, 18));
  data[2] = 10;
  data.set([131, 9, 8, 7], 18);
  assert.deepEqual(
    [...readTGA(data.buffer).rgba],
    Array.from({ length: 4 }, () => [7, 8, 9, 255]).flat(),
  );
});
test('TGA decoder rejects truncated, oversized, indexed and overrun images', () => {
  assert.throws(() => readTGA(new ArrayBuffer(17)));
  assert.throws(() => readTGA(tga().slice(0, 20)));
  for (const [offset, value] of [
    [1, 1],
    [2, 3],
    [16, 16],
    [17, 192],
    [13, 8],
  ]) {
    const bad = tga();
    new Uint8Array(bad)[offset] = value;
    assert.throws(() => readTGA(bad));
  }
  const bad = tga({ rle: true });
  new Uint8Array(bad)[18] = 4;
  assert.throws(() => readTGA(bad));
});
test('sky names and six-file imports are tied to the map; incomplete imports do not silently mix skies', async () => {
  assert.equal(skyName({ entities: [{ classname: 'worldspawn', skyname: 'Green' }] }), 'green');
  assert.throws(() => skyName({ entities: [{ classname: 'worldspawn', skyname: '../secret' }] }));
  const files = SKY_SIDES.map((side) => ({
    name: `green${side}.tga`,
    size: 30,
    arrayBuffer: async () => tga(),
  }));
  const sky = await importSkyFiles(files, 'green');
  assert.equal(Object.keys(sky.faces).length, 6);
  assert.equal(buildSkybox(sky).images.length, 6);
  assert.throws(() => importSkyFiles(files.slice(1), 'green'));
  assert.throws(() => importSkyFiles(files, 'other'));
  assert.throws(() => importSkyFiles([...files.slice(1), files[1]], 'green'));
  assert.throws(() => buildSkybox({ ...sky, faces: { ...sky.faces, rt: new ArrayBuffer(0) } }));
  const rectangular = tga();
  new Uint8Array(rectangular)[14] = 1;
  assert.throws(() => buildSkybox({ ...sky, faces: { ...sky.faces, rt: rectangular } }), /square/);
});
test('local sky loading requires a complete set and treats all missing faces as an optional sky', async () => {
  const urls: string[] = [],
    sky = await fetchSkybox('green', async (url) => {
      urls.push(url);
      return new Response(tga());
    });
  assert.ok(sky);
  assert.equal(sky.name, 'green');
  assert.equal(urls.length, 6);
  assert.ok(urls.every((url) => url.startsWith('assets/gfx/env/green')));
  assert.equal(await fetchSkybox('missing', async () => new Response(null, { status: 404 })), null);
  await assert.rejects(
    fetchSkybox(
      'partial',
      async (url) => new Response(null, { status: url.endsWith('rt.tga') ? 200 : 404 }),
    ),
    /Incomplete/,
  );
  await assert.rejects(
    fetchSkybox('failure', async () => new Response(null, { status: 403 })),
    /403/,
  );
});
const root = new URL('../assets/gfx/env/', import.meta.url);
test('installed Inferno sky decodes all six 256px images and builds one filtered Z-up cubemap', {
  skip: !existsSync(new URL('greenrt.tga', root)),
}, () => {
  const sky = {
    name: 'green',
    faces: Object.fromEntries(
      SKY_SIDES.map((side) => [
        side,
        Uint8Array.from(readFileSync(new URL(`green${side}.tga`, root))).buffer,
      ]),
    ) as Skybox['faces'],
  };
  for (const file of Object.values(sky.faces)) {
    const t = readTGA(file);
    assert.equal(t.width, 256);
    assert.equal(t.height, 256);
  }
  const cube = buildSkybox(sky);
  assert.equal(cube.images.length, 6);
  assert.equal(cube.flipY, false);
  assert.equal(cube.generateMipmaps, false);
  assert.equal(
    cube.images.reduce((sum: number, t: DataTexture) => sum + t.image.data.byteLength, 0),
    1572864,
  );
  const ft = readTGA(sky.faces.ft);
  assert.deepEqual(cube.images[3].image.data, ft.rgba);
});
