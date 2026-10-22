import {
  BatchedMesh,
  type BufferAttribute,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
} from 'three';

function batchMaterial(source: MeshLambertMaterial) {
  const material = new MeshLambertMaterial({
    color: 0xffffff,
    map: source.map,
    emissive: source.emissive,
    emissiveMap: source.emissiveMap,
    side: source.side,
    alphaTest: source.alphaTest,
    opacity: source.opacity,
    vertexColors: source.vertexColors,
    clippingPlanes: source.clippingPlanes ?? undefined,
    polygonOffset: source.polygonOffset,
    polygonOffsetFactor: source.polygonOffsetFactor,
    polygonOffsetUnits: source.polygonOffsetUnits,
  });
  material.userData = source.userData;
  material.defines = source.defines;
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey;
  return material;
}

export function batchStaticMap(group: Group) {
  const started = performance.now();
  group.updateMatrixWorld(true);
  const inverse = new Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, Mesh[]>();
  const unbatched = new Set<Mesh['geometry']>();
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
      unbatched.add(object.geometry);
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
      layers: material.userData.cs2?.layers.map((l: { uv: unknown }, i: number) => ({
        uv: l.uv,
        texture: material.userData.cs2Textures[i]?.source.uuid,
      })),
      offset: [material.polygonOffset, material.polygonOffsetFactor, material.polygonOffsetUnits],
      attributes: Object.entries(object.geometry.attributes as Record<string, BufferAttribute>).map(
        ([name, a]) => [name, a.itemSize, a.normalized, a.array.constructor.name],
      ),
    });
    const bucket = buckets.get(signature) ?? [];
    bucket.push(object);
    buckets.set(signature, bucket);
  });
  const oldGeometries = new Set<Mesh['geometry']>();
  const oldMaterials = new Set<MeshLambertMaterial>();
  let batches = 0,
    instances = 0;
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
  }
  for (const geometry of oldGeometries) if (!unbatched.has(geometry)) geometry.dispose();
  group.traverse((object) => {
    if (object instanceof Mesh && object.material instanceof MeshLambertMaterial)
      oldMaterials.delete(object.material);
  });
  for (const material of oldMaterials) material.dispose();
  const empty: Group[] = [];
  group.traverse((o) => {
    if (o instanceof Group && o !== group) empty.push(o);
  });
  for (const object of empty.reverse()) if (!object.children.length) object.removeFromParent();
  group.updateMatrixWorld(true);
  return { originalMeshes, batches, instances, ms: performance.now() - started };
}
