import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  ShaderLib,
  SRGBColorSpace,
  Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { batchStaticMap } from '../cs2/render-batches';
import { detailUvMatrix, type EffectTextures, type MaterialEffects } from '../cs2/render-effects';
import { disposeRenderGroup } from '../cs2/render-map';
import { type Cs2Material, diffuseMaterial } from '../cs2/render-materials';

const mask = {
  file: 'render/mask-00000000000000000000.r8.gz',
  width: 1,
  height: 1,
  format: 'R8_UNORM',
  gpuBytes: 1,
  bytes: 21,
};
const detail: NonNullable<MaterialEffects['detail']> = {
  texture: 0,
  mask,
  mode: 1,
  secondary: false,
  maskSecondary: true,
  scale: [2, 3],
  offset: [0.1, -0.2],
  rotation: 90,
  factor: 0.7,
  blendToFull: 0.2,
};
const settings: Cs2Material = {
  shader: 'csgo_vertexlitgeneric.vfx',
  blendMode: 0,
  opacity: 1,
  layers: [],
  uv: { scale: [1, 1], offset: [0, 0], center: [0.5, 0.5], rotation: 0, channel: 0 },
};
function compile(input: Cs2Material, textures: EffectTextures) {
  const source = new MeshStandardMaterial({ map: new Texture() });
  source.userData.cs2 = input;
  const material = diffuseMaterial(source, input, [], undefined, [], false, undefined, textures);
  const shader = {
    vertexShader: ShaderLib.lambert.vertexShader,
    fragmentShader: ShaderLib.lambert.fragmentShader,
    uniforms: {},
  } as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return { source, material, shader };
}

describe('CS2 surface effects', () => {
  it('uses the distinct Source detail transform with nonuniform scale and rotation', () => {
    const uv = new Vector2(0.3, 0.8).applyMatrix3(detailUvMatrix(detail));
    expect(uv.x).toBeCloseTo(0, 12);
    expect(uv.y).toBeCloseTo(-0.3, 12);
    expect(new Vector2(0.5, 0.5).applyMatrix3(detailUvMatrix(detail)).toArray()).toEqual([
      0.6, 0.30000000000000004,
    ]);
  });
  it.each([1, 2])(
    'binds detail mode %i, independent secondary mask UVs, decals and untinted emission',
    (mode) => {
      const effects: MaterialEffects = {
        detail: { ...detail, mode },
        decal: { texture: 1, secondary: true, mode: 0 },
        emission: { mask, secondary: false, color: [8, 4, 2], albedoFactor: 0.5 },
      };
      const textures = {
        detail: new Texture(),
        detailMask: new Texture(),
        decal: new Texture(),
        emission: new Texture(),
      };
      const { material, shader } = compile({ ...settings, effects }, textures);
      expect(shader.vertexShader).toContain('vCs2SecondaryUv = cs2SecondaryUv');
      expect(shader.fragmentShader).toContain('texture2D(cs2DetailMask, vCs2SecondaryUv)');
      expect(shader.fragmentShader).toContain('(cs2DetailUv * vec3(vMapUv, 1.0)).xy');
      expect(shader.fragmentShader).toContain('texture2D(cs2Decal, vCs2SecondaryUv)');
      expect(shader.uniforms.cs2EmissionColor.value.toArray()).toEqual([8, 4, 2]);
      expect(shader.uniforms.cs2Detail.value).toBe(textures.detail);
      expect(material.userData.cs2Textures).toEqual(Object.values(textures));
      expect(material.map?.colorSpace).toBe(SRGBColorSpace);
      expect(textures.detail.colorSpace).toBe(NoColorSpace);
      expect(textures.decal.colorSpace).toBe(NoColorSpace);
      const capture = shader.fragmentShader.indexOf('cs2EmissionAlbedo = diffuseColor.rgb');
      const decal = shader.fragmentShader.indexOf('vec4 cs2DecalColor');
      expect(capture).toBeGreaterThan(shader.fragmentShader.indexOf('#include <color_fragment>'));
      expect(decal).toBeGreaterThan(capture);
      expect(shader.fragmentShader).toContain(
        'mix(vec3(1.0), cs2EmissionAlbedo, cs2EmissionAlbedoFactor)',
      );
      expect(shader.fragmentShader).toContain(
        'if (cs2TexturesEnabled > 0.5) totalEmissiveRadiance',
      );
      expect(shader.fragmentShader).toContain(
        mode === 1 ? 'cs2DetailColor * 1.9922' : 'cs2DetailLinear(cs2Overlay)',
      );
      // These map-dependent operations remain guarded when View > Textures removes map.
      material.map = null;
      const bare = {
        vertexShader: ShaderLib.lambert.vertexShader,
        fragmentShader: ShaderLib.lambert.fragmentShader,
        uniforms: {},
      } as WebGLProgramParametersWithUniforms;
      material.onBeforeCompile(bare, {} as WebGLRenderer);
      expect(bare.fragmentShader).toContain('#ifdef USE_MAP\nif (cs2TexturesEnabled > 0.5)');
    },
  );
  it('keeps different effect parameters and textures in separate batches and frees shared resources', () => {
    const group = new Group(),
      map = new Texture(),
      shared = new Texture(),
      other = new Texture();
    const dispose = vi.spyOn(shared, 'dispose');
    for (const [texture, factor, textureIndex] of [
      [shared, 0.2, 0],
      [shared, 0.2, 18],
      [shared, 0.8, 25],
      [other, 0.2, 35],
    ] as const) {
      const source = new MeshStandardMaterial({ map });
      const input = {
        ...settings,
        effects: { detail: { ...detail, texture: textureIndex, maskSecondary: false, factor } },
      };
      source.userData.cs2 = input;
      const m = diffuseMaterial(source, input, [], undefined, [], false, undefined, {
        detail: texture,
        detailMask: shared,
      });
      group.add(new Mesh(new BoxGeometry(), m));
    }
    expect(batchStaticMap(group).batches).toBe(1);
    expect(group.children).toHaveLength(3);
    disposeRenderGroup(group);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('rejects an incomplete effect binding rather than silently drawing the base texture', () => {
    expect(() =>
      compile({ ...settings, effects: { decal: { texture: 0, secondary: false, mode: 1 } } }, {}),
    ).toThrow('Missing material effect texture');
  });
});
