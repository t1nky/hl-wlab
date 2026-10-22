import type { Texture } from './types.ts';

export interface WadEntry {
  offset: number;
  size: number;
}
const text = (bytes: Uint8Array, start: number, length: number) =>
  new TextDecoder().decode(bytes.subarray(start, start + length)).split('\0')[0];
export async function readWadIndex(file: Blob) {
  if (file.size < 12 || file.size > 128 * 1048576)
    throw Error('Invalid WAD size (maximum 128 MiB)');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (text(header, 0, 4) !== 'WAD3') throw Error('Expected a GoldSrc WAD3 file');
  const d = new DataView(header.buffer);
  const count = d.getInt32(4, true),
    at = d.getInt32(8, true);
  if (count < 0 || count > 65536 || at < 12 || at > file.size - count * 32)
    throw Error('Invalid WAD directory');
  const directory = new Uint8Array(await file.slice(at, at + count * 32).arrayBuffer());
  const entries = new Map<string, WadEntry>();
  const view = new DataView(directory.buffer);
  for (let j = 0; j < count; j++) {
    const p = j * 32,
      offset = view.getInt32(p, true),
      size = view.getInt32(p + 4, true);
    if (offset < 12 || size < 0 || offset > file.size - size)
      throw Error('Invalid WAD entry range');
    if (directory[p + 12] !== 67 || directory[p + 13] !== 0 || size !== view.getInt32(p + 8, true))
      continue;
    entries.set(text(directory, p + 16, 16).toLowerCase(), { offset, size });
  }
  return entries;
}
export function readWadTexture(buffer: ArrayBuffer): Texture {
  if (buffer.byteLength < 40) throw Error('Truncated WAD texture');
  const d = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  const name = text(bytes, 0, 16),
    width = d.getUint32(16, true),
    height = d.getUint32(20, true);
  if (!width || !height || width > 4096 || height > 4096)
    throw Error('Invalid WAD texture dimensions');
  for (let j = 0; j < 4; j++) {
    const at = d.getUint32(24 + j * 4, true),
      count = (width >> j) * (height >> j);
    if (at < 40 || at > buffer.byteLength - count) throw Error('Invalid WAD mip range');
  }
  const pixels = d.getUint32(24, true),
    palette = d.getUint32(36, true) + (width >> 3) * (height >> 3);
  if (palette > buffer.byteLength - 770 || d.getUint16(palette, true) !== 256)
    throw Error('Invalid WAD palette');
  const rgba = new Uint8Array(width * height * 4);
  for (let j = 0; j < width * height; j++) {
    const color = bytes[pixels + j],
      source = palette + 2 + color * 3;
    rgba[j * 4] = bytes[source];
    rgba[j * 4 + 1] = bytes[source + 1];
    rgba[j * 4 + 2] = bytes[source + 2];
    rgba[j * 4 + 3] = name.startsWith('{') && color === 255 ? 0 : 255;
  }
  return { name, width, height, rgba };
}
