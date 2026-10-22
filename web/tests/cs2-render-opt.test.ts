import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BatchedMesh,
  Box3,
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { compactPrimitive, restoreOverlayPositions } from '../../tools/cs2-render-pack.mjs';
import { batchStaticMap } from '../cs2/render-batches';
import { disposeRenderGroup } from '../cs2/render-map';
import { type Cs2Material, diffuseMaterial, uvMatrix } from '../cs2/render-materials';

const identityUv = {
  scale: [1, 1],
  offset: [0, 0],
  center: [0.5, 0.5],
  rotation: 0,
  channel: 0,
} as Cs2Material['uv'];
const settings: Cs2Material = {
  shader: 'csgo_static_overlay.vfx',
  blendMode: 1,
  opacity: 0.75,
  uv: identityUv,
  layers: [],
};

describe('CS2 render optimization correctness', () => {
  it('undoes the pinned exporter overlay lift in local metres before rotated/scaled placement', () => {
    const original = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const normals = new Float32Array([0, 1, 0, 0.6, 0.8, 0, -1, 0, 0]);
    const offset = Math.fround(0.01 / 0.0254);
    const exported = original.map((v, i) => v + normals[i] * offset);
    const packed = compactPrimitive(
      { POSITION: { array: exported, size: 3 }, NORMAL: { array: normals, size: 3 } },
      new Uint32Array([0, 1, 2]),
    );
    const corrected = packed.attributes.POSITION.array as Float32Array;
    restoreOverlayPositions(corrected, packed.attributes.NORMAL.array as Float32Array, offset);
    const placement = new Matrix4().compose(
      new Vector3(10, -20, 30),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.2),
      new Vector3(2, 3, 4),
    );
    for (let i = 0; i < original.length; i += 3) {
      const expected = new Vector3().fromArray(original, i).applyMatrix4(placement);
      const actual = new Vector3().fromArray(corrected, i).applyMatrix4(placement);
      expect(actual.distanceTo(expected)).toBeLessThan(0.00001);
    }
    expect(exported[1]).toBeGreaterThan(original[1]);
    const unchanged = new Float32Array(original);
    restoreOverlayPositions(unchanged, normals, 0);
    expect(unchanged).toEqual(original);
    expect(() => restoreOverlayPositions(original, new Float32Array(1), offset)).toThrow(
      'Invalid overlay displacement',
    );
  });
  it('compacts only referenced vertices without moving triangles or their UVs', () => {
    const position = new Float32Array([999, 999, 999, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const uv = new Float32Array([99, 99, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const indices = new Uint32Array([3, 1, 2, 2, 1, 3]);
    const packed = compactPrimitive(
      { POSITION: { array: position, size: 3 }, TEXCOORD_0: { array: uv, size: 2 } },
      indices,
    );
    expect([...packed.indices]).toEqual([0, 1, 2, 2, 1, 0]);
    expect(packed.attributes.POSITION.array.length).toBe(9);
    for (let i = 0; i < indices.length; i++) {
      const old = indices[i],
        next = packed.indices[i];
      expect([...packed.attributes.POSITION.array.slice(next * 3, next * 3 + 3)]).toEqual([
        ...position.slice(old * 3, old * 3 + 3),
      ]);
      expect([...packed.attributes.TEXCOORD_0.array.slice(next * 2, next * 2 + 2)]).toEqual([
        ...uv.slice(old * 2, old * 2 + 2),
      ]);
    }
    expect([...indices]).toEqual([3, 1, 2, 2, 1, 3]);
  });

  it('uses paint alpha as tint strength instead of making unpainted vertices black', () => {
    const result = compactPrimitive(
      {
        POSITION: { array: new Float32Array(9), size: 3 },
        COLOR_0: {
          array: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 128]),
          size: 4,
          normalized: true,
        },
      },
      new Uint32Array([0, 1, 2]),
    );
    expect([...result.attributes.COLOR_0.array.slice(0, 6)]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(result.attributes.COLOR_0.array[6]).toBeCloseTo(127 / 255);
    expect(() =>
      compactPrimitive({ POSITION: { array: new Float32Array(3), size: 3 } }, new Uint32Array([1])),
    ).toThrow('Invalid private render index');
  });

  it('respects texture rotation, nonuniform scale, pivot, offset and selected UV channel', () => {
    const uv = {
      ...identityUv,
      scale: [2, 3],
      offset: [0.1, -0.2],
      rotation: 90,
      channel: 1,
    } as Cs2Material['uv'];
    const point = new Vector2(0.75, 0.25).applyMatrix3(uvMatrix(uv));
    expect(point.x).toBeCloseTo(1.35);
    expect(point.y).toBeCloseTo(0.8);
    const source = new MeshStandardMaterial({ map: new Texture(), transparent: true });
    const material = diffuseMaterial(source, { ...settings, uv });
    expect(material.map?.channel).toBe(1);
    expect(source.map?.channel).toBe(0);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.opacity).toBe(0.75);
    expect(material.polygonOffset).toBe(true);
  });

  it('does not treat foliage wind channels as vertex paint', () => {
    const attributes = {
      POSITION: { array: new Float32Array(9), size: 3 },
      COLOR_0: { array: new Float32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]), size: 4 },
    };
    expect(
      compactPrimitive(attributes, new Uint32Array([0, 1, 2]), 'none').attributes.COLOR_0,
    ).toBeUndefined();
  });

  it('batches static props while preserving nested transforms, tint, and reflected objects', () => {
    const group = new Group();
    group.scale.setScalar(39.37);
    const parent = new Group();
    parent.position.set(10, 20, 30);
    parent.rotation.z = 0.3;
    group.add(parent);
    const geometry = new BoxGeometry();
    const material = new MeshLambertMaterial({ color: 0x554433 });
    const first = new Mesh(geometry, material),
      second = new Mesh(geometry, material);
    const reflected = new Mesh(geometry, material);
    reflected.scale.x = -1;
    first.position.set(2, 3, 4);
    second.position.set(4, 5, 6);
    parent.add(first, second, reflected);
    group.updateMatrixWorld(true);
    const expected = new Matrix4().copy(group.matrixWorld).invert().multiply(first.matrixWorld);
    const dispose = vi.spyOn(geometry, 'dispose');
    const result = batchStaticMap(group);
    const batch = group.children.find((o) => o instanceof BatchedMesh) as BatchedMesh;
    expect(result.instances).toBe(2);
    expect(result.batches).toBe(1);
    expect(batch.getMatrixAt(0, new Matrix4()).elements).toEqual(
      expected.elements.map((v) => expect.closeTo(v, 5)),
    );
    const tint = new Color();
    batch.getColorAt(0, tint);
    expect(tint.getHex()).toBe(material.color.getHex());
    expect(reflected.parent).toBe(parent);
    expect(dispose).not.toHaveBeenCalled(); // shared by the unbatched reflected prop
    const batchDispose = vi.spyOn(batch, 'dispose');
    disposeRenderGroup(group);
    expect(batchDispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps transparent decals outside opaque batches', () => {
    const group = new Group();
    const material = new MeshLambertMaterial({ transparent: true });
    group.add(new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), material));
    expect(batchStaticMap(group).batches).toBe(0);
    expect(group.children).toHaveLength(2);
    disposeRenderGroup(group);
  });
});

