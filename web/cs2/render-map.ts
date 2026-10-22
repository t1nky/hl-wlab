import {
  Box3,
  type BufferGeometry,
  Group,
  LoadingManager,
  type Material,
  Matrix4,
  Mesh,
  type Plane,
  Sphere,
  Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
  runtimeBounds?: { geometryCount: number; shrunkCount: number; ms: number };
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
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
    }
  });
  for (const texture of textures) {
    const image = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    texture.dispose();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  group.removeFromParent();
  group.clear();
}

export async function loadRenderMap(
  options: {
    clippingPlanes?: Plane[];
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    collisionFingerprint?: string;
  } = {},
): Promise<RenderMap> {
  const { clippingPlanes = [], onProgress, signal } = options;
  onProgress?.('Reading private textured-map manifest…');
  const response = await fetch('/local/render.json', { signal, cache: 'no-store' });
  if (!response.ok)
    throw Error(
      'Textured map unavailable. Run bun run cs2:prepare --render, then load textures again.',
    );
  const metadata: RenderMetadata = await response.json();
  if (metadata.schema !== 1 || metadata.map !== 'de_inferno' || !Array.isArray(metadata.chunks))
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
  const manager = new LoadingManager();
  manager.onProgress = (_url, loaded, total) =>
    onProgress?.(`Loading textured map resources ${loaded}/${total}…`);
  const loader = new GLTFLoader(manager);
  if (!decoderWorkersStarted && typeof Worker !== 'undefined') {
    // Three 0.170 ships the worker API but its older ambient declaration omits it.
    (MeshoptDecoder as typeof MeshoptDecoder & { useWorkers(count: number): void }).useWorkers(2);
    decoderWorkersStarted = true;
  }
  loader.setMeshoptDecoder(MeshoptDecoder);
  const dispose = () => disposeRenderGroup(group);
  const bounds = { geometryCount: 0, shrunkCount: 0, ms: 0 };
  try {
    for (const [index, chunk] of metadata.chunks.entries()) {
      if (!/^render\/[a-zA-Z0-9_.-]+\.gltf$/.test(chunk))
        throw Error('Invalid private render chunk path');
      signal?.throwIfAborted();
      onProgress?.(`Loading render chunk ${index + 1}/${metadata.chunks.length}…`);
      const gltf = await loader.loadAsync(`/local/${chunk}`);
      group.add(gltf.scene);
      signal?.throwIfAborted();
      // The POC has explicit simple lighting. Do not also apply exported Source light entities.
      const bounded = new Set<BufferGeometry>();
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        if (!bounded.has(object.geometry)) {
          const started = performance.now();
          const oldRadius = object.geometry.boundingSphere?.radius ?? Infinity;
          tightenPrimitiveBounds(object.geometry);
          bounds.geometryCount++;
          if ((object.geometry.boundingSphere?.radius ?? Infinity) < oldRadius * 0.99)
            bounds.shrunkCount++;
          bounds.ms += performance.now() - started;
          bounded.add(object.geometry);
        }
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          material.clippingPlanes = clippingPlanes;
          material.needsUpdate = true;
        }
      });
    }
    group.updateMatrixWorld(true);
    metadata.runtimeBounds = bounds;
    onProgress?.(
      `${metadata.textureCount} base textures · ${(metadata.totalBytes / 1048576).toFixed(1)} MiB map package`,
    );
    return { group, metadata, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
