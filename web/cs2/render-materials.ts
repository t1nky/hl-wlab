import {
  AddEquation,
  CustomBlending,
  DstColorFactor,
  Matrix3,
  Matrix4,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderChunk,
  SRGBColorSpace,
  SrcAlphaFactor,
  SrcColorFactor,
  type Texture,
  Vector3,
  Vector4,
  ZeroFactor,
} from 'three';
import { patchIrradiance } from './render-irradiance';
import type { Cs2Mask } from './render-masks';
import { patchProbeLighting } from './render-probes';
import { patchSunVisibility, type SunLighting } from './render-sun';

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
  modelTintBaked?: boolean;
  tint?: { amount: number; material: [number, number, number]; base: LayerTint };
  uv: UvSettings;
  layers: { texture: number; uv: UvSettings; tint?: LayerTint }[];
  genericBlend?: { mode: number; softness: number; mask?: Cs2Mask; softnessMask?: Cs2Mask };
}

export interface LayerTint {
  enabled: boolean;
  contrast: number;
  brightness: number;
  vertexColorMode: number;
  mask?: Cs2Mask;
  correction?: number[];
  tintedCorrection?: number[];
  unmaskedCorrection?: boolean;
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

/** Diffuse-only viewer. Source color/tint math follows MIT-licensed VRF;
 * attribution and notice are in THIRD-PARTY.md and public/licenses/VRF-LICENSE.txt.
 */
export function diffuseMaterial(
  source: MeshStandardMaterial,
  settings?: Cs2Material,
  layerTextures: Texture[] = [],
  sun?: SunLighting,
  maskTextures: Texture[] = [],
  probeLighting = false,
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
    cs2Masks: maskTextures,
    cs2TexturesEnabled: { value: 1 },
    cs2Sun: sun,
    cs2LightingMode: probeLighting ? 'probe' : sun ? 'lightmap' : 'fallback',
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
  if (!sun && (!settings || (!layerTextures.length && !settings.tint))) return material;
  if (settings?.layers.some((layer) => layer.uv.channel === 1)) material.defines = { USE_UV1: '' };
  for (const texture of layerTextures) texture.colorSpace = SRGBColorSpace;
  material.onBeforeCompile = (shader, renderer) => {
    if (probeLighting && sun) patchProbeLighting(shader, sun.enabled);
    else {
      if (sun) patchSunVisibility(shader, sun, renderer);
      if (sun?.irradiance) patchIrradiance(shader, sun, renderer);
    }
    if (!settings || (!layerTextures.length && !settings.tint)) return;
    shader.uniforms.cs2TexturesEnabled = material.userData.cs2TexturesEnabled;
    const layers = settings.layers.slice(0, layerTextures.length);
    if (layers.length) {
      shader.vertexShader = `attribute vec4 cs2Blend; varying vec4 vCs2Blend;\n${shader.vertexShader}`;
      shader.fragmentShader = `varying vec4 vCs2Blend;\n${shader.fragmentShader}`;
    }
    shader.fragmentShader = `uniform float cs2TexturesEnabled;\n${shader.fragmentShader}`;
    let vertex = layers.length ? 'vCs2Blend = cs2Blend;\n' : '';
    let fragment = '';
    if (settings.genericBlend?.mode) {
      const blend = settings.genericBlend;
      if (maskTextures.length !== (blend.mode === 1 ? 2 : 1))
        throw Error('Missing generic blend modulation');
      shader.uniforms.cs2BlendMask = { value: maskTextures[0] };
      shader.uniforms.cs2BlendSoftness = { value: blend.softness };
      shader.fragmentShader = `uniform sampler2D cs2BlendMask; uniform float cs2BlendSoftness;\n${shader.fragmentShader}`;
      if (blend.mode === 1) {
        shader.uniforms.cs2BlendSoftnessMask = { value: maskTextures[1] };
        shader.fragmentShader = `uniform sampler2D cs2BlendSoftnessMask;\n${shader.fragmentShader}`;
      }
    }
    if (settings.tint) {
      const tintSettings = settings.tint;
      // Keep the batch color as model tint, separate from vertex paint. Its black
      // components are valid, so dividing the combined vColor cannot recover it.
      shader.vertexShader = `varying vec3 vCs2ModelTint;\n${shader.vertexShader}`;
      shader.fragmentShader = `varying vec3 vCs2ModelTint;\n${shader.fragmentShader}`;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `vCs2ModelTint = vec3(1.0);\n${ShaderChunk.color_vertex.replace('vColor.xyz *= batchingColor.xyz;', 'vCs2ModelTint = batchingColor.xyz;')}`,
      );
      shader.uniforms.cs2MaterialTint = { value: new Vector3(...tintSettings.material) };
      shader.fragmentShader = `uniform vec3 cs2MaterialTint;
vec3 cs2TintLayer(vec4 texel, float green, vec4 params, vec3 modelTint, vec3 paint, mat4 correction, mat4 tintedCorrection, float unmaskedCorrection) {
  float mask = clamp(((green - 0.5) * params.x + 0.5) * params.y, 0.0, 1.0);
  // Original sampled alpha participates in affine matrix translation. Keep HDR
  // until after model tint, matching Source's order instead of clamping a bake.
  vec3 corrected = mix(texel.rgb, (correction * texel).rgb, unmaskedCorrection);
  vec3 correctedTinted = (tintedCorrection * texel).rgb;
  texel.rgb = mix(corrected, correctedTinted, mask);
  vec3 norm = normalize(max(modelTint, vec3(0.001)));
  const vec3 lumaWeights = vec3(0.2125, 0.7154, 0.0721);
  float luma = dot(texel.rgb, lumaWeights);
  float high = max(modelTint.r, max(modelTint.g, modelTint.b));
  float low = min(modelTint.r, min(modelTint.g, modelTint.b));
  vec3 tinted = norm * min(luma / dot(norm, lumaWeights), 3.0 * luma * high);
  vec3 result = clamp(mix(texel.rgb, tinted, clamp(params.z * (1.0 - low) * mask, 0.0, 1.0)), 0.0, 1.0);
  float paintMask = params.w == 2.0 ? 0.0 : params.w == 0.0 ? 1.0 : green;
  return result * mix(vec3(1.0), paint, paintMask);
}
${shader.fragmentShader}`;
      const tintUniform = (name: string, tint: LayerTint) => {
        shader.uniforms[name] = {
          value: new Vector4(
            tint.contrast,
            tint.brightness,
            tint.enabled ? tintSettings.amount : 0,
            tint.vertexColorMode,
          ),
        };
        shader.fragmentShader = `uniform vec4 ${name};\n${shader.fragmentShader}`;
        shader.uniforms[`${name}Correction`] = {
          value: tint.correction ? new Matrix4().fromArray(tint.correction) : new Matrix4(),
        };
        shader.uniforms[`${name}TintedCorrection`] = {
          value: tint.tintedCorrection
            ? new Matrix4().fromArray(tint.tintedCorrection)
            : new Matrix4(),
        };
        shader.uniforms[`${name}Unmasked`] = { value: tint.unmaskedCorrection ? 1 : 0 };
        shader.fragmentShader = `uniform mat4 ${name}Correction; uniform mat4 ${name}TintedCorrection; uniform float ${name}Unmasked;\n${shader.fragmentShader}`;
      };
      tintUniform('cs2BaseTint', tintSettings.base);
      layers.forEach((layer, i) => {
        tintUniform(`cs2LayerTint${i}`, layer.tint ?? tintSettings.base);
      });
      const maskUniform = (name: string, texture: Texture) => {
        shader.uniforms[name] = { value: texture };
        shader.fragmentShader = `uniform sampler2D ${name};\n${shader.fragmentShader}`;
      };
      if (maskTextures.length) {
        if (maskTextures.length !== layers.length + 1) throw Error('Missing material mask texture');
        maskTextures.forEach((texture, i) => {
          maskUniform(`cs2Mask${i}`, texture);
        });
      }
      const baseMask = maskTextures.length
        ? 'texture2D(cs2Mask0, vMapUv).r'
        : 'sampledDiffuseColor.a';
      fragment = `vec3 cs2Paint = cs2MaterialTint;
        #if defined(USE_COLOR_ALPHA) || defined(USE_COLOR)
          cs2Paint *= vColor.rgb;
        #endif
        diffuseColor.rgb = cs2TintLayer(sampledDiffuseColor, ${baseMask}, cs2BaseTint, diffuse * vCs2ModelTint, cs2Paint, cs2BaseTintCorrection, cs2BaseTintTintedCorrection, cs2BaseTintUnmasked);\n`;
      // Mask alpha is data. Opaque environment opacity is independent of it.
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '');
    }
    layers.forEach((layer, i) => {
      const name = `cs2Layer${i}`;
      shader.uniforms[name] = { value: layerTextures[i] };
      shader.uniforms[`${name}Uv`] = {
        value: settings.genericBlend
          ? new Matrix3().set(layer.uv.scale[0], 0, 0, 0, layer.uv.scale[1], 0, 0, 0, 1)
          : uvMatrix(layer.uv),
      };
      shader.vertexShader = `uniform mat3 ${name}Uv; varying vec2 v${name}Uv;\n${shader.vertexShader}`;
      shader.fragmentShader = `uniform sampler2D ${name}; varying vec2 v${name}Uv;\n${shader.fragmentShader}`;
      // Generic terrain scales the already transformed primary UV, unlike
      // environment layers which each transform the raw mesh UV independently.
      vertex += settings.genericBlend
        ? `#ifdef USE_MAP\nv${name}Uv = (${name}Uv * vec3(vMapUv, 1.0)).xy;\n#else\nv${name}Uv = vec2(0.0);\n#endif\n`
        : `v${name}Uv = (${name}Uv * vec3(${layer.uv.channel === 1 ? 'uv1' : 'uv'}, 1.0)).xy;\n`;
      const color = settings.tint
        ? `cs2TintLayer(texture2D(${name}, v${name}Uv), ${maskTextures.length ? `texture2D(cs2Mask${i + 1}, v${name}Uv).r` : `texture2D(${name}, v${name}Uv).a`}, cs2LayerTint${i}, diffuse * vCs2ModelTint, cs2Paint, cs2LayerTint${i}Correction, cs2LayerTint${i}TintedCorrection, cs2LayerTint${i}Unmasked)`
        : `diffuse * texture2D(${name}, v${name}Uv).rgb`;
      let weight = `clamp(vCs2Blend.${i === 0 ? 'x' : 'y'}, 0.0, 1.0)`;
      if (settings.genericBlend?.mode) {
        const softness =
          settings.genericBlend.mode === 1
            ? `texture2D(cs2BlendSoftnessMask, v${name}Uv).r`
            : 'cs2BlendSoftness';
        fragment += `float cs2Mask = texture2D(cs2BlendMask, v${name}Uv).r;
          float cs2Softness = ${softness};
          float cs2Low = max(0.0, cs2Mask - cs2Softness);
          float cs2High = min(1.0, cs2Mask + cs2Softness);
          float cs2Weight = cs2High > cs2Low ? smoothstep(cs2Low, cs2High, ${weight}) : step(cs2Mask, ${weight});\n`;
        weight = 'cs2Weight';
      }
      fragment += `diffuseColor.rgb = mix(diffuseColor.rgb, ${color}, ${weight});\n`;
    });
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\n${vertex}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\n#ifdef USE_MAP\n${settings.tint ? 'diffuseColor = vec4(1.0, 1.0, 1.0, opacity);' : ''}\nif (cs2TexturesEnabled > 0.5) { ${fragment} }\n#endif`,
    );
  };
  material.customProgramCacheKey = () =>
    `cs2-layers-${settings?.layers.map((l) => l.uv.channel).join('-') ?? ''}-generic-${settings?.genericBlend?.mode ?? 'none'}-tint-${!!settings?.tint}-masks-${maskTextures.length}-sun-${sun?.texture?.format ?? 'none'}-${sun?.channel ?? 0}-irradiance-${!!sun?.irradiance}-probe-${probeLighting}`;
  return material;
}
