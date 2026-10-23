import * as THREE from 'three';

/** Groups can share atlas textures or contain nested inspection objects. */
export function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((c) => {
    if (!(c instanceof THREE.Mesh || c instanceof THREE.Line || c instanceof THREE.Points)) return;
    geometries.add(c.geometry);
    for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
      materials.add(m);
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      if (m.userData.texture instanceof THREE.Texture) textures.add(m.userData.texture);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  group.clear();
}