const path = fileURLToPath(
  new URL('../../.local/cs2/de_inferno/render/chunk-000.gltf', import.meta.url),
);
it.skipIf(!existsSync(path))(
  'actual Inferno arch overlays retain original installed vertex bounds',
  () => {
    const gltf = JSON.parse(readFileSync(path, 'utf8'));
    const metadata = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../.local/cs2/de_inferno/render.json', import.meta.url)),
        'utf8',
      ),
    );
    // Independent read-only VBIB extraction, before VRF's conversion and decal lift.
    const originals = [
      {
        name: 'n0_lr0_c12_s_mesh_overlay12_nz_nsh.meshset_0',
        min: [-1356, 11, -64],
        max: [-333, 187.0625, 192.5],
      },
      {
        name: 'n0_lr0_c31_s_mesh_overlay31_nz_nsh.meshset_0',
        min: [-1210, 151, -64],
        max: [-480.68195, 827.69525, -24],
      },
    ];
    for (const original of originals) {
      const index = gltf.meshes.findIndex((mesh: { name: string }) => mesh.name === original.name);
      expect(index).toBeGreaterThanOrEqual(0);
      const node = gltf.nodes.find((node: { mesh?: number }) => node.mesh === index);
      const local = node.matrix
        ? new Matrix4().fromArray(node.matrix)
        : new Matrix4().compose(
            new Vector3(...(node.translation ?? [0, 0, 0])),
            new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
            new Vector3(...(node.scale ?? [1, 1, 1])),
          );
      const transform = new Matrix4().fromArray(metadata.gltfToSource).multiply(local);
      const bounds = new Box3();
      for (const primitive of gltf.meshes[index].primitives) {
        const accessor = gltf.accessors[primitive.attributes.POSITION];
        bounds.union(
          new Box3(new Vector3(...accessor.min), new Vector3(...accessor.max)).applyMatrix4(
            transform,
          ),
        );
      }
      for (let c = 0; c < 3; c++) {
        expect(bounds.min.getComponent(c)).toBeCloseTo(original.min[c], 2);
        expect(bounds.max.getComponent(c)).toBeCloseTo(original.max[c], 2);
      }
    }
    expect(metadata.packedGeometry.restoredOverlays).toBeGreaterThan(0);
  },
);
it.skipIf(!existsSync(path))(
  'actual Inferno decals retain alpha and painted layers retain weights',
  () => {
    const gltf = JSON.parse(readFileSync(path, 'utf8'));
    const metadata = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../.local/cs2/de_inferno/render.json', import.meta.url)),
        'utf8',
      ),
    );
    expect(metadata.excludedLods).toBeGreaterThan(0);
    const decals = gltf.materials.filter(
      (m: { extras?: { cs2?: Cs2Material } }) =>
        m.extras?.cs2?.shader === 'csgo_static_overlay.vfx',
    );
    expect(decals.length).toBeGreaterThan(10);
    for (const decal of decals) expect(decal.alphaMode).not.toBe('OPAQUE');
    let layered = 0;
    for (const mesh of gltf.meshes)
      for (const primitive of mesh.primitives) {
        expect(gltf.materials[primitive.material].extras.tools).not.toBe(true);
        if (gltf.materials[primitive.material].extras.cs2.layers.length) {
          layered++;
          expect(primitive.attributes._TEXCOORD_4).toBeDefined();
        }
      }
    expect(layered).toBeGreaterThan(100);
  },
);
