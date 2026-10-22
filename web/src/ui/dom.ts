function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw Error(`Missing or invalid UI element: ${id}`);
  return node;
}
const elements = {
  gameFolder: element('gameFolder', HTMLButtonElement),
  gameDirectory: element('gameDirectory', HTMLInputElement),
  libraryMap: element('libraryMap', HTMLSelectElement),
  libraryLoad: element('libraryLoad', HTMLButtonElement),
  libraryCancel: element('libraryCancel', HTMLButtonElement),
  libraryStatus: element('libraryStatus', HTMLElement),
  libraryProgress: element('libraryProgress', HTMLProgressElement),
  libraryDetails: element('libraryDetails', HTMLDetailsElement),
  libraryNotices: element('libraryNotices', HTMLElement),
  assetsStatus: element('assetsStatus', HTMLElement),
  mapFile: element('mapFile', HTMLInputElement),
  modelFile: element('modelFile', HTMLInputElement),
  materialFile: element('materialFile', HTMLInputElement),
  skyFiles: element('skyFiles', HTMLInputElement),
  skyStatus: element('skyStatus', HTMLElement),
  snapshotFile: element('snapshotFile', HTMLInputElement),
  restore: element('restore', HTMLButtonElement),
  export: element('export', HTMLButtonElement),
  bookmarkName: element('bookmarkName', HTMLInputElement),
  bookmarkSave: element('bookmarkSave', HTMLButtonElement),
  bookmarkList: element('bookmarkList', HTMLSelectElement),
  bookmarkLoad: element('bookmarkLoad', HTMLButtonElement),
  bookmarkRename: element('bookmarkRename', HTMLButtonElement),
  bookmarkDelete: element('bookmarkDelete', HTMLButtonElement),
  bookmarkStatus: element('bookmarkStatus', HTMLElement),
  targetPosture: element('targetPosture', HTMLSelectElement),
  armor: element('armor', HTMLSelectElement),
  armorValue: element('armorValue', HTMLInputElement),
  tx: element('tx', HTMLInputElement),
  ty: element('ty', HTMLInputElement),
  tz: element('tz', HTMLInputElement),
  yaw: element('yaw', HTMLInputElement),
  pitch: element('pitch', HTMLInputElement),
  sequence: element('sequence', HTMLSelectElement),
  yawBlend: element('yawBlend', HTMLInputElement),
  pitchBlend: element('pitchBlend', HTMLInputElement),
  gait: element('gait', HTMLInputElement),
  expansion: element('expansion', HTMLInputElement),
  weapon: element('weapon', HTMLSelectElement),
  weaponNote: element('weaponNote', HTMLElement),
  spacing: element('spacing', HTMLInputElement),
  radius: element('radius', HTMLInputElement),
  workers: element('workers', HTMLSelectElement),
  spacings: element('spacings', HTMLElement),
  scan: element('scan', HTMLButtonElement),
  cancel: element('cancel', HTMLButtonElement),
  progress: element('progress', HTMLProgressElement),
  progressText: element('progressText', HTMLElement),
  orbit: element('orbit', HTMLButtonElement),
  walk: element('walk', HTMLButtonElement),
  fly: element('fly', HTMLButtonElement),
  focus: element('focus', HTMLButtonElement),
  overview: element('overview', HTMLButtonElement),
  cut: element('cut', HTMLInputElement),
  xray: element('xray', HTMLInputElement),
  textures: element('textures', HTMLInputElement),
  sky: element('sky', HTMLInputElement),
  viewport: element('viewport', HTMLElement),
  canvas: element('canvas', HTMLCanvasElement),
  crosshair: element('crosshair', HTMLElement),
  modeHint: element('modeHint', HTMLElement),
  filters: element('filters', HTMLElement),
  showWallbang: element('showWallbang', HTMLInputElement),
  countWallbang: element('countWallbang', HTMLElement),
  showDirect: element('showDirect', HTMLInputElement),
  countDirect: element('countDirect', HTMLElement),
  showMiss: element('showMiss', HTMLInputElement),
  countMiss: element('countMiss', HTMLElement),
  showStanding: element('showStanding', HTMLInputElement),
  countStanding: element('countStanding', HTMLElement),
  showCrouching: element('showCrouching', HTMLInputElement),
  countCrouching: element('countCrouching', HTMLElement),
  minDamage: element('minDamage', HTMLInputElement),
  minDamageValue: element('minDamageValue', HTMLElement),
  filterInfo: element('filterInfo', HTMLElement),
  filterText: element('filterText', HTMLElement),
  showWeak: element('showWeak', HTMLButtonElement),
  detail: element('detail', HTMLElement),
  detailTitle: element('detailTitle', HTMLElement),
  detailText: element('detailText', HTMLElement),
  standHere: element('standHere', HTMLButtonElement),
  error: element('error', HTMLElement),
};
export type ElementID = keyof typeof elements;
export function $<K extends ElementID>(id: K): (typeof elements)[K] {
  return elements[id];
}

export function control(id: ElementID) {
  const el = $(id);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement))
    throw Error(`Expected control: ${id}`);
  return el;
}
export function preference(id: ElementID) {
  const el = control(id);
  return el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
}
export const fmt = (n: number | undefined) => Number(n || 0).toLocaleString();
export const number = (id: ElementID) => Number(control(id).value);
