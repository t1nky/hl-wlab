// Local-only map preparation. No game files or exports are uploaded.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { packRenderGeometry } from './cs2-render-pack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../.local/cs2/de_inferno', import.meta.url));

/** Lossless, old-decoder-compatible stream; verify exact bytes before publishing local output. */
export async function encodeRenderView(source, count, stride, mode) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const packed = MeshoptEncoder.encodeGltfBuffer(source, count, stride, mode, 0);
  const restored = new Uint8Array(source.length);
  MeshoptDecoder.decodeGltfBuffer(restored, count, stride, packed, mode);
  if (!Buffer.from(source).equals(Buffer.from(restored)))
    throw Error('Render compression round-trip failed');
  return packed;
}

/** Share only byte-identical attributes with identical interpretation. This also lets
 * GLTFLoader reuse complete primitive geometries across repeated static props. */
export function deduplicateRenderAccessors(gltf, buffers) {
  const accessors = [],
    views = [],
    remap = new Map(),
    seen = new Map();
  let savedBytes = 0;
  for (const [index, accessor] of gltf.accessors.entries()) {
    const view = gltf.bufferViews[accessor.bufferView];
    if (accessor.byteOffset || view.byteStride || accessor.sparse)
      throw Error('Unsupported render accessor layout');
    const source = buffers[view.buffer].subarray(
      view.byteOffset || 0,
      (view.byteOffset || 0) + view.byteLength,
    );
    const key = JSON.stringify([
      accessor.componentType,
      accessor.count,
      accessor.type,
      !!accessor.normalized,
      accessor.min,
      accessor.max,
      createHash('sha256').update(source).digest('hex'),
    ]);
    const prior = seen.get(key);
    if (prior && source.equals(prior.source)) {
      remap.set(index, prior.index);
      savedBytes += source.byteLength;
      continue;
    }
    const next = accessors.length;
    seen.set(key, { source, index: next });
    remap.set(index, next);
    accessors.push({ ...accessor, bufferView: views.length });
    views.push(view);
  }
  for (const mesh of gltf.meshes)
    for (const primitive of mesh.primitives) {
      primitive.indices = remap.get(primitive.indices);
      for (const name of Object.keys(primitive.attributes))
        primitive.attributes[name] = remap.get(primitive.attributes[name]);
    }
  gltf.accessors = accessors;
  gltf.bufferViews = views;
  return {
    savedBytes,
    uniqueAccessors: accessors.length,
    sharedAccessors: remap.size - accessors.length,
  };
}

