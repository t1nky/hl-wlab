import { type BufferGeometry, ShaderChunk, type WebGLProgramParametersWithUniforms } from 'three';

export function hasProbeLighting(geometry: BufferGeometry): boolean {
  const attribute = geometry.getAttribute('_cs2_probe_light');
  if (!attribute) return false;
  if (
    geometry.userData.cs2Lighting?.mode !== 'probe' ||
    geometry.userData.cs2Lighting?.storage !== 'linear-irradiance-sun-visibility' ||
    attribute.itemSize !== 4 ||
    attribute.normalized ||
    !(attribute.array instanceof Float32Array) ||
    attribute.count !== geometry.getAttribute('position').count
  )
    throw Error('Invalid baked prop lighting');
  return true;
}

/** Static probes are sampled at import. No probe atlas, per-frame work or extra pass. */
export function patchProbeLighting(
  shader: WebGLProgramParametersWithUniforms,
  enabled: { value: number },
) {
  shader.uniforms.cs2ProbeEnabled = enabled;
  shader.vertexShader = `attribute vec4 _cs2_probe_light; varying vec4 vCs2ProbeLight;\n${shader.vertexShader}`;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <uv_vertex>',
    '#include <uv_vertex>\nvCs2ProbeLight = _cs2_probe_light;',
  );
  shader.fragmentShader = `uniform float cs2ProbeEnabled; varying vec4 vCs2ProbeLight;\n${shader.fragmentShader}`;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_begin>',
    ShaderChunk.lights_fragment_begin.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      `getDirectionalLightInfo( directionalLight, directLight );
      #if ( UNROLLED_LOOP_INDEX == 0 )
        directLight.color *= mix(1.0, clamp(vCs2ProbeLight.a, 0.0, 1.0), cs2ProbeEnabled);
      #endif`,
    ),
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_end>',
    'irradiance = mix(irradiance, PI * vCs2ProbeLight.rgb, cs2ProbeEnabled);\n#include <lights_fragment_end>',
  );
}
