import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { test } from 'vitest';
import { readBSP } from '../src/engine/bsp.ts';
import { buildMapMeshes } from '../src/render/map.ts';

// Authored indexed pixels exercise every palette entry and the transparent
// index. All four mip levels precede the palette, as in a GoldSrc v30 BSP.
function indexedBSP(masked = false) {
  const lumps = Array.from({ length: 15 }, () => Buffer.alloc(0)),
    tex = Buffer.alloc(40 + 340 + 2 + 768);
  tex.write(masked ? '{fixture' : 'fixture');
  tex.writeUInt32LE(16, 16);
  tex.writeUInt32LE(16, 20);
  [40, 296, 360, 376].forEach((off, j) => {
    tex.writeUInt32LE(off, 24 + j * 4);
  });
  for (let k = 0; k < 256; k++) tex[40 + k] = k;
  tex.writeUInt16LE(256, 380);
  for (let k = 0; k < 256; k++) {
    tex[382 + k * 3] = k;
    tex[383 + k * 3] = (k * 7) % 256;
    tex[384 + k * 3] = 255 - k;
  }
  const index = Buffer.alloc(8);
  index.writeInt32LE(1);
  index.writeInt32LE(8, 4);
  lumps[2] = Buffer.concat([index, tex]);
  lumps[14] = Buffer.alloc(64);
  const header = Buffer.alloc(124);
  header.writeInt32LE(30);
  let off = 124;
  lumps.forEach((l, j) => {
    header.writeInt32LE(off, 4 + j * 8);
    header.writeInt32LE(l.length, 8 + j * 8);
    off += l.length;
  });
  return Uint8Array.from(Buffer.concat([header, ...lumps])).buffer;
}
test('indexed miptex pixels preserve row order, palette colors and masked index 255', () => {
  for (const masked of [false, true]) {
    const t = readBSP(indexedBSP(masked)).textures[0];
    assert.ok(t.rgba);
    for (let k = 0; k < 256; k++)
      assert.deepEqual(Array.from(t.rgba.subarray(k * 4, k * 4 + 4)), [
        k,
        (k * 7) % 256,
        255 - k,
        masked && k === 255 ? 0 : 255,
      ]);
  }
});

