import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { test } from 'vitest';
import { readBSP } from '../src/engine/bsp';
import { buildLightmapAtlas } from '../src/render/lightmaps';
import { buildMapMeshes } from '../src/render/map';

function fixture({ offset = 0, special = false, lighting = true } = {}) {
  const lumps = Array.from({ length: 15 }, () => Buffer.alloc(0));
  lumps[1] = Buffer.alloc(20);
  lumps[1].writeFloatLE(1, 8);
  lumps[2] = Buffer.alloc(8);
  lumps[2].writeInt32LE(1);
  lumps[2].writeInt32LE(-1, 4);
  lumps[3] = Buffer.alloc(48);
  [
    [0, 0],
    [0, 16],
    [16, 16],
    [16, 0],
  ].forEach(([x, y], j) => {
    lumps[3].writeFloatLE(x, j * 12);
    lumps[3].writeFloatLE(y, j * 12 + 4);
  });
  lumps[6] = Buffer.alloc(40);
  lumps[6].writeFloatLE(-1, 0);
  lumps[6].writeFloatLE(-8, 12);
  lumps[6].writeFloatLE(1, 20);
  lumps[6].writeFloatLE(8, 28);
  lumps[6].writeInt32LE(Number(special), 36);
  lumps[7] = Buffer.alloc(20);
  lumps[7].writeUInt16LE(4, 8);
  lumps[7].set([0, 3, 255, 255], 12);
  lumps[7].writeInt32LE(offset, 16);
  if (lighting) lumps[8] = Buffer.from(Array.from({ length: 54 }, (_, i) => i + 1));
  lumps[12] = Buffer.alloc(16);
  lumps[13] = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    lumps[12].writeUInt16LE(i, i * 4);
    lumps[12].writeUInt16LE((i + 1) % 4, i * 4 + 2);
    lumps[13].writeInt32LE(i, i * 4);
  }
  lumps[14] = Buffer.alloc(64);
  lumps[14].writeInt32LE(1, 60);
  const header = Buffer.alloc(124);
  header.writeInt32LE(30);
  let start = 124;
  lumps.forEach((l, i) => {
    header.writeInt32LE(start, 4 + i * 8);
    header.writeInt32LE(l.length, 8 + i * 8);
    start += l.length;
  });
  return Uint8Array.from(Buffer.concat([header, ...lumps])).buffer;
}

test('v30 lightmap extents use floor/ceil of authored negative texinfo axes and shared RGB bytes', () => {
  const buffer = fixture(),
    face = readBSP(buffer).faces[0];
  assert.deepEqual(face.lightmap?.mins, [-2, 0]);
  assert.equal(face.lightmap?.width, 3);
  assert.equal(face.lightmap?.height, 3);
  assert.deepEqual(face.lightmap?.styles, [0, 3]);
  assert.strictEqual(face.lightmap?.samples.buffer, buffer);
  assert.deepEqual(
    Array.from(face.lightmap?.samples ?? []),
    Array.from({ length: 54 }, (_, i) => i + 1),
  );
  const { lightmap: _, ...displayFace } = face;
  assert.deepEqual(readBSP(buffer, { pixels: false }).faces[0], displayFace);
});

test('unlit and special faces keep the fallback; malformed lighting ranges fail only the display reader', () => {
  for (const options of [{ offset: -1 }, { special: true }, { lighting: false }])
    assert.equal(readBSP(fixture(options)).faces[0].lightmap, undefined);
  assert.throws(() => readBSP(fixture({ offset: 1 })), /Invalid BSP index in lump 8/);
  assert.doesNotThrow(() => readBSP(fixture({ offset: 1 }), { pixels: false }));
});

test('lightmap bounds round projected coordinates to float before floor/ceil at positive and negative luxel edges', () => {
  const buffer = fixture(),
    view = new DataView(buffer),
    vertices = view.getInt32(4 + 3 * 8, true),
    texinfo = view.getInt32(4 + 6 * 8, true);
  // Stored float32 scale produces +/-16.0000004768 in JS double precision.
  // The compiler's final float assignment gives exactly +/-16: a 2x2 map.
  view.setFloat32(texinfo, 4 / 3, true);
  view.setFloat32(texinfo + 12, 0, true);
  view.setFloat32(texinfo + 20, -4 / 3, true);
  view.setFloat32(texinfo + 28, 0, true);
  for (let i = 0; i < 4; i++)
    for (const axis of [0, 1]) {
      const at = vertices + i * 12 + axis * 4;
      if (view.getFloat32(at, true)) view.setFloat32(at, 12, true);
    }
  const face = readBSP(buffer).faces[0];
  assert.ok(face.uv.some(([s, t]) => s > 16 || t < -16));
  assert.deepEqual(face.lightmap?.mins, [0, -1]);
  assert.equal(face.lightmap?.width, 2);
  assert.equal(face.lightmap?.height, 2);
  assert.equal(face.lightmap?.samples.length, 2 * 2 * 3 * 2);
  const { lightmap: _, ...displayFace } = face;
  assert.deepEqual(readBSP(buffer, { pixels: false }).faces[0], displayFace);
});

