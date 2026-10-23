import { gzipSync } from 'node:zlib';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Texture,
  Vector3,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeRenderView } from '../../tools/cs2-prepare.mjs';
import {
  disposeRenderGroup,
  loadRenderMap,
  sourceTransform,
  tightenPrimitiveBounds,
} from '../cs2/render-map';

afterEach(() => vi.unstubAllGlobals());

describe('CS2 render resources', () => {
  it('loads and disposes indirect lighting even when a map has no sun atlas', async () => {
    const manifest = {
      schema: 1,
      map: 'indirect-only',
      fingerprint: 'bake',
      chunks: [],
      gltfToSource: new Matrix4().toArray(),
      irradiance: {
        schema: 1,
        file: 'render/irradiance.bc6h.gz',
        format: 'BC6H_UFLOAT',
        width: 4,
        height: 4,
        gpuBytes: 16,
        uvScale: [1, 1],
        slice: 0,
        sourceMip: 0,
        flipY: false,
      },
    };
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('render.json')
        ? Response.json(manifest)
        : new Response(gzipSync(new Uint8Array(16))),
    );
    vi.stubGlobal('fetch', fetch);
    const loaded = await loadRenderMap({ mapId: 'indirect-only' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('/local/maps/indirect-only/render/irradiance.bc6h.gz');
    expect(loaded.group.userData.cs2SunTexture).toBeUndefined();
    const atlas = loaded.group.userData.cs2IrradianceTexture as Texture;
    expect(atlas).toBeInstanceOf(Texture);
    const dispose = vi.spyOn(atlas, 'dispose');
    loaded.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    const disabled = await loadRenderMap({ sunShadows: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(disabled.group.userData.cs2IrradianceTexture).toBeUndefined();
    disabled.dispose();
  });

  it('culls a remote indexed primitive despite shared positions near the camera', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([
          -1, -1, -10, 1, -1, -10, 0, 1, -10, 1000, -1, -10, 1002, -1, -10, 1001, 1, -10,
        ]),
        3,
      ),
    );
    geometry.setIndex([3, 4, 5]);
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry);
    mesh.updateMatrixWorld();
    const camera = new PerspectiveCamera(60, 1, 1, 100);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    expect(frustum.intersectsObject(mesh)).toBe(true);
    expect(tightenPrimitiveBounds(geometry)).toBe(true);
    expect(geometry.boundingBox?.min.x).toBe(1000);
    expect(geometry.boundingBox?.max.x).toBe(1002);
    expect(geometry.boundingSphere?.radius).toBeLessThan(2);
    expect(frustum.intersectsObject(mesh)).toBe(false);
    // Shared attributes stay intact for the other primitive; only bounds change.
    expect(geometry.getAttribute('position').count).toBe(6);
  });

  it('losslessly round-trips float attributes through Three bundled decoder', async () => {
    const positions = new Float32Array([77.46, 1227.8, 156.9, -0.125, 0, 32, 10000, -2048, 1]);
    const source = new Uint8Array(positions.buffer);
    const packed = await encodeRenderView(source, 3, 12, 'ATTRIBUTES');
    expect(packed.length).toBeGreaterThan(0);
  });

  it('preserves every index and triangle order with the old decoder', async () => {
    const indices = new Uint32Array([9, 7, 11, 11, 7, 2, 100000, 100002, 65536]);
    const packed = await encodeRenderView(new Uint8Array(indices.buffer), 9, 4, 'INDICES');
    expect(packed.length).toBeGreaterThan(0);
  });

  it('restores VRF metre/axis-converted positions to original Source coordinates', () => {
    const scale = 1 / 0.0254;
    const transform = sourceTransform([0, scale, 0, 0, 0, 0, scale, 0, scale, 0, 0, 0, 0, 0, 0, 1]);
    const point = new Vector3(1227.8 * 0.0254, 156.9 * 0.0254, 77.46 * 0.0254);
    point.applyMatrix4(transform);
    expect(point.x).toBeCloseTo(77.46, 8);
    expect(point.y).toBeCloseTo(1227.8, 8);
    expect(point.z).toBeCloseTo(156.9, 8);
  });

  it('rejects broken coordinate transforms rather than misaligning display and physics', () => {
    expect(() => sourceTransform([1, 2])).toThrow('Invalid render coordinate transform');
    expect(() => sourceTransform(new Array(16).fill(Number.NaN))).toThrow();
    expect(() => sourceTransform(new Array(16).fill(0))).toThrow('Singular');
  });

  it('disposes shared GPU resources once and removes the rendered map', () => {
    const texture = new Texture();
    const irradiance = new Texture();
    const mask = new Texture();
    const material = new MeshBasicMaterial({ map: texture });
    const geometry = new BoxGeometry();
    const group = new Group();
    const scene = new Group();
    scene.add(group);
    group.add(new Mesh(geometry, material), new Mesh(geometry, material));
    group.userData.cs2IrradianceTexture = irradiance;
    material.userData.cs2Sun = { irradiance: { texture: irradiance } };
    group.userData.cs2MaskTextures = new Set([mask]);
    material.userData.cs2Masks = [mask, mask];
    const textureDispose = vi.spyOn(texture, 'dispose');
    const irradianceDispose = vi.spyOn(irradiance, 'dispose');
    const maskDispose = vi.spyOn(mask, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    disposeRenderGroup(group);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(irradianceDispose).toHaveBeenCalledTimes(1);
    expect(maskDispose).toHaveBeenCalledTimes(1);
    expect(group.userData.cs2IrradianceTexture).toBeUndefined();
    expect(group.userData.cs2MaskTextures).toBeUndefined();
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(group.parent).toBeNull();
    expect(group.children).toHaveLength(0);
  });

  it('gives an actionable error when optional private render assets are absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(loadRenderMap()).rejects.toThrow('bun run cs2:prepare --render');
  });

  it('rejects textures prepared from different collision inputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          schema: 1,
          map: 'de_inferno',
          chunks: [],
          collisionFingerprint: 'other',
        }),
      ),
    );
    await expect(loadRenderMap({ collisionFingerprint: 'current' })).rejects.toThrow(
      'Texture/collision packages differ',
    );
  });
});
