export type V3 = [number, number, number];
export function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing required collision/worker data');
  return value;
}
export interface Surface {
  name: string;
  hash: number;
  distanceModifier: number | null;
  damageModifier: number | null;
  gameMaterial: string | null;
}
export interface Shape {
  kind: 'mesh' | 'hull';
  source: string;
  group: string;
  tags: string[];
  exclude: string[];
  bullet: boolean;
  player: boolean;
  firstTriangle: number;
  triangleCount: number;
  planes: number[][];
}
export interface Metadata {
  schema: number;
  map: string;
  fingerprint: string;
  steamInf: string;
  binarySha256: string;
  prepareMs: number;
  binaryBytes: number;
  vertexCount: number;
  triangleCount: number;
  weapon: {
    name: string;
    damage: number;
    penetration: number;
    range: number;
    rangeModifier: number;
  };
  materials: Surface[];
  shapes: Shape[];
  stats: Record<string, number>;
  spawns: { classname: string; origin: V3 }[];
  warnings: string[];
}
export interface MapData {
  positions: Float32Array;
  indices: Uint32Array;
  materials: Uint32Array;
  shapes: Uint32Array;
}
export function decodeMap(buffer: ArrayBuffer): MapData {
  const header = new Uint32Array(buffer, 0, 4);
  if (header[0] !== 0x50325343 || header[2] !== header[3] * 3)
    throw Error('Invalid CS2 collision package header');
  const [, vertices, indices, triangles] = header;
  const size = 16 + vertices * 12 + indices * 4 + triangles * 8;
  if (buffer.byteLength !== size) throw Error('Truncated CS2 collision package');
  return {
    positions: new Float32Array(buffer, 16, vertices * 3),
    indices: new Uint32Array(buffer, 16 + vertices * 12, indices),
    materials: new Uint32Array(buffer, 16 + vertices * 12 + indices * 4, triangles),
    shapes: new Uint32Array(buffer, 16 + vertices * 12 + indices * 4 + triangles * 4, triangles),
  };
}
export interface Span {
  enter: number;
  exit: number;
  material: number;
  exitMaterial: number;
  shape: number;
  startInside: boolean;
}
export interface Shot {
  source: V3;
  target: V3;
  distance: number;
  spans: Span[];
  contacts: { distance: number; material: number; shape: number; facing: number }[];
  issues: string[];
  damage: number | null;
  status: 'clear' | 'estimated-penetration' | 'blocked' | 'indeterminate';
  ms: number;
}
export const EPS = 0.01;
