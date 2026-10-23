import {
  BatchedMesh,
  type Camera,
  type Fog,
  type FogExp2,
  type Material,
  Mesh,
  type Object3D,
  Scene,
  Texture,
  Vector4,
  type WebGLRenderer,
} from 'three';
import { yieldRenderTask } from './render-schedule';

/** Prepare GPU resources before navigation, including surfaces outside the spawn view.
 * No texture downscaling, geometry removal or extra passes during normal rendering. */
export async function warmRenderMap(
  renderer: WebGLRenderer,
  root: Object3D,
  camera: Camera,
  fogs: (Fog | FogExp2 | null)[],
  signal: AbortSignal,
  progress?: (message: string) => void,
) {
  signal.throwIfAborted();
  if (root.parent) throw Error('Prepare render resources before attaching the map');
  const started = performance.now();
  const scene = new Scene();
  scene.add(root);
  const meshes: { mesh: Mesh; cull: boolean; batchCull?: boolean }[] = [];
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  const texture = (value: unknown) => {
    if (value instanceof Texture) textures.add(value);
  };
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    meshes.push({
      mesh: object,
      cull: object.frustumCulled,
      batchCull: object instanceof BatchedMesh ? object.perObjectFrustumCulled : undefined,
    });
    for (const m of Array.isArray(object.material) ? object.material : [object.material])
      materials.add(m);
    for (const name of ['_matricesTexture', '_colorsTexture', '_indirectTexture'])
      texture((object as unknown as Record<string, unknown>)[name]);
  });
  const viewport = renderer.getViewport(new Vector4());
  const scissor = renderer.getScissor(new Vector4());
  const scissorTest = renderer.getScissorTest();
  try {
    for (const fog of fogs) {
      signal.throwIfAborted();
      progress?.('Preparing map shaders…');
      scene.fog = fog;
      const compiling = renderer.compile(scene, camera);
      // Three r170 compileAsync keeps polling disposed materials after cancellation.
      // Use its readiness check with an abort check before every poll instead.
      while (compiling.size) {
        signal.throwIfAborted();
        for (const material of compiling) {
          const { currentProgram: program } = renderer.properties.get(material) as {
            currentProgram?: { isReady(): boolean };
          };
          if (!program || program.isReady()) compiling.delete(material);
        }
        if (compiling.size) await new Promise<void>((resolve) => setTimeout(resolve, 4));
      }
      await yieldRenderTask();
    }
    for (const material of materials) {
      for (const value of Object.values(material)) texture(value);
      // Disabled texture variants do not reference their layer/mask samplers.
      if ((material as Material & { map?: Texture | null }).map) {
        for (const value of material.userData.cs2Textures ?? []) texture(value);
        for (const value of material.userData.cs2Masks ?? []) texture(value);
      }
      const sun = material.userData.cs2Sun;
      if (sun?.status === 'active') texture(sun.texture);
      if (sun?.irradiance?.status === 'active') texture(sun.irradiance.texture);
    }
    let uploaded = 0;
    let yieldAt = performance.now() + 3;
    for (const value of textures) {
      signal.throwIfAborted();
      renderer.initTexture(value);
      uploaded++;
      if (performance.now() >= yieldAt) {
        progress?.(`Preparing map textures ${uploaded}/${textures.size}…`);
        await yieldRenderTask();
        yieldAt = performance.now() + 3;
      }
    }
    // Compilation does not initialize geometry buffers. A tiny scissored draw
    // uploads every batch using the actual screen shader/output color space.
    // A render target would compile different output shaders and duplicate work.
    for (const { mesh } of meshes) {
      mesh.frustumCulled = false;
      if (mesh instanceof BatchedMesh) mesh.perObjectFrustumCulled = false;
    }
    for (const fog of fogs) {
      signal.throwIfAborted();
      progress?.('Preparing map geometry…');
      scene.fog = fog;
      renderer.setViewport(0, 0, 1, 1);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
      renderer.render(scene, camera);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      await yieldRenderTask();
    }
    signal.throwIfAborted();
    return { ms: performance.now() - started, textures: textures.size, meshes: meshes.length };
  } finally {
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    for (const { mesh, cull, batchCull } of meshes) {
      mesh.frustumCulled = cull;
      if (mesh instanceof BatchedMesh && batchCull !== undefined)
        mesh.perObjectFrustumCulled = batchCull;
    }
    scene.remove(root);
    renderer.renderLists.dispose();
  }
}
