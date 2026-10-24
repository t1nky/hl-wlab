import {
  BackSide,
  Box3,
  BoxGeometry,
  CompressedCubeTexture,
  LessEqualDepth,
  LinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  RGB_BPTC_UNSIGNED_Format,
  ShaderMaterial,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { readCompressedBlocks } from './render-native-textures';

export interface SkyMetadata {
  schema: number;
  file: string;
  format: string;
  size: number;
  gpuBytes: number;
  tint: [number, number, number];
  angles: [number, number, number];
}

// A background has no physical extent. Do not pull the origin into distant
// custom-map bounds or affect Fit map / default target placement.
class SkyMesh extends Mesh<BoxGeometry, ShaderMaterial> {
  readonly boundingBox = new Box3();
}

export async function loadSky(
  meta: SkyMetadata,
  base: string,
  version: string,
  renderer?: WebGLRenderer,
  signal?: AbortSignal,
) {
  if (!renderer?.extensions.has('EXT_texture_compression_bptc')) return;
  if (
    meta.schema !== 1 ||
    meta.format !== 'BC6H_UFLOAT_CUBE' ||
    meta.file !== 'render/sky.bc6h.gz' ||
    !Number.isInteger(meta.size) ||
    meta.size < 4 ||
    meta.size > 2048 ||
    meta.size % 4 ||
    meta.gpuBytes !== 6 * meta.size ** 2 ||
    ![meta.tint, meta.angles].every(
      (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite),
    )
  )
    throw Error('Invalid HDR sky');
  const blocks = await readCompressedBlocks(
    `${base}${meta.file}?v=${encodeURIComponent(version)}`,
    meta.gpuBytes,
    signal,
  );
  signal?.throwIfAborted();
  const faceBytes = meta.size ** 2;
  const texture = new CompressedCubeTexture(
    Array.from({ length: 6 }, (_, i) => ({
      width: meta.size,
      height: meta.size,
      mipmaps: [
        {
          width: meta.size,
          height: meta.size,
          data: blocks.subarray(i * faceBytes, (i + 1) * faceBytes),
        },
      ],
    })),
    RGB_BPTC_UNSIGNED_Format,
  );
  texture.colorSpace = NoColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const rad = Math.PI / 180;
  const rotation = new Matrix4()
    .makeRotationZ(meta.angles[1] * rad)
    .multiply(new Matrix4().makeRotationY(meta.angles[0] * rad))
    .multiply(new Matrix4().makeRotationX(meta.angles[2] * rad));
  const material = new ShaderMaterial({
    uniforms: {
      sky: { value: texture },
      tint: { value: new Vector3(...meta.tint) },
      rotation: { value: rotation },
    },
    vertexShader: `varying vec3 direction; uniform mat4 rotation;
      void main() { direction = position; vec4 clip = projectionMatrix * mat4(mat3(viewMatrix)) * rotation * vec4(position, 1.0); gl_Position = clip.xyww; }`,
    fragmentShader: `varying vec3 direction; uniform samplerCube sky; uniform vec3 tint;
      void main() { gl_FragColor = vec4(max(textureCube(sky, normalize(direction)).rgb * tint, vec3(0.0)), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    depthWrite: false,
    depthFunc: LessEqualDepth,
    side: BackSide,
    fog: false,
  });
  const mesh = new SkyMesh(new BoxGeometry(2, 2, 2), material);
  mesh.name = 'Source HDR sky';
  mesh.userData.cs2Sky = true;
  mesh.frustumCulled = false;
  return mesh;
}
