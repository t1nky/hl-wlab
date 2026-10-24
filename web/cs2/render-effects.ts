import { Matrix3, type Texture, Vector3, type WebGLProgramParametersWithUniforms } from 'three';
import type { Cs2Mask } from './render-masks';

// Surface math follows MIT-licensed VRF complex/common-texturing shaders.
// See THIRD-PARTY.md and public/licenses/VRF-LICENSE.txt.

export interface MaterialEffects {
  detail?: {
    texture: number;
    mask: Cs2Mask;
    mode: number;
    secondary: boolean;
    maskSecondary: boolean;
    scale: [number, number];
    offset: [number, number];
    rotation: number;
    factor: number;
    blendToFull: number;
  };
  decal?: { texture: number; secondary: boolean; mode: number };
  emission?: {
    mask: Cs2Mask;
    secondary: boolean;
    color: [number, number, number];
    albedoFactor: number;
  };
}

export interface EffectTextures {
  detail?: Texture;
  detailMask?: Texture;
  decal?: Texture;
  emission?: Texture;
}

export function needsSecondaryUv(effects?: MaterialEffects, tintSecondary = false) {
  return !!(
    tintSecondary ||
    effects?.detail?.secondary ||
    effects?.detail?.maskSecondary ||
    effects?.decal?.secondary ||
    effects?.emission?.secondary
  );
}

/** Source's four-argument detail transform scales after rotation, unlike its
 * five-argument base transform. The detail overload fixes the pivot at half UV. */
export function detailUvMatrix(detail: NonNullable<MaterialEffects['detail']>) {
  const [sx, sy] = detail.scale;
  const [ox, oy] = detail.offset;
  const angle = (detail.rotation * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return new Matrix3().set(
    sx * c,
    -sx * s,
    0.5 + ox - 0.5 * sx * (c - s),
    sy * s,
    sy * c,
    0.5 + oy - 0.5 * sy * (s + c),
    0,
    0,
    1,
  );
}

/** Extra surface behavior in the existing Lambert pass. Source order is tint,
 * emission-albedo capture, detail, decal, then lighting and emission output. */
export function patchMaterialEffects(
  shader: WebGLProgramParametersWithUniforms,
  effects: MaterialEffects | undefined,
  textures: EffectTextures,
  tintSecondary = false,
) {
  if (needsSecondaryUv(effects, tintSecondary)) {
    shader.vertexShader = `attribute vec2 cs2SecondaryUv; varying vec2 vCs2SecondaryUv;\n${shader.vertexShader}`;
    shader.fragmentShader = `varying vec2 vCs2SecondaryUv;\n${shader.fragmentShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvCs2SecondaryUv = cs2SecondaryUv;',
    );
  }
  if (!effects) return;
  const uv = (secondary: boolean) => (secondary ? 'vCs2SecondaryUv' : 'vMapUv');
  const sampler = (name: string, texture?: Texture) => {
    if (!texture) throw Error(`Missing material effect texture: ${name}`);
    shader.uniforms[name] = { value: texture };
    shader.fragmentShader = `uniform sampler2D ${name};\n${shader.fragmentShader}`;
  };
  let surface = effects.emission ? 'cs2EmissionAlbedo = diffuseColor.rgb;\n' : '';
  const detail = effects.detail;
  if (detail) {
    sampler('cs2Detail', textures.detail);
    sampler('cs2DetailMask', textures.detailMask);
    shader.uniforms.cs2DetailUv = { value: detailUvMatrix(detail) };
    shader.uniforms.cs2DetailFactor = { value: detail.factor };
    shader.uniforms.cs2DetailFull = { value: detail.blendToFull };
    shader.fragmentShader = `uniform mat3 cs2DetailUv; uniform float cs2DetailFactor; uniform float cs2DetailFull;\n${shader.fragmentShader}`;
    surface += `float cs2DetailWeight = cs2DetailFactor * max(texture2D(cs2DetailMask, ${uv(detail.maskSecondary)}).r, cs2DetailFull);
      vec3 cs2DetailColor = texture2D(cs2Detail, (cs2DetailUv * vec3(${uv(detail.secondary)}, 1.0)).xy).rgb;\n`;
    if (detail.mode === 1) {
      surface += 'diffuseColor.rgb *= mix(vec3(1.0), cs2DetailColor * 1.9922, cs2DetailWeight);\n';
    } else {
      shader.fragmentShader = `vec3 cs2DetailGamma(vec3 c) {
        return mix(1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThanEqual(c, vec3(0.0031308)));
      }
      vec3 cs2DetailLinear(vec3 c) {
        return mix(pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4)), c / 12.92, lessThanEqual(c, vec3(0.04045)));
      }\n${shader.fragmentShader}`;
      surface += `vec3 cs2GammaAlbedo = cs2DetailGamma(diffuseColor.rgb);
        cs2DetailColor *= 0.9961;
        vec3 cs2Overlay = mix(cs2DetailColor * cs2GammaAlbedo * 2.0,
          1.0 - (1.0 - cs2DetailColor) * (1.0 - cs2GammaAlbedo) * 2.0,
          greaterThanEqual(cs2GammaAlbedo, vec3(0.5)));
        diffuseColor.rgb = mix(diffuseColor.rgb, cs2DetailLinear(cs2Overlay), cs2DetailWeight);\n`;
    }
  }
  if (effects.decal) {
    sampler('cs2Decal', textures.decal);
    surface += `vec4 cs2DecalColor = texture2D(cs2Decal, ${uv(effects.decal.secondary)});
      diffuseColor.rgb = ${effects.decal.mode === 0 ? 'mix(diffuseColor.rgb, cs2DecalColor.rgb, cs2DecalColor.a)' : 'diffuseColor.rgb * cs2DecalColor.rgb'};\n`;
  }
  if (effects.emission) {
    const emission = effects.emission;
    sampler('cs2EmissionMask', textures.emission);
    shader.uniforms.cs2EmissionColor = { value: new Vector3(...emission.color) };
    shader.uniforms.cs2EmissionAlbedoFactor = { value: emission.albedoFactor };
    shader.fragmentShader = `uniform vec3 cs2EmissionColor; uniform float cs2EmissionAlbedoFactor;\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      'vec3 cs2EmissionAlbedo = vec3(1.0);\n#include <map_fragment>',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
        #ifdef USE_MAP
        if (cs2TexturesEnabled > 0.5) totalEmissiveRadiance += cs2EmissionColor * texture2D(cs2EmissionMask, ${uv(emission.secondary)}).r * mix(vec3(1.0), cs2EmissionAlbedo, cs2EmissionAlbedoFactor);
        #endif`,
    );
  }
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <alphamap_fragment>',
    `#ifdef USE_MAP\nif (cs2TexturesEnabled > 0.5) { ${surface} }\n#endif\n#include <alphamap_fragment>`,
  );
}
