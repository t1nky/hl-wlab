import * as THREE from 'three';
import { brushMatrix, transform } from '../engine/bsp.ts';
import type { BSP, Face, Transform } from '../engine/types.ts';

const tools = new Set(['null', 'clip', 'origin', 'aaatrigger']);

// GoldSrc stores its T coordinate in the same row order as the indexed miptex
// pixels. DataTexture uploads those rows without flipping; do not negate T.
// Texture axes in face.uv already include the author's rotation/scale/offset.
export function buildMapMeshes(
  bsp: {
    textures: BSP['textures'];
    brushes: Transform[];
    faces: Omit<Face, 'index'>[];
    entities?: Record<string, string | undefined>[];
  },
  { textures = true, anisotropy = 1 } = {},
) {
  // Invisible brush entities can still be solid: Inferno uses transparent
  // wooden boxes around its detailed lamps. Cull only their render faces,
  // leaving BSP collision, candidate generation and shot traces untouched.
  const hidden = new Set();
  for (const entity of bsp.entities || []) {
    if (
      /^\*\d+$/.test(entity.model || '') &&
      Number(entity.rendermode || 0) !== 0 &&
      Number(entity.renderamt || 0) <= 0 &&
      Number(entity.renderfx || 0) === 0
    )
      hidden.add(Number((entity.model ?? '').slice(1)));
  }
  const groups = new Map<number, { positions: number[]; uv: number[]; color: number[] }>();
  for (const face of bsp.faces) {
    if (hidden.has(face.brush)) continue;
    const tex = bsp.textures[face.texture],
      name = tex?.name.toLowerCase();
    if (name?.startsWith('sky') || tools.has(name ?? '')) continue;
    const brush = bsp.brushes[face.brush],
      m = brushMatrix(brush),
      p = face.points.map((v) => transform(m, v));
    const n = transform(
      [...m.slice(0, 3), 0, ...m.slice(4, 7), 0, ...m.slice(8, 11), 0],
      face.normal,
    );
    let group = groups.get(face.texture);
    if (!group) {
      group = { positions: [], uv: [], color: [] };
      groups.set(face.texture, group);
    }
    const shade = 0.57 + 0.43 * Math.max(0, n[2] * 0.8 + n[0] * 0.25 - n[1] * 0.15);
    for (let k = 1; k < p.length - 1; k++)
      for (const i of [0, k, k + 1]) {
        group.positions.push(...p[i]);
        group.uv.push(face.uv[i][0] / (tex?.width || 16), face.uv[i][1] / (tex?.height || 16));
        group.color.push(shade, shade, shade);
      }
  }
  const meshes = [];
  for (const [id, data] of groups) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.color, 3));
    const source = bsp.textures[id];
    let texture: THREE.DataTexture | undefined;
    if (source?.rgba) {
      texture = new THREE.DataTexture(source.rgba, source.width, source.height, THREE.RGBAFormat);
      texture.name = source.name;
      texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = anisotropy;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
    }
    const material = new THREE.MeshBasicMaterial({
      map: textures ? texture : null,
      color: source?.rgba ? 0xffffff : 0x8697a4,
      vertexColors: true,
      side: THREE.BackSide,
      alphaTest: source?.name.startsWith('{') ? 0.5 : 0,
    });
    material.userData.texture = texture;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = source?.name || 'missing';
    meshes.push(mesh);
  }
  return meshes;
}
