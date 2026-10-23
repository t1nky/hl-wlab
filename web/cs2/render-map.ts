import {
  BatchedMesh,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  LoadingManager,
  type Material,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Plane,
  Sphere,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { packageBase } from './package';
import { type batchStaticMap, batchStaticMapAsync } from './render-batches';
import { decodeRenderViews, type RenderDecodeTimings } from './render-decode';
import { type IrradianceMetadata, loadIrradiance } from './render-irradiance';
import { type Cs2Mask, loadMaterialMask } from './render-masks';
import { type Cs2Material, diffuseMaterial } from './render-materials';
import { yieldRenderTask } from './render-schedule';
import { hasSunBinding, loadSunVisibility, type SunLighting, type SunMetadata } from './render-sun';

let decoderWorkersStarted = false;

export interface RenderMetadata {
  schema: number;
  map: string;
  fingerprint: string;
  collisionFingerprint: string;
  prepareMs: number;
  chunks: string[];
  gltfToSource: number[];
  textureMaxSize: number;
  meshCount: number;
  primitives: number;
  triangleCount: number;
  texturedTriangleCount?: number;
  textureCount: number;
  estimatedTextureGpuBytes: number;
  totalBytes: number;
  warnings: string[];
  compactPrimitiveBounds?: number;
  packageHash?: string;
  sunShadows?: SunMetadata;
  irradiance?: IrradianceMetadata;
  runtimeBounds?: {
    geometryCount: number;
    shrunkCount: number;
    precomputedCount: number;
    ms: number;
  };
  runtimeBatches?: ReturnType<typeof batchStaticMap>;
  runtimeLoad?: {
    resourcesMs: number;
    materialsMs: number;
    totalMs: number;
    manifestMs?: number;
    sunMs?: number;
    irradianceMs?: number;
  };
  runtimeDecode?: RenderDecodeTimings[];
}

export interface RenderMap {
  group: Group;
  metadata: RenderMetadata;
  dispose(): void;
}

export function sourceTransform(values: readonly number[]): Matrix4 {
  if (values.length !== 16 || !values.every(Number.isFinite))
    throw Error('Invalid render coordinate transform');
  const matrix = new Matrix4().fromArray(values);
  if (Math.abs(matrix.determinant()) < 1e-10) throw Error('Singular render coordinate transform');
  return matrix;
}

/** glTF primitives can reference a small region of a shared whole-map POSITION accessor. */
export function tightenPrimitiveBounds(geometry: BufferGeometry): boolean {
  const positions = geometry.getAttribute('position');
  if (!positions) return false;
  const indices = geometry.getIndex();
  const available = indices?.count ?? positions.count;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(available, start + geometry.drawRange.count);
  if (end <= start) return false;
  const box = new Box3();
  const point = new Vector3();
  for (let i = start; i < end; i++) {
    const index = indices ? indices.getX(i) : i;
    if (!Number.isInteger(index) || index < 0 || index >= positions.count)
      throw Error('Invalid render primitive index');
    point.fromBufferAttribute(positions, index);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))
      throw Error('Non-finite render primitive position');
    box.expandByPoint(point);
  }
  geometry.boundingBox = box;
  // The box sphere is conservative, and avoids a second full index pass. It excludes all
  // unreferenced vertices while preserving complete containment of the primitive.
  geometry.boundingSphere = box.getBoundingSphere(new Sphere());
  return true;
}

/** Frees shared geometry/material/texture resources once, including ImageBitmap CPU storage. */
export function disposeRenderGroup(group: Group): void {
  const geometries = new Set<Mesh['geometry']>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  if (group.userData.cs2SunTexture instanceof Texture) textures.add(group.userData.cs2SunTexture);
  if (group.userData.cs2IrradianceTexture instanceof Texture)
    textures.add(group.userData.cs2IrradianceTexture);
  for (const texture of group.userData.cs2MaskTextures ?? [])
    if (texture instanceof Texture) textures.add(texture);
  const batches = new Set<BatchedMesh>();
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof BatchedMesh) batches.add(object);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
      for (const value of material.userData.cs2Textures ?? [])
        if (value instanceof Texture) textures.add(value);
      for (const value of material.userData.cs2Masks ?? [])
        if (value instanceof Texture) textures.add(value);
      if (material.userData.cs2Sun?.texture instanceof Texture)
        textures.add(material.userData.cs2Sun.texture);
      if (material.userData.cs2Sun?.irradiance?.texture instanceof Texture)
        textures.add(material.userData.cs2Sun.irradiance.texture);
    }
  });
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    const image = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const batch of batches) {
    geometries.delete(batch.geometry);
    batch.dispose();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  group.removeFromParent();
  group.clear();
  delete group.userData.cs2SunTexture;
  delete group.userData.cs2IrradianceTexture;
  delete group.userData.cs2MaskTextures;
}

