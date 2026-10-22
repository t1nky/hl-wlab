import {
  AddEquation,
  CustomBlending,
  DstColorFactor,
  Matrix3,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SRGBColorSpace,
  SrcAlphaFactor,
  SrcColorFactor,
  type Texture,
  ZeroFactor,
} from 'three';

export interface UvSettings {
  scale: [number, number];
  offset: [number, number];
  center: [number, number];
  rotation: number;
  channel: number;
}
export interface Cs2Material {
  shader: string;
  blendMode: number;
  opacity: number;
  depthBias?: boolean;
  uv: UvSettings;
  layers: { texture: number; uv: UvSettings }[];
}

// Source material transforms rotate about an explicit center after nonuniform scale.
// Matrix order follows VRF's MIT-licensed shader interpretation; no image flipping.
export function uvMatrix(settings: UvSettings): Matrix3 {
  const {
    scale: [sx, sy],
    offset: [ox, oy],
    center: [cx, cy],
  } = settings;
  const r = (settings.rotation * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  return new Matrix3().set(
    c * sx,
    -s * sy,
    cx + ox - c * sx * cx + s * sy * cy,
    s * sx,
    c * sy,
    cy + oy - s * sx * cx - c * sy * cy,
    0,
    0,
    1,
  );
}

function mapWithUv(texture: Texture, uv: UvSettings): Texture {
  const map = texture.clone();
  map.colorSpace = SRGBColorSpace;
  map.channel = uv.channel;
  map.matrixAutoUpdate = false;
  map.matrix.copy(uvMatrix(uv));
  map.needsUpdate = true;
  return map;
}

/** Cheap diffuse lighting is sufficient for this analysis viewer; PBR maps are not exported. */
export function diffuseMaterial(
  source: MeshStandardMaterial,
  settings?: Cs2Material,
  layerTextures: Texture[] = [],
): MeshLambertMaterial {
  const material = new MeshLambertMaterial({
    color: source.color,
    map: source.map && settings ? mapWithUv(source.map, settings.uv) : source.map,
    side: source.side,
    transparent: source.transparent,
    opacity: source.opacity * (settings?.opacity ?? 1),
    alphaTest: source.alphaTest,
    vertexColors: source.vertexColors,
    emissive: source.emissive,
    emissiveMap: source.emissiveMap,
    depthWrite: !source.transparent,
  });
  material.name = source.name;
  material.userData = {
    ...source.userData,
    cs2Textures: layerTextures,
    cs2TexturesEnabled: { value: 1 },
  };
  const mode = settings?.blendMode ?? 0;
  if (mode >= 3) {
    material.blending = CustomBlending;
    material.blendEquation = AddEquation;
    material.blendSrc = mode === 5 ? ZeroFactor : mode === 4 ? SrcAlphaFactor : DstColorFactor;
    material.blendDst =
      mode === 4 ? OneFactor : mode === 6 ? OneMinusSrcAlphaFactor : SrcColorFactor;
  }
  if (settings?.depthBias || settings?.shader.includes('overlay')) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
  }
  if (!settings || !layerTextures.length) return material;
  if (settings.layers.some((layer) => layer.uv.channel === 1)) material.defines = { USE_UV1: '' };
  for (const texture of layerTextures) texture.colorSpace = SRGBColorSpace;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cs2TexturesEnabled = material.userData.cs2TexturesEnabled;
    const layers = settings.layers.slice(0, layerTextures.length);
    shader.vertexShader = `attribute vec4 cs2Blend; varying vec4 vCs2Blend;\n${shader.vertexShader}`;
    shader.fragmentShader = `uniform float cs2TexturesEnabled; varying vec4 vCs2Blend;\n${shader.fragmentShader}`;
    let vertex = 'vCs2Blend = cs2Blend;\n';
    let fragment = '';
    layers.forEach((layer, i) => {
      const name = `cs2Layer${i}`;
      shader.uniforms[name] = { value: layerTextures[i] };
      shader.uniforms[`${name}Uv`] = { value: uvMatrix(layer.uv) };
      shader.vertexShader = `uniform mat3 ${name}Uv; varying vec2 v${name}Uv;\n${shader.vertexShader}`;
      shader.fragmentShader = `uniform sampler2D ${name}; varying vec2 v${name}Uv;\n${shader.fragmentShader}`;
      vertex += `v${name}Uv = (${name}Uv * vec3(${layer.uv.channel === 1 ? 'uv1' : 'uv'}, 1.0)).xy;\n`;
      fragment += `diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * texture2D(${name}, v${name}Uv).rgb, clamp(vCs2Blend.${i === 0 ? 'x' : 'y'}, 0.0, 1.0));\n`;
    });
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\n${vertex}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\nif (cs2TexturesEnabled > 0.5) { ${fragment} }`,
    );
  };
  material.customProgramCacheKey = () =>
    `cs2-layers-${settings.layers.map((l) => l.uv.channel).join('-')}`;
  return material;
}