async function compressRenderPackage() {
  const manifestPath = resolve(output, 'render.json');
  const metadata = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (metadata.compression?.codec === 'EXT_meshopt_compression v0') return;
  const timer = performance.now();
  let decodedBytes = 0;
  const remove = [];
  for (const chunk of metadata.chunks) {
    const gltfPath = resolve(output, chunk);
    const folder = dirname(gltfPath);
    const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));
    metadata.packedGeometry = packRenderGeometry(
      gltf,
      folder,
      chunk.replace('render/', '').replace('.gltf', ''),
    );
    const buffers = gltf.buffers.map((buffer) => {
      const path = resolve(folder, buffer.uri);
      if (!path.startsWith(output + sep)) throw Error('Render buffer escaped private output');
      remove.push(path);
      return readFileSync(path);
    });
    metadata.geometrySharing = deduplicateRenderAccessors(gltf, buffers);
    const byView = new Map();
    for (const accessor of gltf.accessors) {
      if (accessor.byteOffset) throw Error('Unsupported render accessor offset');
      const prior = byView.get(accessor.bufferView);
      if (prior && (prior.count !== accessor.count || prior.type !== accessor.type))
        throw Error('Unexpected interleaved render view');
      byView.set(accessor.bufferView, accessor);
    }
    const parts = [];
    let packedBytes = 0,
      fallbackBytes = 0;
    for (const [index, view] of gltf.bufferViews.entries()) {
      const accessor = byView.get(index);
      if (!accessor) throw Error('Unused render view survived compaction');
      const stride = view.byteLength / accessor.count;
      const mode = accessor.type === 'SCALAR' ? 'INDICES' : 'ATTRIBUTES';
      const source = buffers[view.buffer].subarray(
        view.byteOffset || 0,
        (view.byteOffset || 0) + view.byteLength,
      );
      // Required-extension fallback is virtual: compact its offsets too, so loaders
      // never reserve space for the duplicate accessors removed above.
      fallbackBytes = Math.ceil(fallbackBytes / 4) * 4;
      view.byteOffset = fallbackBytes;
      fallbackBytes += view.byteLength;
      const packed = await encodeRenderView(source, accessor.count, stride, mode);
      view.extensions = {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: packedBytes,
          byteLength: packed.length,
          byteStride: stride,
          count: accessor.count,
          mode,
          filter: 'NONE',
        },
      };
      view.buffer = 1;
      parts.push(packed);
      packedBytes += packed.length;
      if (index % 500 === 0)
        console.log(`Compressing render views ${index + 1}/${gltf.bufferViews.length}…`);
    }
    const file = chunk.replace('render/', '').replace('.gltf', '-meshopt.bin');
    decodedBytes += fallbackBytes;
    gltf.buffers = [
      { uri: file, byteLength: packedBytes },
      { byteLength: fallbackBytes, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ];
    gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed || []), 'EXT_meshopt_compression'])];
    gltf.extensionsRequired = [
      ...new Set([...(gltf.extensionsRequired || []), 'EXT_meshopt_compression']),
    ];
    gltf.extras = { ...gltf.extras, cs2CompactPrimitiveBounds: 1 };
    writeFileSync(resolve(folder, file), Buffer.concat(parts));
    writeFileSync(`${gltfPath}.tmp`, JSON.stringify(gltf));
    renameSync(`${gltfPath}.tmp`, gltfPath);
  }
  const files = new Set(metadata.chunks);
  for (const chunk of metadata.chunks) {
    const gltf = JSON.parse(readFileSync(resolve(output, chunk), 'utf8'));
    for (const buffer of gltf.buffers) if (buffer.uri) files.add(`render/${buffer.uri}`);
    for (const image of gltf.images) files.add(`render/${image.uri}`);
  }
  metadata.files = [...files]
    .sort()
    .map((path) => ({ path, bytes: statSync(resolve(output, path)).size }));
  metadata.totalBytes = metadata.files.reduce((sum, file) => sum + file.bytes, 0);
  metadata.compression = {
    codec: 'EXT_meshopt_compression v0',
    encoder: 'meshoptimizer 1.3.0 (MIT)',
    lossless: true,
    allViewsRoundTripVerified: true,
    decodedGeometryBytes: decodedBytes,
    ms: performance.now() - timer,
  };
  metadata.compactPrimitiveBounds = 1;
  metadata.prepareMs += metadata.compression.ms;
  metadata.packageHash = createHash('sha256').update(JSON.stringify(metadata.files)).digest('hex');
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(metadata));
  renameSync(`${manifestPath}.tmp`, manifestPath);
  for (const file of remove) unlinkSync(file);
  console.log(
    `Verified lossless render package: ${(metadata.totalBytes / 1048576).toFixed(1)} MiB disk; ${(decodedBytes / 1048576).toFixed(1)} MiB decoded geometry; compression ${(metadata.compression.ms / 1000).toFixed(2)} s.`,
  );
}

if (import.meta.main) {
  const game =
    process.argv.find((arg) => arg.startsWith('--game='))?.slice(7) ||
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive';
  const result = spawnSync(
    'dotnet',
    [
      'run',
      '--project',
      'tools/cs2-import',
      '--',
      game,
      output,
      ...(process.argv.includes('--force') ? ['--force'] : []),
      ...(process.argv.includes('--render') ? ['--render'] : []),
      ...(process.argv.includes('--player') ? ['--player'] : []),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && process.argv.includes('--render')) await compressRenderPackage();
}
