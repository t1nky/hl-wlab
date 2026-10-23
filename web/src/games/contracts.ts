import type { AimPoint } from '../engine/aims';
import type { Complete, Progress, V3 } from '../engine/types';
import { WEAPONS, type WeaponID } from '../engine/weapons';
import type { TargetPose } from './target';

export type GameID = 'goldsrc' | 'cs2';
export interface ScanSettings {
  spacing: number;
  radius: number;
  workers: number;
}
export interface DamageView {
  armor: number;
  armorValue: number;
  armorRatio: number;
  aimPoint: AimPoint;
}
export interface PointData {
  positions: Float32Array;
  hp: Float32Array;
  kind: Float32Array;
}
export interface SelectedSample {
  eye: V3;
  origin: V3;
  crouched: boolean;
  aim: V3;
  anchor: number;
  hp: number;
  walls: number;
  group: number;
  status: string;
}
export interface ShotDetails {
  title: string;
  summary: string;
  text: string;
  source: V3;
  aim: V3;
  intervals?: { enter: number; exit: number }[];
}
export interface TargetInput {
  p: V3;
  yaw: number;
  pitch: number;
  seq: number;
  frame: number;
  yawBlend: number;
  pitchBlend: number;
  gait: number;
  expansion: number;
}
export interface PoseChoice {
  index: number;
  name: string;
  frames: number;
  crouched: boolean;
}
export interface AnalysisProgress {
  phase: string;
  done: number;
  total: number;
  seconds: number;
  native?: Omit<Progress, 'type'>;
}
export interface ScanOutcome {
  cancelled: boolean;
  ms: number;
  summary: string;
  native?: Complete;
}
/** Shared analysis contract. UI/camera never interpret a game's native scan rows or pose format. */
export interface GameAnalysis {
  readonly definition: GameDefinition;
  readonly count: number;
  readonly poseChoices: PoseChoice[];
  readonly targetPose?: TargetPose;
  setTarget(input: TargetInput): TargetPose;
  placement(
    body: { origin: V3; crouched: boolean; grounded: boolean },
    yaw: number,
    pitch: number,
  ): TargetInput;
  clearSamples(): void;
  classify(view: DamageView): PointData;
  selection(index: number, view: DamageView): SelectedSample;
  scan(settings: ScanSettings, progress: (event: AnalysisProgress) => void): Promise<ScanOutcome>;
  cancel(): void;
  inspect(source: V3, view: DamageView, anchor?: number): Promise<ShotDetails>;
}
export interface GameDefinition {
  id: GameID;
  label: string;
  weapons: readonly WeaponID[];
  workers: readonly number[];
  features: Readonly<
    Record<
      'armor' | 'pitch' | 'blend' | 'bookmarks' | 'importFiles' | 'libraryImport' | 'sky',
      boolean
    >
  >;
  scan: {
    cached: boolean;
    defaults: ScanSettings;
    maxCells?: number;
    minSpacing: number;
    maxRadius: number;
    note: string;
  };
  target: {
    originLabel: string;
    crouchOriginShift: number;
    note: string;
    defaults: { p: V3; yaw: number; sequence: number };
    eyeOffsets: [number, number];
  };
  defaultSource?: V3;
  damageLabel: string;
  damageUnit: string;
}
export const GOLDSRC: GameDefinition = {
  id: 'goldsrc',
  label: 'CS 1.6',
  weapons: Object.keys(WEAPONS) as WeaponID[],
  workers: [1, 2, 4],
  features: {
    armor: true,
    pitch: true,
    blend: true,
    bookmarks: true,
    importFiles: true,
    libraryImport: true,
    sky: true,
  },
  scan: {
    cached: true,
    defaults: { spacing: 12, radius: 8192, workers: 4 },
    minSpacing: 3,
    maxRadius: 8192,
    note: 'Static posed MDL target; cached GoldSrc bullet simulation.',
  },
  target: {
    originLabel: 'Z body origin',
    defaults: { p: [1159.721435546, 288.663604736, 260.031097412], yaw: 169.53300476, sequence: 1 },
    eyeOffsets: [17, 12],
    crouchOriginShift: -18,
    note: 'Hitbox wireframe from the imported MDL and selected animation frame.',
  },
  damageLabel: 'HP',
  damageUnit: 'HP',
};
export const CS2: GameDefinition = {
  id: 'cs2',
  label: 'CS2 · experimental',
  weapons: ['awp'],
  workers: [1, 2, 4],
  features: {
    armor: true,
    pitch: false,
    blend: false,
    bookmarks: false,
    importFiles: false,
    libraryImport: false,
    sky: false,
  },
  scan: {
    cached: false,
    defaults: { spacing: 24, radius: 1024, workers: 1 },
    minSpacing: 3,
    maxRadius: 8192,
    maxCells: 100000,
    note: 'Estimated target HP: posed hitgroup + armor after quadratic wall loss. Default enemy damage scales; game parity unverified.',
  },
  target: {
    originLabel: 'Z feet origin',
    defaults: { p: [457.28, 1846.2, 136.025], yaw: 0, sequence: 0 },
    eyeOffsets: [64, 46],
    crouchOriginShift: 0,
    note: 'Installed Phoenix hitboxes, rifle idle + AWP additive pose. Frozen clip frame; live aim layers/IK unverified.',
  },
  damageLabel: 'estimated target HP damage',
  damageUnit: 'HP est.',
  defaultSource: [77.46, 1227.8, 156.9],
};
export function availableWorkers(
  definition: GameDefinition,
  sharedMemory = globalThis.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined',
): readonly number[] {
  return definition.id === 'cs2' && !sharedMemory ? [1] : definition.workers;
}
export function validateScan(settings: ScanSettings, definition: GameDefinition) {
  const { spacing, radius, workers } = settings;
  if (
    !Number.isInteger(spacing) ||
    spacing < definition.scan.minSpacing ||
    spacing > 128 ||
    !Number.isInteger(radius) ||
    radius < 64 ||
    radius > definition.scan.maxRadius ||
    !definition.workers.includes(workers)
  )
    throw Error(
      `Spacing ${definition.scan.minSpacing}–128, radius 64–${definition.scan.maxRadius}, workers ${definition.workers.join(', ')}.`,
    );
  const cells = (2 * Math.floor(radius / spacing) + 1) ** 2;
  if (definition.scan.maxCells && cells > definition.scan.maxCells)
    throw Error(
      `This scan requests ${cells.toLocaleString()} grid cells; the ${definition.label} limit is ${definition.scan.maxCells.toLocaleString()}. Increase spacing or reduce radius.`,
    );
  return cells;
}
