import * as THREE from 'three';

export const CS2_BACKGROUND = 0x9bb4c3;

/** Display lighting for exports without Source 2 baked irradiance.
 * A sky/ground hemisphere retains underside depth without the old white ambient
 * wash. Z-up is explicit: Three's default hemisphere pole points along Y.
 * No shadow maps or postprocessing passes are added to the eight-million-triangle map.
 */
export function cs2Lighting() {
  const sky = new THREE.HemisphereLight(0xddeaff, 0x766451, 1.05);
  sky.position.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffedd5, 2.6);
  sun.position.set(-1000, -1000, 4000);
  return [sky, sun];
}
