import {
  BatchedMesh,
  BoxGeometry,
  Fog,
  Group,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Texture,
  Vector4,
  type WebGLRenderer,
} from 'three';
import { expect, it, vi } from 'vitest';
import { warmRenderMap } from '../cs2/render-warmup';

vi.mock('../cs2/render-schedule', () => ({ yieldRenderTask: () => Promise.resolve() }));

function fixture() {
  const root = new Group();
  const texture = new Texture();
  const material = new MeshLambertMaterial({ map: texture });
  const masks = [new Texture(), new Texture()];
  const layers = [new Texture()];
  const shadow = new Texture();
  const indirect = new Texture();
  material.userData = {
    cs2Masks: masks,
    cs2Textures: layers,
    cs2Sun: {
      texture: shadow,
      status: 'active',
      irradiance: { texture: indirect, status: 'active' },
    },
  };
  const mesh = new Mesh(new BoxGeometry(), material);
  const batch = new BatchedMesh(1, 24, 36, material);
  const id = batch.addGeometry(mesh.geometry);
  batch.addInstance(id);
  root.add(mesh, batch);
  let viewport = new Vector4(1, 2, 1280, 800);
  let scissor = new Vector4(3, 4, 640, 480);
  let scissorTest = false;
  const ready = vi.fn(() => true);
  const renderer = {
    compile: vi.fn(() => new Set([material])),
    properties: { get: () => ({ currentProgram: { isReady: ready } }) },
    getViewport: (v: Vector4) => v.copy(viewport),
    getScissor: (v: Vector4) => v.copy(scissor),
    getScissorTest: () => scissorTest,
    setViewport: (...values: [Vector4] | [number, number, number, number]) => {
      viewport = values.length === 1 ? values[0].clone() : new Vector4(...values);
    },
    setScissor: (...values: [Vector4] | [number, number, number, number]) => {
      scissor = values.length === 1 ? values[0].clone() : new Vector4(...values);
    },
    setScissorTest: (value: boolean) => {
      scissorTest = value;
    },
    initTexture: vi.fn(),
    render: vi.fn(() => {
      expect(viewport.toArray()).toEqual([0, 0, 1, 1]);
      expect(scissor.toArray()).toEqual([0, 0, 1, 1]);
      expect(scissorTest).toBe(true);
      expect(mesh.frustumCulled).toBe(false);
      expect(batch.perObjectFrustumCulled).toBe(false);
    }),
    renderLists: { dispose: vi.fn() },
  };
  const restored = () => {
    expect(viewport.toArray()).toEqual([1, 2, 1280, 800]);
    expect(scissor.toArray()).toEqual([3, 4, 640, 480]);
    expect(scissorTest).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    expect(batch.perObjectFrustumCulled).toBe(true);
    expect(root.parent).toBeNull();
  };
  return { root, renderer, ready, material, masks, layers, texture, shadow, indirect, restored };
}

it('prepares both fog variants, shared texture inputs and off-camera geometry, then restores state', async () => {
  const f = fixture();
  const dispose = vi.spyOn(f.material, 'dispose');
  const result = await warmRenderMap(
    f.renderer as unknown as WebGLRenderer,
    f.root,
    new PerspectiveCamera(),
    [null, new Fog(0, 1, 10)],
    new AbortController().signal,
  );
  expect(f.renderer.compile).toHaveBeenCalledTimes(2);
  expect(f.renderer.render).toHaveBeenCalledTimes(2);
  expect(result.meshes).toBe(2);
  for (const texture of [f.texture, ...f.masks, ...f.layers, f.shadow, f.indirect])
    expect(f.renderer.initTexture.mock.calls.filter(([value]) => value === texture)).toHaveLength(
      1,
    );
  expect(dispose).not.toHaveBeenCalled();
  f.restored();
});

it('does not upload hidden display textures or unsupported baked atlases', async () => {
  const f = fixture();
  f.material.map = null;
  f.material.userData.displayTexture = f.texture;
  f.material.userData.cs2Sun.status = 'unsupported';
  f.material.userData.cs2Sun.irradiance.status = 'unsupported';
  await warmRenderMap(
    f.renderer as unknown as WebGLRenderer,
    f.root,
    new PerspectiveCamera(),
    [null],
    new AbortController().signal,
  );
  for (const texture of [f.texture, ...f.masks, ...f.layers, f.shadow, f.indirect])
    expect(f.renderer.initTexture).not.toHaveBeenCalledWith(texture);
  f.restored();
});

it('stops shader polling after cancellation without retaining the map in a scratch scene', async () => {
  const f = fixture();
  f.ready.mockReturnValue(false);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await expect(
    warmRenderMap(
      f.renderer as unknown as WebGLRenderer,
      f.root,
      new PerspectiveCamera(),
      [null],
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.renderer.initTexture).not.toHaveBeenCalled();
  expect(f.renderer.render).not.toHaveBeenCalled();
  f.restored();
});

it.each(['upload', 'draw'])('restores renderer and mesh state when %s fails', async (phase) => {
  const f = fixture();
  const fail = () => {
    throw Error('GPU preparation failed');
  };
  if (phase === 'upload') f.renderer.initTexture.mockImplementation(fail);
  else f.renderer.render.mockImplementation(fail);
  await expect(
    warmRenderMap(
      f.renderer as unknown as WebGLRenderer,
      f.root,
      new PerspectiveCamera(),
      [null],
      new AbortController().signal,
    ),
  ).rejects.toThrow('GPU preparation failed');
  f.restored();
});

it('stops uploads on cancellation and leaves resource disposal to the map owner', async () => {
  const f = fixture();
  const controller = new AbortController();
  const dispose = vi.spyOn(f.texture, 'dispose');
  f.renderer.initTexture.mockImplementationOnce(() => controller.abort());
  await expect(
    warmRenderMap(
      f.renderer as unknown as WebGLRenderer,
      f.root,
      new PerspectiveCamera(),
      [null],
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.renderer.initTexture).toHaveBeenCalledTimes(1);
  expect(f.renderer.render).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  f.restored();
});