test('atlas keeps irradiance linear, sums styles, duplicates edge gutters and maps texel centers', () => {
  const face = readBSP(fixture()).faces[0];
  const atlas = buildLightmapAtlas([face], 16);
  assert.equal(atlas.textures.length, 1);
  const texture = atlas.textures[0];
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.equal(texture.channel, 1);
  assert.equal(texture.generateMipmaps, false);
  const placement = atlas.placements.get(face);
  assert.ok(placement);
  assert.deepEqual(placement.uv[0], [4 / 16, 2 / 16]);
  const data = texture.image.data;
  const pixel = (x: number, y: number) =>
    Array.from(data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
  // Style 0 first RGB = 1,2,3; style 3 first RGB = 28,29,30.
  assert.deepEqual(pixel(2, 1), [29, 31, 33, 255]);
  assert.deepEqual(pixel(1, 0), pixel(2, 1));
  assert.deepEqual(pixel(0, 0), [128, 128, 128, 255]);
});

test('atlas overflow retains every face on a new page and brush transforms never move luxels', () => {
  const bsp = readBSP(fixture());
  const faces = Array.from({ length: 12 }, () => ({ ...bsp.faces[0] }));
  const atlas = buildLightmapAtlas(faces, 8);
  assert.equal(atlas.placements.size, 12);
  assert.equal(atlas.textures.length, 12);
  assert.equal(buildLightmapAtlas(faces, 5).placements.size, 0);
  assert.equal(buildMapMeshes(bsp)[0].geometry.getAttribute('position').count, 6);
  const before = JSON.stringify(bsp.faces);
  const first = buildMapMeshes(bsp)[0];
  bsp.brushes[0].origin = [100, 200, 300];
  bsp.brushes[0].angles = [0, 90, 0];
  const moved = buildMapMeshes(bsp)[0];
  assert.equal(JSON.stringify(bsp.faces), before);
  assert.deepEqual(
    first.geometry.getAttribute('uv1').array,
    moved.geometry.getAttribute('uv1').array,
  );
  assert.notDeepEqual(
    first.geometry.getAttribute('position').array,
    moved.geometry.getAttribute('position').array,
  );
  assert.equal(first.material.lightMapIntensity, Math.PI * 2);
});

const asset = new URL('../assets/de_inferno.bsp', import.meta.url);
test('local Inferno lightmaps preserve triangle/texture batches and avoid modifying trace geometry', {
  skip: !existsSync(asset),
}, () => {
  const buffer = Uint8Array.from(readFileSync(asset)).buffer;
  const baked = readBSP(buffer),
    unlit = readBSP(buffer);
  const originalFaces = JSON.stringify(baked.faces.map(({ lightmap: _, ...f }) => f));
  for (const f of unlit.faces) delete f.lightmap;
  const meshes = buildMapMeshes(baked),
    old = buildMapMeshes(unlit);
  assert.equal(meshes.length, old.length);
  assert.ok(baked.faces.filter((f) => f.lightmap).length > 8000);
  // Inferno packs consecutive lighting blocks without padding. A width/height
  // rounding error can stay inside the lump while reading the next face's RGB.
  const data = new DataView(buffer),
    faceStart = data.getInt32(4 + 7 * 8, true),
    lightBytes = data.getInt32(8 + 8 * 8, true);
  const blocks = baked.faces
    .filter((f) => f.lightmap)
    .map((f) => ({ f, offset: data.getInt32(faceStart + f.index * 20 + 16, true) }))
    .sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < blocks.length; i++) {
    const { f, offset } = blocks[i];
    assert.equal(
      f.lightmap?.samples.length,
      (blocks[i + 1]?.offset ?? lightBytes) - offset,
      `Face ${f.index} lightmap must end at the next stored lighting block`,
    );
  }
  const atlases = new Set(meshes.map((m) => m.material.lightMap));
  assert.equal(atlases.size, 1);
  for (let i = 0; i < meshes.length; i++) {
    assert.equal(meshes[i].name, old[i].name);
    for (const name of ['position', 'uv'])
      assert.deepEqual(
        meshes[i].geometry.getAttribute(name).array,
        old[i].geometry.getAttribute(name).array,
      );
  }
  assert.equal(JSON.stringify(baked.faces.map(({ lightmap: _, ...f }) => f)), originalFaces);
});
