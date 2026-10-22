import * as THREE from 'three';

export function createPointMaterial(colors: THREE.Color[]) {
  return new THREE.ShaderMaterial({
    clipping: true,
    transparent: true,
    uniforms: {
      colors: { value: colors },
      show: { value: new THREE.Vector3() },
      stances: { value: new THREE.Vector2() },
      minDamage: { value: 1 },
      size: { value: 10 },
      scale: { value: 1 },
      sizeRange: { value: new THREE.Vector2(3, 16) },
    },
    vertexShader: `attribute float hp,kind;uniform vec3 colors[3],show;uniform vec2 stances,sizeRange;uniform float minDamage,size,scale;varying vec3 vColor;varying float vCrouch;
#include <clipping_planes_pars_vertex>
void main(){vCrouch=step(2.5,kind);vec3 type=vec3(equal(vec3(kind-3.*vCrouch),vec3(0,1,2)));vColor=colors[0]*type.x+colors[1]*type.y+colors[2]*type.z;
bool visible=dot(show,type)*mix(stances.x,stances.y,vCrouch)>.5&&(type.x>.5||hp>=minDamage);vec4 mvPosition=modelViewMatrix*vec4(position,1);
gl_Position=visible?projectionMatrix*mvPosition:vec4(2,2,2,1);gl_PointSize=visible?clamp(size*scale*projectionMatrix[1][1]/-mvPosition.z,sizeRange.x,sizeRange.y):0.;
#include <clipping_planes_vertex>
}`,
    fragmentShader: `varying vec3 vColor;varying float vCrouch;
#include <clipping_planes_pars_fragment>
void main(){
#include <clipping_planes_fragment>
float r=length(gl_PointCoord*2.-1.);if(r>1.||vCrouch>.5&&r<.4)discard;gl_FragColor=vec4(r>.7?vColor*.2:vColor,1);}`,
  });
}
