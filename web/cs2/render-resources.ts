import {
  BatchedMesh,
  type BufferGeometry,
  type Material,
  Mesh,
  type Object3D,
  Texture,
} from 'three';

function resourceSet() {
  return {
    geometries: new Set<BufferGeometry>(),
    materials: new Set<Material>(),
    textures: new Set<Texture>(),
    batches: new Set<BatchedMesh>(),
    images: new Set<ImageBitmap>(),
  };
}
type Resources = ReturnType<typeof resourceSet>;
type Disposable = BufferGeometry | Material | Texture | BatchedMesh;
function image(set: Resources, value: unknown) {
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) set.images.add(value);
}
function texture(set: Resources, value: unknown) {
  if (!(value instanceof Texture)) return;
  set.textures.add(value);
  const data = value.source.data;
  if (Array.isArray(data)) {
    for (const value of data) image(set, value);
  } else image(set, data);
}
function material(set: Resources, value: Material) {
  set.materials.add(value);
  for (const entry of Object.values(value)) texture(set, entry);
  for (const key of ['displayTexture', 'displayLightMap']) texture(set, value.userData[key]);
  for (const key of ['cs2Textures', 'cs2Masks'])
    for (const entry of value.userData[key] ?? []) texture(set, entry);
  texture(set, value.userData.cs2Sun?.texture);
  texture(set, value.userData.cs2Sun?.irradiance?.texture);
}
function object(set: Resources, root: Object3D) {
  texture(set, root.userData.cs2SunTexture);
  texture(set, root.userData.cs2IrradianceTexture);
  for (const value of root.userData.cs2MaskTextures ?? []) texture(set, value);
  root.traverse((value) => {
    if (!(value instanceof Mesh)) return;
    set.geometries.add(value.geometry);
    if (value instanceof BatchedMesh) set.batches.add(value);
    for (const m of Array.isArray(value.material) ? value.material : [value.material])
      material(set, m);
  });
}

/** Own loading dependencies before they reach the scene, including late decodes.
 * After batching, retain only the final scene so original geometry can be collected. */
export class RenderResources {
  private resources = resourceSet();
  private closed = false;
  private disposed = new WeakSet<Disposable>();
  private closedImages = new WeakSet<ImageBitmap>();
  private listeners = new Map<BufferGeometry | Material | Texture, () => void>();
  bitmap(value: ImageBitmap) {
    if (this.closed) this.closeImage(value);
    else this.resources.images.add(value);
  }
  texture(value: unknown) {
    this.add((set) => texture(set, value));
  }
  material(value: Material) {
    this.add((set) => material(set, value));
  }
  object(value: Object3D) {
    this.add((set) => object(set, value));
  }
  private add(collect: (set: Resources) => void) {
    const added = resourceSet();
    collect(added);
    if (this.closed) {
      this.release(added);
    } else {
      for (const key of ['geometries', 'materials', 'textures', 'batches', 'images'] as const)
        for (const value of added[key]) (this.resources[key] as Set<typeof value>).add(value);
      this.observe(added);
    }
  }
  private observe(resources = this.resources) {
    for (const values of [resources.geometries, resources.materials, resources.textures])
      for (const value of values) {
        if (this.listeners.has(value) || this.disposed.has(value)) continue;
        const listener = () => {
          this.disposed.add(value);
          this.listeners.delete(value);
          value.removeEventListener('dispose', listener);
        };
        this.listeners.set(value, listener);
        value.addEventListener('dispose', listener);
      }
  }
  retain(root: Object3D) {
    if (this.closed) return this.object(root);
    const next = resourceSet();
    object(next, root);
    this.release(this.resources, next);
    this.resources = next;
    this.observe();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.release(this.resources);
    this.resources = resourceSet();
    for (const [value, listener] of this.listeners) value.removeEventListener('dispose', listener);
    this.listeners.clear();
  }
  private closeImage(value: ImageBitmap) {
    if (this.closedImages.has(value)) return;
    this.closedImages.add(value);
    value.close();
  }
  private release(old: Resources, keep = resourceSet()) {
    const dispose = (value: Disposable) => {
      if (this.disposed.has(value)) return;
      this.disposed.add(value);
      value.dispose();
    };
    for (const value of old.textures) if (!keep.textures.has(value)) dispose(value);
    for (const value of old.batches) if (!keep.batches.has(value)) dispose(value);
    for (const value of old.materials) if (!keep.materials.has(value)) dispose(value);
    for (const value of old.geometries) if (!keep.geometries.has(value)) dispose(value);
    for (const value of old.images) if (!keep.images.has(value)) this.closeImage(value);
  }
}
