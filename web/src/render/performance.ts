import {
  BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
  RedFormat,
  RedIntegerFormat,
  RGBFormat,
  RGFormat,
  RGIntegerFormat,
  Texture,
} from 'three';

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}
export interface FrameSample {
  fps: number;
  cpuMs?: number;
  gpuMs?: number;
}

/** Counts rendered frames; never schedules work or waits for the GPU. */
export class FrameMonitor {
  private readonly gl: WebGL2RenderingContext;
  private enabled = false;
  private extension?: TimerExtension | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  private nextQuery = 0;
  private frames = 0;
  private cpu = 0;
  private since = 0;
  private lastGpu?: number;
  private lastGpuAt = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  setEnabled(enabled: boolean, now: number) {
    this.releaseQueries();
    this.enabled = enabled;
    this.frames = this.cpu = 0;
    this.since = now;
    this.lastGpu = undefined;
    this.nextQuery = now;
    if (enabled && this.extension === undefined)
      this.extension = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  contextChanged(now: number) {
    this.releaseQueries();
    this.extension = undefined;
    this.setEnabled(this.enabled, now);
  }

  contextLost() {
    // The lost context has already released its queries. Do not pass the old
    // objects back to the restored context, where they are no longer valid.
    this.active = null;
    this.pending = [];
    this.extension = undefined;
    this.lastGpu = undefined;
  }

  beginFrame(now: number) {
    if (
      !this.enabled ||
      !this.extension ||
      this.active ||
      this.pending.length >= 4 ||
      now < this.nextQuery ||
      this.gl.isContextLost()
    )
      return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = query;
    this.nextQuery = now + 250;
  }

  endFrame(cpuMs: number) {
    if (!this.enabled) return;
    this.frames++;
    this.cpu += cpuMs;
    if (this.active) {
      if (!this.gl.isContextLost() && this.extension) {
        this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
        this.pending.push(this.active);
      }
      this.active = null;
    }
  }

  sample(now: number): FrameSample {
    if (this.extension && !this.gl.isContextLost()) {
      if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
        this.releaseQueries();
        this.lastGpu = undefined;
      } else {
        let total = 0,
          count = 0;
        while (this.pending.length) {
          const query = this.pending[0];
          if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
          this.pending.shift();
          const ns = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
          this.gl.deleteQuery(query);
          if (Number.isFinite(ns) && ns >= 0) {
            total += ns / 1e6;
            count++;
          }
        }
        if (count) {
          this.lastGpu = total / count;
          this.lastGpuAt = now;
        }
      }
    }
    const sample = {
      fps: this.frames ? (1000 * this.frames) / Math.max(1, now - this.since) : 0,
      cpuMs: this.frames ? this.cpu / this.frames : undefined,
      gpuMs: now - this.lastGpuAt < 1500 ? this.lastGpu : undefined,
    };
    this.frames = this.cpu = 0;
    this.since = now;
    return sample;
  }

  private releaseQueries() {
    if (!this.gl.isContextLost()) {
      if (this.active && this.extension) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      if (this.active) this.gl.deleteQuery(this.active);
      for (const query of this.pending) this.gl.deleteQuery(query);
    }
    this.active = null;
    this.pending = [];
  }
}

/** Storage estimate, not driver allocation: compressed blocks stay compressed. */
export function textureBytes(texture: Texture): number {
  if (texture.mipmaps?.length && texture.mipmaps.every((mip) => 'data' in mip))
    return texture.mipmaps.reduce((bytes, mip) => bytes + mip.data.byteLength, 0);
  const image = texture.image;
  if (!image) return 0;
  const images = Array.isArray(image) ? image : [image];
  const components =
    texture.format === RedFormat || texture.format === RedIntegerFormat
      ? 1
      : texture.format === RGFormat || texture.format === RGIntegerFormat
        ? 2
        : texture.format === RGBFormat
          ? 3
          : 4;
  let bytes = 0;
  for (const image of images) {
    const data = image.data as ArrayBufferView | undefined;
    bytes += data?.byteLength ?? (image.width ?? 0) * (image.height ?? 0) * components;
  }
  // Sum actual dimensions, including narrow/non-power-of-two textures.
  if (texture.generateMipmaps) {
    for (const image of images) {
      let width = image.width ?? 0,
        height = image.height ?? 0;
      const pixelBytes = image.data
        ? image.data.byteLength / Math.max(1, width * height)
        : components;
      while (width > 1 || height > 1) {
        width = Math.max(1, width >> 1);
        height = Math.max(1, height >> 1);
        bytes += width * height * pixelBytes;
      }
    }
  }
  return bytes;
}

/** Loaded scene upper bound. Excludes framebuffers, driver overhead and other apps. */
export function estimateSceneBytes(scene: Object3D): number {
  let bytes = 0;
  const attributes = new Set<object>();
  const sources = new Map<object, Set<string>>();
  const addTexture = (value: unknown) => {
    if (!(value instanceof Texture)) return;
    // Match the pinned Three texture cache: UV clones share GPU storage.
    const key = [
      value.wrapS,
      value.wrapT,
      'wrapR' in value ? value.wrapR : 0,
      value.magFilter,
      value.minFilter,
      value.anisotropy,
      value.internalFormat,
      value.format,
      value.type,
      value.generateMipmaps,
      value.premultiplyAlpha,
      value.flipY,
      value.unpackAlignment,
      value.colorSpace,
    ].join();
    const keys = sources.get(value.source) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    sources.set(value.source, keys);
    bytes += textureBytes(value);
  };
  const addMaterial = (material: Material) => {
    for (const value of Object.values(material)) addTexture(value);
    for (const value of Object.values(material.userData)) addTexture(value);
    for (const value of material.userData.cs2Textures ?? []) addTexture(value);
    for (const value of material.userData.cs2Masks ?? []) addTexture(value);
    addTexture(material.userData.cs2Sun?.texture);
    addTexture(material.userData.cs2Sun?.irradiance?.texture);
    const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> })
      .uniforms;
    for (const uniform of Object.values(uniforms ?? {})) addTexture(uniform.value);
  };
  addTexture((scene as Object3D & { background?: unknown }).background);
  addTexture((scene as Object3D & { environment?: unknown }).environment);
  scene.traverse((object) => {
    const mesh = object as Mesh;
    const geometry = mesh.geometry;
    if (geometry instanceof BufferGeometry) {
      for (const attribute of [geometry.index, ...Object.values(geometry.attributes)]) {
        if (!attribute) continue;
        const buffer = 'data' in attribute ? attribute.data : attribute;
        if (attributes.has(buffer)) continue;
        attributes.add(buffer);
        bytes += buffer.array.byteLength;
      }
    }
    if (mesh.material)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        addMaterial(material);
    addTexture(object.userData.cs2SunTexture);
    addTexture(object.userData.cs2IrradianceTexture);
    for (const texture of object.userData.cs2MaskTextures ?? []) addTexture(texture);
    // BatchedMesh r170 stores its instance tables in private DataTextures.
    for (const key of ['_matricesTexture', '_colorsTexture', '_indirectTexture'] as const)
      addTexture((object as unknown as Record<string, unknown>)[key]);
    addTexture(
      (object as unknown as { skeleton?: { boneTexture?: Texture } }).skeleton?.boneTexture,
    );
  });
  return bytes;
}
