// Local preparation only. Reindex each primitive to its referenced vertices so browser
// batches do not copy a shared whole-map vertex buffer once for every small prop.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const dimensions = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const formats = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** Undo the pinned VRF exporter's local-space overlay lift, before instance transforms.
 * @param {Float32Array} positions Owned, compacted positions in glTF metres.
 * @param {Float32Array} normals The same local normals VRF used (do not renormalize).
 * @param {number} offsetMetres Exact displacement recorded by the pinned converter.
 */
export function restoreOverlayPositions(positions, normals, offsetMetres) {
  if (!Number.isFinite(offsetMetres) || offsetMetres < 0 || positions.length !== normals.length)
    throw Error('Invalid overlay displacement correction');
  for (let i = 0; i < positions.length; i++) positions[i] -= normals[i] * offsetMetres;
}

export function compactPrimitive(attributes, originalIndices, paintMode = 'environment') {
  const used = [];
  const remap = new Map();
  const indices = new Uint32Array(originalIndices.length);
  for (let i = 0; i < originalIndices.length; i++) {
    const old = originalIndices[i];
    if (!Number.isInteger(old) || old < 0 || old >= attributes.POSITION.array.length / 3)
      throw Error('Invalid private render index');
    let next = remap.get(old);
    if (next === undefined) {
      next = used.length;
      used.push(old);
      remap.set(old, next);
    }
    indices[i] = next;
  }
  /** @type {Record<string, {array: Float32Array | Uint8Array | Uint16Array | Uint32Array, size: number, normalized: boolean}>} */
  const result = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    const { array, size, normalized = false } = attribute;
    const paint = name === 'COLOR_0';
    if (paint && paintMode === 'none') continue; // foliage COLOR is wind data, not paint
    const components = paint && paintMode === 'environment' ? 3 : size;
    const packed = paint
      ? new Float32Array(used.length * components)
      : new array.constructor(used.length * size);
    const divisor = normalized ? (array instanceof Uint8Array ? 255 : 65535) : 1;
    for (let i = 0; i < used.length; i++) {
      const start = used[i] * size;
      const alpha = size === 4 ? array[start + 3] / divisor : 1;
      for (let c = 0; c < components; c++) {
        let value = array[start + c] / divisor;
        if (paint && paintMode === 'environment') value = 1 + (value - 1) * alpha;
        else if (paint && paintMode === 'srgb' && c < 3)
          value = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        else if (
          paint &&
          paintMode === 'overlay' &&
          array.subarray(start, start + size).every((v) => v === 0)
        )
          value = 1;
        packed[i * components + c] = paint ? value : array[start + c];
      }
    }
    result[name] = { array: packed, size: components, normalized: paint ? false : normalized };
  }
  return { attributes: result, indices };
}

export function packRenderGeometry(gltf, folder, basename) {
  const buffers = gltf.buffers.map(({ uri }) => {
    const path = resolve(folder, uri);
    if (!path.startsWith(resolve(folder) + sep))
      throw Error('Render buffer escaped private folder');
    return { path, bytes: readFileSync(path) };
  });
  function readAccessor(index) {
    const a = gltf.accessors[index];
    const view = gltf.bufferViews[a.bufferView];
    const Type = formats[a.componentType];
    const size = dimensions[a.type];
    if (!Type || !size || a.sparse || view.byteStride)
      throw Error('Unsupported private render accessor');
    const start = (view.byteOffset || 0) + (a.byteOffset || 0);
    const bytes = buffers[view.buffer].bytes;
    return {
      array: new Type(bytes.buffer, bytes.byteOffset + start, a.count * size),
      size,
      normalized: !!a.normalized,
    };
  }
  const accessors = [],
    views = [];
  const file = `${basename}-packed.bin`;
  const handle = openSync(resolve(folder, file), 'w');
  let offset = 0,
    vertices = 0,
    triangles = 0,
    restoredOverlays = 0;
  function writeAccessor(attribute, name = '') {
    const { array, size, normalized } = attribute;
    while (offset % 4) {
      writeSync(handle, new Uint8Array(1));
      offset++;
    }
    const view = views.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength });
    writeSync(handle, new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    offset += array.byteLength;
    const accessor = {
      bufferView: view,
      componentType: Object.entries(formats).find(([, Type]) => array instanceof Type)[0] * 1,
      count: array.length / size,
      type: Object.keys(dimensions).find((key) => dimensions[key] === size),
    };
    if (normalized) accessor.normalized = true;
    if (name === 'POSITION') {
      accessor.min = [Infinity, Infinity, Infinity];
      accessor.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i++) {
        const c = i % 3;
        accessor.min[c] = Math.min(accessor.min[c], array[i]);
        accessor.max[c] = Math.max(accessor.max[c], array[i]);
      }
    }
    const id = accessors.length;
    accessors.push(accessor);
    return id;
  }
  try {
    for (const mesh of gltf.meshes)
      for (const primitive of mesh.primitives) {
        const attributes = Object.fromEntries(
          Object.entries(primitive.attributes).map(([name, index]) => [name, readAccessor(index)]),
        );
        const settings = gltf.materials[primitive.material]?.extras?.cs2;
        if (!settings?.layers?.length) delete attributes._TEXCOORD_4;
        if (
          settings?.uv.channel !== 1 &&
          !settings?.layers?.some((layer) => layer.uv.channel === 1)
        )
          delete attributes.TEXCOORD_1;
        const compact = compactPrimitive(
          attributes,
          readAccessor(primitive.indices).array,
          settings?.vertexPaint ?? 'none',
        );
        if (settings?.vrfOverlayOffsetMetres > 0) {
          const positions = compact.attributes.POSITION.array;
          const normals = compact.attributes.NORMAL?.array;
          if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array))
            throw Error('Overlay correction requires float positions and normals');
          restoreOverlayPositions(positions, normals, settings.vrfOverlayOffsetMetres);
          restoredOverlays++;
        }
        if (compact.attributes.COLOR_0?.array.every((value) => value === 1))
          delete compact.attributes.COLOR_0;
        primitive.attributes = Object.fromEntries(
          Object.entries(compact.attributes).map(([name, attribute]) => [
            name,
            writeAccessor(attribute, name),
          ]),
        );
        primitive.indices = writeAccessor({ array: compact.indices, size: 1 });
        vertices += compact.attributes.POSITION.array.length / 3;
        triangles += compact.indices.length / 3;
      }
  } finally {
    closeSync(handle);
  }
  gltf.accessors = accessors;
  gltf.bufferViews = views;
  gltf.buffers = [{ uri: file, byteLength: offset }];
  for (const buffer of buffers) unlinkSync(buffer.path);
  return { vertices, triangles, bytes: offset, restoredOverlays };
}
