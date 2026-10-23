import {
  BatchedMesh,
  type BufferAttribute,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
} from 'three';
import { yieldRenderTask } from './render-schedule';

function batchMaterial(source: MeshLambertMaterial) {
  // clone preserves depth/blend/shadow and future lighting settings as well.
  // Material.copy serializes userData. Our userData contains Texture objects;
  // serializing those would synchronously re-encode their ImageBitmaps to PNG.
  const copySource = Object.create(source) as MeshLambertMaterial;
  copySource.userData = {};
  const material = new MeshLambertMaterial().copy(copySource);
  material.color.set(0xffffff);
  material.userData = source.userData;
  material.defines = source.defines;
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey;
  return material;
}

function* prepareStaticMap(group: Group) {
  const started = performance.now();
  group.updateMatrixWorld(true);
  const inverse = new Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, Mesh[]>();
  let originalMeshes = 0;
  group.traverse((object) => {
    object.matrixAutoUpdate = false;
    if (!(object instanceof Mesh)) return;
    originalMeshes++;
    const material = object.material;
    if (
      !(material instanceof MeshLambertMaterial) ||
      material.transparent ||
      object.matrixWorld.determinant() < 0
    ) {
      return;
    }
    // Model tint is per-instance. Keep UVs, alpha, layer uniforms and layout in the key.
    const signature = JSON.stringify({
      map: material.map?.source.uuid,
      uv: material.map?.matrix.elements,
      channel: material.map?.channel,
      side: material.side,
      alpha: material.alphaTest,
      opacity: material.opacity,
      emissive: material.emissive.getHex(),
      emissiveIntensity: material.emissiveIntensity,
      emissiveMap: material.emissiveMap?.uuid,
      depth: [material.depthTest, material.depthWrite, material.depthFunc, material.colorWrite],
      blending: [material.blending, material.blendSrc, material.blendDst, material.blendEquation],
      shader: material.customProgramCacheKey(),
      tint: material.userData.cs2?.tint,
      genericBlend: material.userData.cs2?.genericBlend,
      masks: material.userData.cs2Masks?.map((texture: { uuid: string }) => texture.uuid),
      sun: material.userData.cs2Sun?.texture?.uuid,
      irradiance: material.userData.cs2Sun?.irradiance?.texture.uuid,
      lightingMode: material.userData.cs2LightingMode,
      clipping: material.clippingPlanes?.map((p) => [...p.normal.toArray(), p.constant]),
      shadows: [object.castShadow, object.receiveShadow],
      renderOrder: object.renderOrder,
      layers: material.userData.cs2?.layers.map((l: { uv: unknown }, i: number) => ({
        uv: l.uv,
        tint: (l as { tint?: unknown }).tint,
        texture: material.userData.cs2Textures[i]?.source.uuid,
      })),
      offset: [material.polygonOffset, material.polygonOffsetFactor, material.polygonOffsetUnits],
      attributes: Object.entries(object.geometry.attributes as Record<string, BufferAttribute>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, a]) => [name, a.itemSize, a.normalized, a.array.constructor.name]),
    });
    const bucket = buckets.get(signature) ?? [];
    bucket.push(object);
    buckets.set(signature, bucket);
  });
  const oldGeometries = new Set<Mesh['geometry']>();
  const oldMaterials = new Set<MeshLambertMaterial>();
  let batches = 0,
    instances = 0;
  try {
    for (const objects of buckets.values()) {
      if (objects.length < 2) continue;
      const geometries = [...new Set(objects.map((o) => o.geometry))];
      const vertices = geometries.reduce((sum, g) => sum + g.getAttribute('position').count, 0);
      const indices = geometries.reduce((sum, g) => sum + (g.index?.count ?? 0), 0);
      const batch = new BatchedMesh(
        objects.length,
        vertices,
        indices,
        batchMaterial(objects[0].material as MeshLambertMaterial),
      );
      batch.name = 'Static material batch';
      batch.castShadow = objects[0].castShadow;
      batch.receiveShadow = objects[0].receiveShadow;
      batch.renderOrder = objects[0].renderOrder;
      batch.matrixAutoUpdate = false;
      batch.userData.sources = [];
      const ids = new Map(geometries.map((geometry) => [geometry, batch.addGeometry(geometry)]));
      for (const object of objects) {
        const geometryId = ids.get(object.geometry);
        if (geometryId === undefined) throw Error('Missing batch geometry');
        const id = batch.addInstance(geometryId);
        batch.setMatrixAt(id, new Matrix4().multiplyMatrices(inverse, object.matrixWorld));
        batch.setColorAt(id, new Color((object.material as MeshLambertMaterial).color));
        batch.userData.sources[id] = {
          mesh: object.name,
          material: (object.material as MeshLambertMaterial).userData.sourceMaterial,
          lighting: object.geometry.userData.cs2Lighting,
        };
        oldGeometries.add(object.geometry);
        oldMaterials.add(object.material as MeshLambertMaterial);
        object.removeFromParent();
        instances++;
      }
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
      group.add(batch);
      batches++;
      yield;
    }
  } finally {
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      // Includes singleton buckets and partially processed groups on cancellation.
      oldGeometries.delete(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        if (material instanceof MeshLambertMaterial) oldMaterials.delete(material);
    });
    for (const geometry of oldGeometries) geometry.dispose();
    for (const material of oldMaterials) material.dispose();
  }
  const empty: Group[] = [];
  group.traverse((o) => {
    if (o instanceof Group && o !== group) empty.push(o);
  });
  for (const object of empty.reverse()) if (!object.children.length) object.removeFromParent();
  group.updateMatrixWorld(true);
  return { originalMeshes, batches, instances, ms: performance.now() - started };
}

/** Synchronous entry point retained for small scenes and regression tests. */
export function batchStaticMap(group: Group) {
  const work = prepareStaticMap(group);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Large map copies are split at material buckets so input/paint can run while loading. */
export async function batchStaticMapAsync(group: Group, signal?: AbortSignal) {
  const work = prepareStaticMap(group);
  let yieldAt = performance.now() + 8;
  let step = work.next();
  while (!step.done) {
    if (performance.now() >= yieldAt) {
      await yieldRenderTask();
      if (signal?.aborted) {
        work.return({ originalMeshes: 0, batches: 0, instances: 0, ms: 0 });
        signal.throwIfAborted();
      }
      yieldAt = performance.now() + 8;
    }
    step = work.next();
  }
  return step.value;
}
