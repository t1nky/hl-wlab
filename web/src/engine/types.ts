import type { LibraryMapRef } from '../storage/library-types.ts';
import type { WeaponID } from './weapons.ts';
/** Dense numeric buffers keep the WASM boundary allocation-free per sample. */
export type Vector = number[];
export type V3 = [number, number, number];
export function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing required analysis data');
  return value;
}
export interface Transform {
  origin: Vector;
  angles: Vector;
}
export interface Brush extends Transform {
  index: number;
  solid: boolean;
  classname: string;
  first: number;
  count: number;
  mins: Vector;
  maxs: Vector;
}
export interface Texture {
  name: string;
  width: number;
  height: number;
  rgba?: Uint8Array<ArrayBuffer> | null;
}
export interface Face {
  index: number;
  brush: number;
  normal: Vector;
  texture: number;
  points: Vector[];
  uv: number[][];
}
export interface BSP {
  buffer: ArrayBuffer;
  entities: Record<string, string>[];
  textures: Texture[];
  brushes: Brush[];
  faces: Face[];
  world: Brush;
  name: string;
}
export interface Bone {
  name: string;
  parent: number;
  controllers: number[];
  value: number[];
  scale: number[];
}
export interface Sequence {
  index: number;
  name: string;
  frames: number;
  blends: number;
  anim: number;
  start: number;
  end: number;
  group: number;
}
export interface PoseOptions {
  frame?: number;
  yawBlend?: number;
  pitchBlend?: number;
  gait?: number;
}
export interface Hitbox {
  group: number;
  mins: Vector;
  maxs: Vector;
  matrix: number[];
}
export interface Pose {
  boxes: Hitbox[];
  aims: Vector[];
}
export interface Player {
  p: Vector;
  duck: boolean;
  ground: boolean;
}
export interface Target {
  p: Vector;
  yaw: number;
  pitch: number;
  seq: number;
  options: PoseOptions;
}
export type SkySide = 'rt' | 'bk' | 'lf' | 'ft' | 'up' | 'dn';
export interface Skybox {
  name: string;
  faces: Record<SkySide, ArrayBuffer>;
}
export interface Assets {
  library?: LibraryMapRef;
  map?: ArrayBuffer;
  model?: ArrayBuffer;
  materials?: string;
  snapshot?: string;
  mapName?: string;
  skybox?: Skybox | null;
  skyOverride?: Skybox;
}
export interface ScanRequest {
  type: 'scan';
  map: ArrayBuffer;
  brushes: Brush[];
  materials: string;
  modelHash: string;
  pose: Pose;
  expansion: number;
  target: Vector;
  spacing: number;
  radius: number;
  workers: number;
  weapon: WeaponID;
}
export interface Progress {
  type: 'progress';
  phase: string;
  total: number;
  done: number;
  /** Candidate enumeration has finished, so the total will no longer grow. */
  totalKnown: boolean;
  reused?: number;
  placementReused?: number;
  computed?: number;
  valid?: number;
  seconds?: number;
  workers?: number;
}
export interface Complete extends Omit<Progress, 'type' | 'phase'> {
  type: 'complete';
  rows: Float32Array;
  cancelled: boolean;
  identity: string;
  shotID: string;
}
export interface Failure {
  type: 'error';
  message: string;
}
export type ScanResponse = Progress | Complete | Failure;
export interface TraceInit extends Omit<ScanRequest, 'type'> {
  type: 'init';
  textures: Pick<Texture, 'name'>[];
  core: WebAssembly.Module;
}
export interface TraceWork {
  type: 'work';
  input: Float32Array;
  count: number;
}
export type TraceResponse = { type: 'ready' } | { type: 'result'; result: Float32Array } | Failure;
