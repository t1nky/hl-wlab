import { Buffer } from 'node:buffer';
import { BatchedMesh, BoxGeometry, Group, Mesh, MeshLambertMaterial, Plane, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deduplicateRenderAccessors } from '../../tools/cs2-prepare.mjs';
import { batchStaticMap, batchStaticMapAsync } from '../cs2/render-batches';
import { decodeRenderViews } from '../cs2/render-decode';
import { disposeRenderGroup } from '../cs2/render-map';
import { type CompressedRenderView, streamRenderViews } from '../cs2/render-stream';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CS2 render preparation', () => {
  it('streams partial views and gaps without retaining the full compressed package', async () => {
    const makeView = (byteOffset: number, byteLength: number): CompressedRenderView => ({
      byteLength,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset,
          byteLength,
          count: byteLength,
          byteStride: 1,
          mode: 'INDICES',
        },
      },
    });
    const bytes = new Uint8Array([99, 99, 1, 2, 3, 4, 99, 5, 6, 7, 99]);
    const chunks = [bytes.slice(0, 3), bytes.slice(3, 5), bytes.slice(5, 9), bytes.slice(9)];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
    const result = await streamRenderViews(
      response,
      [
        [1, makeView(7, 3)],
        [0, makeView(2, 4)],
      ],
      (target, source) => target.set(source),
    );
    expect([...new Uint8Array(result.results.get(0) ?? new ArrayBuffer(0))]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(result.results.get(1) ?? new ArrayBuffer(0))]).toEqual([5, 6, 7]);
    expect(result.compressedBytes).toBe(bytes.length);
    expect(result.compressedStagingBytes).toBe(8);
    await expect(
      streamRenderViews(new Response(bytes.slice(0, 3)), [[0, makeView(2, 4)]], (target, source) =>
        target.set(source),
      ),
    ).rejects.toThrow('Truncated');
  });
  it('shares exact attribute bytes while preserving interpretation and every primitive', () => {
    const bytes = Buffer.from(new Float32Array([0, 1, 2]).buffer);
    const gltf = {
      accessors: [0, 1, 2].map((bufferView) => ({
        bufferView,
        componentType: 5126,
        count: 1,
        type: 'VEC3',
        normalized: bufferView === 2,
      })),
      bufferViews: [0, 1, 2].map((index) => ({
        buffer: 0,
        byteOffset: index * bytes.length,
        byteLength: bytes.length,
      })),
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1 },
            { attributes: { POSITION: 1, COLOR_0: 2 }, indices: 0 },
          ],
        },
      ],
    };
    const stats = deduplicateRenderAccessors(gltf, [Buffer.concat([bytes, bytes, bytes])]);
    expect(stats).toEqual({ savedBytes: 12, uniqueAccessors: 2, sharedAccessors: 1 });
    expect(gltf.meshes[0].primitives).toEqual([
      { attributes: { POSITION: 0 }, indices: 0 },
      { attributes: { POSITION: 0, COLOR_0: 1 }, indices: 0 },
    ]);
    expect(gltf.accessors[1].normalized).toBe(true);
  });

  it('batches identical layouts independent of asynchronous attribute insertion order', () => {
    const group = new Group();
    const first = new BoxGeometry(),
      second = first.clone();
    const entries = Object.entries(second.attributes).reverse();
    second.attributes = Object.fromEntries(entries);
    const material = new MeshLambertMaterial();
    group.add(new Mesh(first, material), new Mesh(second, material));
    expect(batchStaticMap(group).batches).toBe(1);
    disposeRenderGroup(group);
  });

  it('preserves shader hooks, depth state and per-mesh shadow settings without serializing textures', () => {
    const group = new Group();
    const material = new MeshLambertMaterial({ depthWrite: false, emissiveIntensity: 0.3 });
    const hook = vi.fn();
    material.onBeforeCompile = hook;
    material.userData = {
      toJSON: () => {
        throw Error('Texture serialization must not run');
      },
    };
    material.clippingPlanes = [new Plane(new Vector3(0, 0, 1), 5)];
    const a = new Mesh(new BoxGeometry(), material),
      b = new Mesh(new BoxGeometry(), material);
    a.receiveShadow = b.receiveShadow = true;
    a.renderOrder = b.renderOrder = 4;
    group.add(a, b);
    batchStaticMap(group);
    const batch = group.children[0] as BatchedMesh;
    expect(batch.receiveShadow).toBe(true);
    expect(batch.castShadow).toBe(false);
    expect(batch.renderOrder).toBe(4);
    const converted = batch.material as MeshLambertMaterial;
    expect(converted.onBeforeCompile).toBe(hook);
    expect(converted.depthWrite).toBe(false);
    expect(converted.emissiveIntensity).toBe(0.3);
    expect(converted.clippingPlanes).toEqual(material.clippingPlanes);
    disposeRenderGroup(group);
  });

  it('retains geometry shared with a singleton material bucket until map disposal', () => {
    const group = new Group(),
      geometry = new BoxGeometry();
    const material = new MeshLambertMaterial(),
      other = new MeshLambertMaterial({ opacity: 0.5 });
    group.add(
      new Mesh(geometry, material),
      new Mesh(geometry, material),
      new Mesh(geometry, other),
    );
    const dispose = vi.spyOn(geometry, 'dispose');
    batchStaticMap(group);
    expect(dispose).not.toHaveBeenCalled();
    disposeRenderGroup(group);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases partially batched resources on cancellation', async () => {
    const group = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshLambertMaterial();
    group.add(new Mesh(geometry, material), new Mesh(geometry, material));
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    const controller = new AbortController();
    controller.abort();
    await expect(batchStaticMapAsync(group, controller.signal)).rejects.toThrow();
    expect(group.children[0]).toBeInstanceOf(BatchedMesh);
    disposeRenderGroup(group);
  });

  it('terminates the geometry worker on completion and abort', async () => {
    const workers: MockWorker[] = [];
    class MockWorker {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: (event: { message: string }) => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        workers.push(this);
      }
    }
    vi.stubGlobal('Worker', MockWorker);
    const loaded = decodeRenderViews([], [], 'http://localhost/local/render/chunk.gltf', 'hash');
    workers[0].onmessage?.({ data: { views: [], timings: {} } });
    await expect(loaded).resolves.toEqual({ views: [], timings: {} });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const aborted = decodeRenderViews(
      [],
      [],
      'http://localhost/local/render/chunk.gltf',
      'hash',
      controller.signal,
    );
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
});
