import * as THREE from 'three';

export const CS2_BACKGROUND = 0x9bb4c3;

export interface Cs2Environment {
  angles: [number, number, number];
  color: [number, number, number];
  brightness?: number;
  brightnessScale?: number;
}

/** Source's diffuse light values omit Lambert's 1/PI. Convert units once, at the light. */
export function setCs2Environment(root: THREE.Object3D, environment: Cs2Environment) {
  const sun = root.children.find((child) => child instanceof THREE.DirectionalLight);
  if (!(sun instanceof THREE.DirectionalLight)) return;
  const pitch = THREE.MathUtils.degToRad(environment.angles[0]);
  const yaw = THREE.MathUtils.degToRad(environment.angles[1]);
  sun.position
    .set(-Math.cos(pitch) * Math.cos(yaw), -Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch))
    .multiplyScalar(4000);
  sun.color.setRGB(...environment.color, THREE.SRGBColorSpace);
  sun.intensity = Math.PI * (environment.brightness ?? 2.6) * (environment.brightnessScale ?? 1);
}

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
  const sun = new THREE.DirectionalLight(0xfff7eb, 2.6 * Math.PI);
  sun.position.set(0.35774946, 0.27950442, 0.8910065).multiplyScalar(4000);
  return [sky, sun];
}