export async function loadRenderMap(
  options: {
    clippingPlanes?: Plane[];
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    collisionFingerprint?: string;
    batch?: boolean;
    sunShadows?: boolean;
    mapId?: string;
  } = {},
): Promise<RenderMap> {
  const { clippingPlanes = [], onProgress, signal } = options;
  const base = packageBase(options.mapId);
  const started = performance.now();
  onProgress?.('Reading private textured-map manifest…');
  const response = await fetch(`${base}render.json`, { signal, cache: 'no-store' });
  if (!response.ok)
    throw Error(
      'Textured map unavailable. Run bun run cs2:prepare --render, then load textures again.',
    );
  const metadata: RenderMetadata = await response.json();
  const manifestMs = performance.now() - started;
  if (metadata.schema !== 1 || typeof metadata.map !== 'string' || !Array.isArray(metadata.chunks))
    throw Error('Unsupported textured-map package. Run bun run cs2:prepare --render again.');
  if (
    options.collisionFingerprint &&
    metadata.collisionFingerprint !== options.collisionFingerprint
  )
    throw Error('Texture/collision packages differ. Run bun run cs2:prepare --render again.');
  const group = new Group();
  group.name = 'CS2 render geometry (display only)';
  group.matrixAutoUpdate = false;
  group.matrix.copy(sourceTransform(metadata.gltfToSource));
  let disposed = false;
  const maskTextures = new Set<Texture>();
  group.userData.cs2MaskTextures = maskTextures;
  const maskRequests = new Map<string, Promise<Texture>>();
  function maskTexture(mask: Cs2Mask): Promise<Texture> {
    let request = maskRequests.get(mask.file);
    if (!request) {
      request = loadMaterialMask(mask, version, signal, base).then((texture) => {
        // Other in-flight masks can finish after a sibling load has failed.
        if (disposed) {
          texture.dispose();
          throw new DOMException('Map load cancelled', 'AbortError');
        }
        maskTextures.add(texture);
        return texture;
      });
      void request.catch(() => undefined);
      maskRequests.set(mask.file, request);
    }
    return request;
  }
  const manager = new LoadingManager();
  // The manifest is always revalidated; dependent resources belong to that exact package.
  // A rebuild cannot accidentally reuse a prior chunk or ImageBitmap cache entry.
  const version = `${metadata.fingerprint}-${metadata.packageHash ?? ''}`;
  manager.setURLModifier(
    (url) => `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`,
  );
  manager.onProgress = (_url, loaded, total) =>
    onProgress?.(`Loading textured map resources ${loaded}/${total}…`);
  const loader = new GLTFLoader(manager);
  let chunkUrl = '';
  const decodes: RenderDecodeTimings[] = [];
  loader.register((parser) => {
    const views = parser.json.bufferViews ?? [];
    const supported =
      typeof Worker !== 'undefined' &&
      views.length > 0 &&
      views.every(
        (view: { extensions?: { EXT_meshopt_compression?: unknown } }) =>
          view.extensions?.EXT_meshopt_compression,
      );
    if (!supported && !decoderWorkersStarted && typeof Worker !== 'undefined') {
      // Retain the bundled path for older or mixed-layout packages.
      (MeshoptDecoder as typeof MeshoptDecoder & { useWorkers(count: number): void }).useWorkers(2);
      decoderWorkersStarted = true;
    }
    let pending: ReturnType<typeof decodeRenderViews> | undefined;
    return {
      // Overrides only the bundled meshopt extension, using the same bundled decoder.
      name: supported ? 'EXT_meshopt_compression' : 'CS2_unused_decoder',
      loadBufferView(index: number) {
        if (!supported) return null;
        pending ??= decodeRenderViews(parser.json.buffers, views, chunkUrl, version, signal).then(
          (result) => {
            decodes.push(result.timings);
            return result;
          },
        );
        return pending.then((result) => result.views[index]);
      },
    };
  });
  loader.register((parser) => {
    // Layer-only images are absent from glTF's standard material dependencies.
    // Start them during root loading, instead of a serial waterfall after geometry decode.
    const pending: Promise<unknown>[] = [];
    return {
      name: 'CS2_render_layers',
      beforeRoot() {
        const indices = new Set<number>();
        const materials = new Set<number>();
        for (const mesh of parser.json.meshes ?? [])
          for (const primitive of mesh.primitives)
            if (Number.isInteger(primitive.material)) materials.add(primitive.material);
        for (const index of materials) {
          const material = parser.json.materials[index];
          const settings = material.extras?.cs2 as Cs2Material | undefined;
          for (const layer of settings?.layers ?? []) indices.add(layer.texture);
          for (const layer of [
            settings?.tint?.base,
            ...(settings?.layers.map((l) => l.tint) ?? []),
          ])
            if (layer?.mask) pending.push(maskTexture(layer.mask));
        }
        for (const index of indices) {
          const request = parser.getDependency('texture', index);
          // Attach a handler immediately; afterRoot propagates the actual error.
          void request.catch(() => undefined);
          pending.push(request);
        }
        return null;
      },
      async afterRoot() {
        await Promise.all(pending);
      },
    };
  });
  loader.setMeshoptDecoder(MeshoptDecoder);
  const dispose = () => {
    disposed = true;
    disposeRenderGroup(group);
    maskTextures.clear();
    maskRequests.clear();
  };
  const bounds = { geometryCount: 0, shrunkCount: 0, precomputedCount: 0, ms: 0 };
  const timings = {
    resourcesMs: 0,
    materialsMs: 0,
    totalMs: 0,
    manifestMs,
    sunMs: 0,
    irradianceMs: 0,
  };
  const pendingMaterials = new Set<Material>();
  let sun: SunLighting | undefined;
  try {
    if (metadata.sunShadows && options.sunShadows !== false) {
      const sunStarted = performance.now();
      sun = await loadSunVisibility(metadata.sunShadows, version, signal, base);
      timings.sunMs = performance.now() - sunStarted;
      group.userData.cs2SunTexture = sun.texture;
      if (metadata.irradiance) {
        const irradianceStarted = performance.now();
        sun.irradiance = await loadIrradiance(metadata.irradiance, version, signal, base);
        timings.irradianceMs = performance.now() - irradianceStarted;
        group.userData.cs2IrradianceTexture = sun.irradiance.texture;
      }
    }
    for (const [index, chunk] of metadata.chunks.entries()) {
      if (!/^render\/[a-zA-Z0-9_.-]+\.gltf$/.test(chunk))
        throw Error('Invalid private render chunk path');
      signal?.throwIfAborted();
      onProgress?.(`Loading render chunk ${index + 1}/${metadata.chunks.length}…`);
      signal?.throwIfAborted();
      chunkUrl = new URL(`${base}${chunk}`, window.location.href).href;
      const resourcesStart = performance.now();
      const gltf = await loader.loadAsync(`${base}${chunk}`);
      timings.resourcesMs += performance.now() - resourcesStart;
      group.add(gltf.scene);
      signal?.throwIfAborted();
      // The POC has explicit simple lighting. Do not also apply exported Source light entities.
      const bounded = new Set<BufferGeometry>();
      const meshes: Mesh[] = [];
      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) meshes.push(object);
      });
      const converted = new Map<Material, Map<boolean, Material>>();
      const materialsStart = performance.now();
      const sources = new Set(
        meshes.flatMap((object) =>
          Array.isArray(object.material) ? object.material : [object.material],
        ),
      );
      const modes = new Map<Material, Set<boolean>>();
      for (const object of meshes)
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          const values = modes.get(material) ?? new Set<boolean>();
          values.add(!!(hasSunBinding(object.geometry) && sun));
          modes.set(material, values);
        }
      let yieldAt = performance.now() + 8;
      for (const source of sources) {
        const settings = source.userData.cs2 as Cs2Material | undefined;
        const textures = await Promise.all(
          (settings?.layers ?? []).map(
            (layer) => gltf.parser.getDependency('texture', layer.texture) as Promise<Texture>,
          ),
        );
        if (textures.some((texture) => !texture)) throw Error('Missing render layer texture');
        const masks = settings?.tint
          ? await Promise.all(
              [settings.tint.base, ...settings.layers.map((l) => l.tint)].map((layer) => {
                if (!layer?.mask) throw Error('Missing render layer mask');
                return maskTexture(layer.mask);
              }),
            )
          : [];
        const variants = new Map<boolean, Material>();
        for (const lit of modes.get(source) ?? []) {
          const material = diffuseMaterial(
            source as MeshStandardMaterial,
            settings,
            textures,
            lit ? sun : undefined,
            masks,
          );
          pendingMaterials.add(material);
          material.clippingPlanes = clippingPlanes;
          variants.set(lit, material);
        }
        converted.set(source, variants);
        if (performance.now() >= yieldAt) {
          await yieldRenderTask();
          signal?.throwIfAborted();
          yieldAt = performance.now() + 8;
        }
      }
      for (const object of meshes) {
        if (!bounded.has(object.geometry)) {
          const started = performance.now();
          const oldRadius = object.geometry.boundingSphere?.radius ?? Infinity;
          if (
            metadata.compactPrimitiveBounds === 1 &&
            object.geometry.boundingBox &&
            object.geometry.boundingSphere
          )
            bounds.precomputedCount++;
          else tightenPrimitiveBounds(object.geometry);
          bounds.geometryCount++;
          if ((object.geometry.boundingSphere?.radius ?? Infinity) < oldRadius * 0.99)
            bounds.shrunkCount++;
          bounds.ms += performance.now() - started;
          bounded.add(object.geometry);
        }
        const materials: Material[] = [];
        for (const source of Array.isArray(object.material) ? object.material : [object.material]) {
          const lightUv = object.geometry.getAttribute('_cs2_light_uv');
          if (lightUv && sun) {
            object.geometry.setAttribute('cs2LightUv', lightUv);
            // Keep the original attribute until every object sharing this geometry is bound.
          }
          const material = converted.get(source)?.get(!!(sun && lightUv));
          const settings = source.userData.cs2 as Cs2Material | undefined;
          if (!material) throw Error('Missing converted render material');
          materials.push(material);
          if (settings?.layers.length) {
            const blend =
              object.geometry.getAttribute('cs2Blend') ??
              object.geometry.getAttribute('_texcoord_4');
            object.geometry.setAttribute(
              'cs2Blend',
              blend ??
                new BufferAttribute(
                  new Float32Array(object.geometry.getAttribute('position').count * 4),
                  4,
                ),
            );
            object.geometry.deleteAttribute('_texcoord_4');
          }
        }
        object.material = Array.isArray(object.material) ? materials : materials[0];
        if (performance.now() >= yieldAt) {
          await yieldRenderTask();
          signal?.throwIfAborted();
          yieldAt = performance.now() + 8;
        }
      }
      for (const geometry of bounded) geometry.deleteAttribute('_cs2_light_uv');
      for (const source of sources) source.dispose();
      pendingMaterials.clear();
      timings.materialsMs += performance.now() - materialsStart;
    }
    group.updateMatrixWorld(true);
    metadata.runtimeBounds = bounds;
    if (options.batch !== false) metadata.runtimeBatches = await batchStaticMapAsync(group, signal);
    timings.totalMs = performance.now() - started;
    metadata.runtimeLoad = timings;
    metadata.runtimeDecode = decodes;
    onProgress?.(
      `${metadata.textureCount} base textures · ${(metadata.totalBytes / 1048576).toFixed(1)} MiB map package`,
    );
    return { group, metadata, dispose };
  } catch (error) {
    // A cancellation can happen between conversion and attachment to a mesh.
    // Include those materials in the same deduplicated disposal traversal.
    if (pendingMaterials.size) group.add(new Mesh(new BufferGeometry(), [...pendingMaterials]));
    dispose();
    throw error;
  }
}
