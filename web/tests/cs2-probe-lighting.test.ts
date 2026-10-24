import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { BufferAttribute, BufferGeometry, MeshStandardMaterial, ShaderLib, Vector2 } from 'three';
import { expect, it } from 'vitest';
import { diffuseMaterial } from '../cs2/render-materials';
import { hasProbeLighting } from '../cs2/render-probes';

it('validates probe lighting independently of paint and lightmap UVs', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  expect(hasProbeLighting(geometry)).toBe(false);
  geometry.setAttribute('_cs2_probe_light', new BufferAttribute(new Float32Array(12), 4));
  expect(() => hasProbeLighting(geometry)).toThrow('Invalid baked prop lighting');
  geometry.userData.cs2Lighting = { mode: 'probe', storage: 'linear-irradiance-sun-visibility' };
  expect(hasProbeLighting(geometry)).toBe(true);
  geometry.userData.cs2Lighting.mode = 'lightmap';
  expect(() => hasProbeLighting(geometry)).toThrow();
  geometry.userData.cs2Lighting.mode = 'probe';
  geometry.setAttribute('_cs2_probe_light', new BufferAttribute(new Float32Array(8), 4));
  expect(() => hasProbeLighting(geometry)).toThrow();
});

it('replaces fallback indirect lighting and shadows only the sun with authored probe values', () => {
  const enabled = { value: 1 };
  const sun = { enabled, scale: new Vector2(1, 1) };
  const source = new MeshStandardMaterial();
  const material = diffuseMaterial(source, undefined, [], sun, [], true);
  const fallback = diffuseMaterial(source);
  expect(material.userData.cs2LightingMode).toBe('probe');
  expect(material.customProgramCacheKey()).not.toBe(fallback.customProgramCacheKey());
  const shader = {
    vertexShader: ShaderLib.lambert.vertexShader,
    fragmentShader: ShaderLib.lambert.fragmentShader,
    uniforms: {},
  } as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  expect(shader.vertexShader).toContain('vCs2ProbeLight = _cs2_probe_light');
  expect(shader.fragmentShader).toContain('PI * vCs2ProbeLight.rgb');
  expect(shader.fragmentShader).toContain('UNROLLED_LOOP_INDEX == 0');
  expect(shader.fragmentShader).toContain('clamp(vCs2ProbeLight.a, 0.0, 1.0)');
  expect(shader.uniforms.cs2ProbeEnabled).toBe(enabled);
  expect(shader.uniforms.cs2SunShadow).toBeUndefined();
  enabled.value = 0;
  expect(shader.uniforms.cs2ProbeEnabled.value).toBe(0);
});
