import * as THREE from 'three';

export const CS2_BACKGROUND = 0x9bb4c3;

/** Direct sunlight and fallback lighting for primitives without a lightmap.
 * Source baked irradiance replaces the hemisphere on lightmapped surfaces.
 * Z-up is explicit: Three's default hemisphere pole points along Y.
 * No shadow maps or postprocessing passes are added to the eight-million-triangle map.
 */
export function cs2Lighting() {
  const sky = new THREE.HemisphereLight(0xddeaff, 0x766451, 1.05);
  sky.position.set(0, 0, 1);
  // Inferno's light_environment angles (63, 218, 0), in Source's Z-up space.
  // Baked sun visibility must attenuate the light coming from this direction.
  const sun = new THREE.DirectionalLight(0xfff7eb, 2.6);
  sun.position.set(0.35774946, 0.27950442, 0.8910065).multiplyScalar(4000);
  return [sky, sun];
}
