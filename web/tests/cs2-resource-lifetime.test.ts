import {
  BoxGeometry,
  Group,
  ImageBitmapLoader,
  LoadingManager,
  Mesh,
  MeshLambertMaterial,
  Texture,
} from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, expect, it, vi } from 'vitest';
import { batchStaticMap } from '../cs2/render-batches';
import { abortableRender, trackRenderParser } from '../cs2/render-loader';
import { disposeRenderGroup } from '../cs2/render-map';
import { RenderResources } from '../cs2/render-resources';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
class Bitmap {
  close = vi.fn();
}
function bitmap() {
  vi.stubGlobal('ImageBitmap', Bitmap);
  return new Bitmap() as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('disposes hidden base textures, shared bitmap storage and batched GPU resources once', () => {
  const image = bitmap(),
    map = new Texture(image),
    geometry = new BoxGeometry();
  const material = new MeshLambertMaterial();
  material.userData.displayTexture = map;
  const group = new Group().add(new Mesh(geometry, material), new Mesh(geometry, material));
  batchStaticMap(group);
  const dispose = vi.spyOn(map, 'dispose');
  disposeRenderGroup(group);
  expect(dispose).toHaveBeenCalledOnce();
  expect(image.close).toHaveBeenCalledOnce();
  expect(group.children).toHaveLength(0);
});

it('releases converted/batched source objects without closing images still used by the final map', () => {
  const image = bitmap(),
    source = new Texture(image),
    visible = source.clone();
  const oldGeometry = new BoxGeometry(),
    oldMaterial = new MeshLambertMaterial({ map: source });
  const resources = new RenderResources();
  resources.object(new Mesh(oldGeometry, oldMaterial));
  const sourceDispose = vi.spyOn(source, 'dispose');
  const oldDispose = vi.spyOn(oldGeometry, 'dispose');
  const current = new MeshLambertMaterial({ map: visible });
  const finalGeometry = new BoxGeometry();
  const group = new Group().add(new Mesh(finalGeometry, current));
  resources.retain(group);
  expect(sourceDispose).toHaveBeenCalledOnce();
  expect(oldDispose).toHaveBeenCalledOnce();
  expect(image.close).not.toHaveBeenCalled();
  current.userData.displayTexture = visible;
  current.map = null;
  const visibleDispose = vi.spyOn(visible, 'dispose');
  resources.dispose();
  resources.dispose();
  expect(visibleDispose).toHaveBeenCalledOnce();
  expect(image.close).toHaveBeenCalledOnce();
  expect(oldDispose).toHaveBeenCalledOnce();
});

it('closes dependencies that resolve after cancellation, before scene attachment', async () => {
  const resources = new RenderResources(),
    controller = new AbortController();
  const pending = deferred<Texture>(),
    image = bitmap(),
    texture = new Texture(image);
  const parser = {
    getDependency: () => pending.promise,
    loadBuffer: vi.fn(),
    textureLoader: {},
  } as unknown as GLTFParser;
  trackRenderParser(parser, new LoadingManager(), controller.signal, resources);
  const parsed = parser.getDependency('texture', 0);
  const waiting = abortableRender(parsed, controller.signal);
  controller.abort();
  resources.dispose();
  await expect(waiting).rejects.toThrow();
  const disposed = vi.spyOn(texture, 'dispose');
  pending.resolve(texture);
  await parsed;
  expect(disposed).toHaveBeenCalledOnce();
  expect(image.close).toHaveBeenCalledOnce();
});

it('aborts image fetches and closes a native bitmap whose decode finishes after cancellation', async () => {
  const resources = new RenderResources(),
    controller = new AbortController();
  const decoded = deferred<ImageBitmap>(),
    started = deferred<void>(),
    image = bitmap();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => {
      started.resolve();
      return decoded.promise;
    }),
  );
  const fetch = vi.fn(async () => new Response('image bytes'));
  vi.stubGlobal('fetch', fetch);
  const manager = new LoadingManager();
  const ended = vi.spyOn(manager, 'itemEnd');
  const parser = {
    getDependency: vi.fn(),
    loadBuffer: vi.fn(),
    textureLoader: new ImageBitmapLoader(manager),
  } as unknown as GLTFParser;
  trackRenderParser(parser, manager, controller.signal, resources);
  const loaded = vi.fn(),
    failed = deferred<unknown>();
  parser.textureLoader.load('http://localhost/map.webp', loaded, undefined, failed.resolve);
  await started.promise;
  controller.abort();
  resources.dispose();
  decoded.resolve(image);
  await failed.promise;
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost/map.webp',
    expect.objectContaining({ signal: controller.signal }),
  );
  expect(image.close).toHaveBeenCalledOnce();
  expect(loaded).not.toHaveBeenCalled();
  expect(ended).toHaveBeenCalledOnce();
});

it('keeps indirect-only primitives batchable and disposes their independent atlas', () => {
  const group = new Group(),
    texture = new Texture();
  const material = new MeshLambertMaterial();
  material.userData.cs2Sun = { irradiance: { texture } };
  group.add(new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), material));
  expect(batchStaticMap(group).batches).toBe(1);
  const dispose = vi.spyOn(texture, 'dispose');
  disposeRenderGroup(group);
  expect(dispose).toHaveBeenCalledOnce();
});