test('renderer preserves authored texture rotation and offsets on transformed brush faces', () => {
  const texture = readBSP(indexedBSP(true)).textures[0];
  const face = {
    texture: 0,
    brush: 0,
    normal: [0, 0, 1],
    points: [
      [0, 0, 0],
      [0, 2, 0],
      [3, 2, 0],
      [3, 0, 0],
    ],
    uv: [
      [8, 12],
      [16, 12],
      [16, 0],
      [8, 0],
    ],
  };
  const bsp = {
    textures: [texture],
    brushes: [{ origin: [10, 20, 30], angles: [0, 90, 0] }],
    faces: [face],
  };
  const [mesh] = buildMapMeshes(bsp, { anisotropy: 8 });
  assert.deepEqual(
    Array.from(mesh.geometry.getAttribute('uv').array),
    [0.5, 0.75, 1, 0.75, 1, 0, 0.5, 0.75, 1, 0, 0.5, 0],
  );
  const map = mesh.material.map;
  assert.ok(map);
  assert.strictEqual(map.image.data, texture.rgba);
  assert.equal(map.flipY, false);
  assert.equal(map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(map.wrapS, THREE.RepeatWrapping);
  assert.equal(map.wrapT, THREE.RepeatWrapping);
  assert.equal(map.magFilter, THREE.LinearFilter);
  assert.equal(map.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(map.anisotropy, 8);
  assert.equal(mesh.material.alphaTest, 0.5);
  const [untextured] = buildMapMeshes(bsp, { textures: false });
  assert.equal(untextured.material.map, null);
  assert.ok(untextured.material.userData.texture);
});

const asset = new URL('../assets/de_inferno.bsp', import.meta.url);
test('transparent collision brushes stay solid but contribute no render faces, even with shared textures', () => {
  const texture = readBSP(indexedBSP()).textures[0];
  const brush = () => ({ origin: [0, 0, 0], angles: [0, 0, 0], solid: true });
  const face = {
    texture: 0,
    normal: [0, 0, 1],
    points: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    uv: [
      [0, 0],
      [0, 16],
      [16, 16],
    ],
  };
  const bsp = {
    textures: [texture],
    brushes: Array.from({ length: 7 }, brush),
    faces: Array.from({ length: 7 }, (_, brush) => ({ ...face, brush })),
    entities: [
      { model: '*1', rendermode: '2' }, // omitted renderamt defaults to zero
      { model: '*2', rendermode: '2', renderamt: '0' },
      { model: '*3', rendermode: '0', renderamt: '0' }, // normal rendering ignores alpha
      { model: '*4', rendermode: '4', renderamt: '255' }, // masked surfaces remain
      { model: '*5', rendermode: '2', renderamt: '128' }, // partial alpha is not invisible
      { model: '*6', rendermode: '2', renderamt: '0', renderfx: '1' }, // animated alpha may become visible
    ],
  };
  const before = JSON.stringify(bsp.brushes),
    [mesh] = buildMapMeshes(bsp);
  assert.equal(mesh.geometry.getAttribute('position').count, 5 * 3);
  assert.equal(JSON.stringify(bsp.brushes), before);
});

test('installed Inferno texture coverage and every rendered triangle match BSP texinfo', {
  skip: !existsSync(asset),
}, () => {
  const bsp = readBSP(Uint8Array.from(readFileSync(asset)).buffer),
    meshes = buildMapMeshes(bsp);
  assert.equal(bsp.textures.length, 97);
  assert.equal(bsp.textures.filter((t) => t.rgba).length, 97);
  for (const mesh of meshes) {
    const texture = bsp.textures.findIndex((t) => t.name === mesh.name),
      t = bsp.textures[texture],
      expected = [];
    const invisible = new Set(
      bsp.entities
        .filter((e) => e.rendermode === '2' && !Number(e.renderamt))
        .map((e) => Number(e.model.slice(1))),
    );
    for (const face of bsp.faces)
      if (face.texture === texture && !invisible.has(face.brush))
        for (let k = 1; k < face.points.length - 1; k++)
          for (const j of [0, k, k + 1])
            expected.push(face.uv[j][0] / t.width, face.uv[j][1] / t.height);
    assert.deepEqual(mesh.geometry.getAttribute('uv').array, Float32Array.from(expected), t.name);
  }
});

test('installed Inferno hides eight lamp collision boxes and preserves all ten visible lanterns', {
  skip: !existsSync(asset),
}, () => {
  const bsp = readBSP(Uint8Array.from(readFileSync(asset)).buffer),
    meshes = buildMapMeshes(bsp);
  const lamps = new Set(
    bsp.faces.filter((f) => bsp.textures[f.texture].name === 'pi_lantern').map((f) => f.brush),
  );
  assert.equal(lamps.size, 10);
  const boxes = bsp.brushes.filter(
    (b) =>
      b.solid &&
      [...lamps].some(
        (id) =>
          JSON.stringify([b.mins, b.maxs]) ===
          JSON.stringify([bsp.brushes[id].mins, bsp.brushes[id].maxs]),
      ),
  );
  assert.equal(boxes.length, 8);
  assert.ok(boxes.every((b) => b.solid));
  // The same wood is legitimately used elsewhere: suppress entities, not textures.
  assert.ok(meshes.some((m) => m.name === 'pi_floorwd3'));
  const count = (name: string) =>
    bsp.faces
      .filter((f) => bsp.textures[f.texture].name === name)
      .reduce((sum, f) => sum + (f.points.length - 2) * 3, 0);
  for (const name of ['pi_lantern', 'pi_grnmetal'])
    assert.equal(
      meshes.find((m) => m.name === name)?.geometry.getAttribute('position').count,
      count(name),
    );
});
