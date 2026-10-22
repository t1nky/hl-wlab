import type { SkySide } from '../engine/types.ts';

export interface GameFile {
  path: string;
  file: File;
}
export interface LibraryMapRef {
  version: 1;
  name: string;
  map: string;
  model: string;
  materials: string;
  wads: string[];
  skybox?: { name: string; faces: Record<SkySide, string> };
}
export interface LibraryCatalog {
  version: 1;
  imported: number;
  maps: LibraryMapRef[];
  bytes: number;
  files: number;
  warnings: string[];
}
export interface ImportProgress {
  type: 'progress';
  phase: string;
  done: number;
  total: number;
  bytes: number;
}
export type ImportResponse =
  | ImportProgress
  | { type: 'complete'; catalog: LibraryCatalog }
  | { type: 'error'; message: string; cancelled: boolean };
