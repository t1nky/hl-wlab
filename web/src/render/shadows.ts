import * as THREE from 'three';

/** Toggle baked shading in place, retaining atlases for instant restoration. */
export function setMapShadows(group: THREE.Group, enabled: boolean) {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material.userData.cs2Sun) material.userData.cs2Sun.enabled.value = Number(enabled);
      if (!(material instanceof THREE.MeshBasicMaterial)) continue;
      if (!Object.hasOwn(material.userData, 'displayLightMap'))
        material.userData.displayLightMap = material.lightMap;
      const lightMap = enabled ? material.userData.displayLightMap : null;
      if (material.lightMap === lightMap) continue;
      material.lightMap = lightMap;
      material.needsUpdate = true;
    }
  });
}
