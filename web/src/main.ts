import type { Engine } from './engine/engine.ts';
import type {
  Assets,
  Brush,
  BSP,
  Pose,
  Progress,
  ScanRequest,
  ScanResponse,
  Skybox,
  Target,
} from './engine/types.ts';
import { createPointMaterial } from './render/points.ts';
import type { BookmarkState } from './storage/bookmarks.ts';
import { assetRecord, hydrateMapTextures, loadLibraryAssets } from './storage/game-library.ts';
import type { LibraryMapRef } from './storage/library-types.ts';
import { initializeBookmarks } from './ui/bookmarks.ts';
import { design } from './ui/designs.ts';
import { $, control, type ElementID, fmt, number, preference } from './ui/dom.ts';
import { errorMessage } from './ui/errors.ts';
import { initializeLibrary } from './ui/game-library.ts';
import { movementKey, navigationAction, nextVisible } from './ui/navigation.ts';
import { loadPrefs, PREFS, savePrefs } from './ui/preferences.ts';
import { scanFraction } from './ui/scan-progress.ts';
import { initializeWeapons, selectedWeapon, selectedWeaponID, selectWeapon } from './ui/weapons.ts';
import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { readBSP, transform } from './engine/bsp.ts';
import { damage, makeEngine } from './engine/engine.ts';
import { Walker } from './engine/movement.ts';
import { capturePlacement, findWalkStart, postureSequence } from './engine/placement.ts';
import { bestShot, classify, countVisible, ROW } from './engine/results.ts';
import { readStudio } from './engine/studio.ts';
import { buildMapMeshes } from './render/map.ts';
import { buildSkybox, importSkyFiles, skyName } from './render/skybox.ts';
import { get, hash, put } from './storage/cache.ts';

type Mode = 'orbit' | 'walk' | 'fly';

const canvas = $('canvas');
const HITGROUPS = [
  'generic',
  'head',
  'chest',
  'stomach',
  'left arm',
  'right arm',
  'left leg',
  'right leg',
  'shield',
];
const HINTS = {
  orbit:
    'Drag orbit · Middle/right-drag pan · Scroll zoom · Click a result to inspect · F frame target',
  walk: 'Click to look · WASD move · Space jump · Ctrl/C crouch · E place target · Esc release mouse',
  fly: 'Click to look · WASD fly · Space/Ctrl up/down · Shift fast · Esc release mouse',
};
// Display preferences persist; scan inputs do not, so a reload never starts an unexpectedly expensive scan.

// The point shaders write colors unconverted, so CSS palette values are read without sRGB-to-linear conversion.
const css = getComputedStyle(document.documentElement),
  cssValue = (name: string) => css.getPropertyValue(`--${name}`).trim(),
  cssColor = (name: string) =>
    new THREE.Color().setStyle(cssValue(name), THREE.LinearSRGBColorSpace);
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x111216);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(70, 1, 1, 40000),
  orbit = new OrbitControls(camera, canvas);
camera.position.set(-500, -1500, 1500);
orbit.target.set(1000, 250, 250);
orbit.enableDamping = false;
orbit.maxPolarAngle = Math.PI * 0.98;
orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
orbit.zoomToCursor = true;
const mapGroup = new THREE.Group(),
  targetGroup = new THREE.Group();
scene.add(mapGroup, targetGroup);
let skyTexture: THREE.CubeTexture | null = null,
  skyRevision = 0;
let bsp: BSP,
  model: ReturnType<typeof readStudio>,
  engine: Engine,
  pose: Pose,
  assetSet: Assets = {},
  modelHash = '',
  rows: Float32Array = new Float32Array(),
  hp = new Float32Array(),
  kind = new Float32Array(),
  shown = new Uint8Array(),
  shownCount = 0,
  selection: number | null = null,
  selectionLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null,
  mode: Mode = 'orbit',
  walker: Walker,
  crouchToggle = false,
  walkPaused = false,
  navigationActive = false,
  dragLook = false,
  lookYaw = 0,
  lookPitch = 0,
  frameRequested = false,
  frame = 0,
  last = performance.now(),
  acc = 0,
  keys = new Set<string>(),
  drag: { x: number; y: number } | null = null,
  worker: Worker | null = null,
  busy = false,
  focusScanAfterStop = false,
  loadingScene = true,
  revision = 0,
  scanRevision = 0,
  errorCount = 0;
const bookmarks = initializeBookmarks({ capture: captureBookmark, restore: restoreBookmark });
const library = initializeLibrary(loadImportedMap);
const cut = new THREE.Plane(new THREE.Vector3(0, 0, -1), 600);
renderer.clippingPlanes = [cut];
// kind encoding: see results.js. Hit-type, stance and damage filters are uniforms, so toggles and the damage
// slider never rebuild 100k+ point buffers.
const pointMaterial = createPointMaterial(['miss', 'direct', 'wallbang', 'weak'].map(cssColor));
const pointCloud = new THREE.Points(new THREE.BufferGeometry(), pointMaterial);
scene.add(pointCloud);
// Screen-sized markers stay findable at whole-map zoom, where hitbox wireframes shrink to a few pixels.
function marker(color: string, size: number, hole: number) {
  const m = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0], 3),
    ),
    new THREE.ShaderMaterial({
      depthTest: false,
      transparent: true,
      uniforms: { color: { value: cssColor(color) } },
      vertexShader: `void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1);gl_PointSize=${(size * renderer.getPixelRatio()).toFixed(1)};}`,
      fragmentShader: `uniform vec3 color;void main(){float r=length(gl_PointCoord*2.-1.);if(r>1.||r<${hole.toFixed(2)})discard;gl_FragColor=vec4(r>.75?vec3(0):color,1);}`,
    }),
  );
  m.visible = false;
  scene.add(m);
  return m;
}
const selectionMarker = marker('selection', 24, 0.55),
  targetMarker = marker('target', 14, 0);
selectionMarker.renderOrder = 2;
targetMarker.renderOrder = 3;
function error(e: unknown) {
  $('error').hidden = false;
  $('error').textContent = errorMessage(e);
  console.error(e);
  errorCount++;
}
function clearError() {
  $('error').hidden = true;
}
window.addEventListener('error', (e) => error(e.error || errorMessage(e)));
window.addEventListener('unhandledrejection', (e) => error(e.reason));
// Navigation only advances while the canvas owns input. Idle cameras cost no frames.
function schedule() {
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(tick);
  }
}
function ownsNavigation() {
  return navigationActive && document.activeElement === canvas && !document.hidden;
}
function navigationHint() {
  $('crosshair').hidden = mode === 'orbit' || !ownsNavigation();
  $('modeHint').textContent =
    mode === 'orbit'
      ? HINTS.orbit
      : ownsNavigation()
        ? HINTS[mode].replace('Click to look · ', dragLook ? 'Drag to look · ' : '')
        : `Click map to ${mode} · Esc pauses movement`;
  design.mode(mode, ownsNavigation(), dragLook);
}
function pauseNavigation() {
  navigationActive = false;
  keys.clear();
  drag = null;
  acc = 0;
  if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  navigationHint();
  schedule();
}
function wakeNavigation() {
  if (!frameRequested) last = performance.now();
  schedule();
}

function disposeGroup(group: THREE.Group) {
  for (const c of [...group.children]) {
    group.remove(c);
    if (!(c instanceof THREE.Mesh || c instanceof THREE.Line)) continue;
    c.geometry?.dispose();
    if (c.material) {
      const ms = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of ms) {
        (m.map || m.userData.texture)?.dispose();
        m.dispose();
      }
    }
  }
}
function renderMap() {
  disposeGroup(mapGroup);
  mapGroup.add(
    ...buildMapMeshes(bsp, {
      textures: $('textures').checked,
      anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    }),
  );
  schedule();
}
function showSky() {
  scene.background = $('sky').checked ? skyTexture : null;
  $('sky').disabled = !skyTexture;
  schedule();
}
function setSky(data: Skybox | null) {
  const texture = data ? buildSkybox(data) : null;
  skyTexture?.dispose();
  skyTexture = texture;
  showSky();
}
async function loadSkyForMap(map: BSP, assets: Assets) {
  const revision = ++skyRevision;
  setSky(null);
  let name: string;
  try {
    name = skyName(map);
    $('skyStatus').textContent = `Loading ${name} sky…`;
    const saved =
        assets.skybox?.name === name
          ? assets.skybox
          : await get<Skybox>('assets', `sky/${name}`).catch(() => null),
      data = saved || null;
    if (revision !== skyRevision) return;
    setSky(data);
    assetSet.skybox = data;
    $('skyStatus').textContent = data
      ? `Sky: ${name}`
      : `${name} sky not loaded · import its six TGAs.`;
    if (data && !assets.library)
      try {
        await put('assets', `sky/${name}`, data);
      } catch {
        if (revision === skyRevision)
          $('skyStatus').textContent = `Sky: ${name} · cache unavailable`;
      }
  } catch (e) {
    if (revision === skyRevision)
      $('skyStatus').textContent = `Sky unavailable: ${errorMessage(e)}`;
  }
}
function targetSettings() {
  const p = (['tx', 'ty', 'tz'] as const).map(number),
    yaw = number('yaw'),
    pitch = number('pitch'),
    seq = number('sequence'),
    options = {
      yawBlend: number('yawBlend'),
      pitchBlend: number('pitchBlend'),
      gait: number('gait'),
    };
  if (![...p, yaw, pitch, ...Object.values(options)].every(Number.isFinite))
    throw Error('Target values must be finite numbers');
  if (
    !Number.isInteger(options.gait) ||
    options.gait < 0 ||
    options.gait >= model.sequences.length ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    seq >= model.sequences.length ||
    !Number.isFinite(number('expansion')) ||
    number('expansion') < 0 ||
    number('expansion') > 4
  )
    throw Error('Invalid animation, gait, or client trace expansion');
  if (
    options.yawBlend < 0 ||
    options.yawBlend > 255 ||
    options.pitchBlend < 0 ||
    options.pitchBlend > 255
  )
    throw Error('Pose blends must be between 0 and 255');
  return { p: p.map(Math.fround), yaw, pitch, seq, options };
}
function updateTarget(invalidate = true) {
  if (!model || !engine) return;
  try {
    const t = targetSettings();
    $('targetPosture').value = String(model.sequences[t.seq].name.startsWith('crouch') ? '1' : '0');
    pose = model.pose(t.seq, t.p, t.yaw, -t.pitch / 3, true, t.options);
    engine.target(pose, number('expansion'));
    disposeGroup(targetGroup);
    const lines = [];
    for (const box of pose.boxes) {
      if (box.group === 8) continue;
      const corners = Array.from({ length: 8 }, (_, i) =>
        transform(box.matrix, [
          i & 1 ? box.maxs[0] : box.mins[0],
          i & 2 ? box.maxs[1] : box.mins[1],
          i & 4 ? box.maxs[2] : box.mins[2],
        ]),
      );
      for (let i = 0; i < 8; i++)
        for (const j of [1, 2, 4]) if (!(i & j)) lines.push(...corners[i], ...corners[i | j]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    targetGroup.add(
      new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: cssValue('target'), depthTest: false }),
      ),
    );
    targetMarker.position.fromArray(pose.aims[0]);
    targetMarker.visible = true;
    if (invalidate) {
      invalidateScan('Target changed. Scan to update.');
    }
    schedule();
    return true;
  } catch (e) {
    error(e);
    return false;
  }
}
const shotAt = (row: Float32Array) =>
  bestShot(row, number('armor'), number('armorValue'), selectedWeapon().armorRatio);
// Rows are classified once per scan or armor change; filters afterwards only touch uniforms and typed arrays.
function updatePoints(preserveSelection = false) {
  const previous = preserveSelection ? selection : null;
  clearSelection();
  design.results(rows.length / ROW);
  const c = classify(rows, number('armor'), number('armorValue'), selectedWeapon().armorRatio),
    g = new THREE.BufferGeometry();
  hp = c.hp;
  kind = c.kind;
  shown = new Uint8Array(kind.length);
  g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
  g.setAttribute('hp', new THREE.BufferAttribute(hp, 1));
  g.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
  pointCloud.geometry.dispose();
  pointCloud.geometry = g;
  filterPoints();
  if (previous !== null && shown[previous]) selectPoint(previous);
}
function filterPoints() {
  const types = (['showMiss', 'showDirect', 'showWallbang', 'showWeak'] as const).map(
      (id) => $(id).checked,
    ),
    stances = (['showStanding', 'showCrouching'] as const).map((id) => $(id).checked),
    minDamage = number('minDamage'),
    { typeCounts, stanceCounts, visible } = countVisible(
      hp,
      kind,
      { types, stances, minDamage },
      shown,
    ),
    u = pointMaterial.uniforms;
  shownCount = visible;
  u.show.value.set(...types.map(Number));
  u.stances.value.set(...stances.map(Number));
  u.minDamage.value = minDamage;
  (['countMiss', 'countDirect', 'countWallbang', 'countWeak'] as const).forEach((id, i) => {
    $(id).textContent = fmt(typeCounts[i]);
  });
  (['countStanding', 'countCrouching'] as const).forEach((id, i) => {
    $(id).textContent = fmt(stanceCounts[i]);
  });
  $('minDamageValue').textContent = `${minDamage} HP`;
  updateFilterStatus();
  design.filtered(visible, kind.length);
  if (selection !== null && !shown[selection]) clearSelection();
  schedule();
}
function updateFilterStatus() {
  const clipped = cut.constant < Number($('cut').max);
  $('filterText').textContent = kind.length
    ? `${fmt(shownCount)} of ${fmt(kind.length)} positions ${clipped ? 'match filters · cutaway on' : 'shown'}`
    : '';
}
function syncArmor() {
  $('armorValue').disabled = $('armor').value === '0';
}
function focus() {
  if (!pose) return;
  setMode('orbit');
  const offset = camera.position.clone().sub(orbit.target);
  if (offset.lengthSq() < 1) offset.set(-1250, -1300, 1450);
  offset.setLength(Math.max(400, Math.min(2400, offset.length())));
  orbit.target.fromArray(pose.aims[0]);
  camera.position.copy(orbit.target).add(offset);
  orbit.update();
  schedule();
}
async function loadAssets(next: Assets, remember = true) {
  clearError();
  if (busy) throw Error('Cancel the active scan before replacing map assets');
  if (next.library && !next.map) {
    next = {
      ...(await loadLibraryAssets(next.library)),
      snapshot: next.snapshot,
      ...(next.skyOverride ? { skybox: next.skyOverride, skyOverride: next.skyOverride } : {}),
    };
  }
  const merged = {
      ...assetSet,
      ...next,
      library:
        next.library ||
        (next.map || next.model || next.materials !== undefined ? undefined : assetSet.library),
      skyOverride: next.skyOverride || (next.map ? undefined : assetSet.skyOverride),
    },
    needed = [
      ['map', 'BSP'],
      ['model', 'player MDL'],
      ['materials', 'materials.txt'],
    ]
      .filter(([key]) => !merged[key as keyof Assets])
      .map(([, name]) => name);
  if (needed.length) {
    assetSet = merged;
    $('assetsStatus').textContent = `Still needed: ${needed.join(', ')}.`;
    return;
  }
  if (!merged.map || !merged.model || merged.materials === undefined) return;
  if (merged.model.byteLength > 16 * 1024 * 1024) throw Error('Player MDL is too large');
  const parsed = readBSP(merged.map);
  if (merged.library) await hydrateMapTextures(parsed, merged.library);
  const mdl = readStudio(merged.model),
    eng = await makeEngine(merged.map, parsed, merged.materials);
  setMode('orbit');
  bsp = parsed;
  model = mdl;
  engine = eng;
  engine.setWeapon(selectedWeapon());
  assetSet = merged;
  modelHash = await hash(merged.model);
  $('sequence').replaceChildren(
    ...mdl.sequences.map((s) => {
      const o = document.createElement('option');
      o.value = String(s.index);
      o.textContent = `${s.index} · ${s.name}`;
      return o;
    }),
  );
  $('sequence').value = String('1');
  if (merged.library && !merged.snapshot) {
    const spawn = findWalkStart(eng, parsed);
    (['tx', 'ty', 'tz'] as const).forEach((id, i) => {
      $(id).value = String(spawn.p[i]);
    });
    $('yaw').value = String(spawn.yaw);
    $('pitch').value = '0';
    $('yawBlend').value = '128';
    $('pitchBlend').value = '127';
    $('gait').value = '1';
    $('sequence').value = String(postureSequence(mdl.sequences, false)?.index ?? 1);
  }
  revision++;
  rows = new Float32Array();
  if (merged.snapshot) applySnapshot(merged.snapshot);
  else renderMap();
  $('cut').min = String(Math.floor(bsp.world.mins[2]) - 1);
  $('cut').max = String(Math.ceil(bsp.world.maxs[2]) + 1);
  applyCut(Number($('cut').max));
  updateTarget(false);
  updatePoints();
  focus();
  $('scan').disabled = loadingScene;
  const missing = bsp.textures.filter((t) => !t.rgba).length;
  $('assetsStatus').textContent =
    `${merged.mapName || 'Map'} ready` +
    (missing ? ` · ${missing} of ${bsp.textures.length} textures missing` : '');
  $('progressText').textContent = 'Ready to scan.';
  await loadSkyForMap(parsed, merged);
  if (remember) {
    try {
      await put('assets', 'last', assetRecord(merged));
    } catch (e) {
      error(Error(`Loaded, but asset caching failed: ${errorMessage(e)}`));
    }
  }
  window.labReady = true;
  design.map(merged.mapName || 'Map');
  bookmarks.setReady(!loadingScene);
}
async function loadImportedMap(ref: LibraryMapRef) {
  if (busy || loadingScene) throw Error('Cancel the scan before loading a map');
  loadingScene = true;
  lockScan(false);
  bookmarks.setReady(false);
  setMode('orbit');
  try {
    await loadAssets({ library: ref });
    setMode('walk');
  } finally {
    loadingScene = false;
    lockScan(false);
    bookmarks.setReady(!!engine);
  }
}
function captureBookmark() {
  if (!engine || !bsp || !model || loadingScene) throw Error('Load a map first');
  const target = targetSettings();
  const armor = number('armor'),
    armorValue = number('armorValue');
  if (
    ![0, 1, 2].includes(armor) ||
    !Number.isFinite(armorValue) ||
    armorValue < 0 ||
    armorValue > 100
  )
    throw Error('Set armor points between 0 and 100 before saving');
  const spacing = number('spacing'),
    radius = number('radius');
  if (
    !Number.isInteger(spacing) ||
    spacing < 3 ||
    spacing > 128 ||
    !Number.isInteger(radius) ||
    radius < 64 ||
    radius > selectedWeapon().maxDistance
  )
    throw Error('Set valid spacing and radius before saving');
  const state: BookmarkState = {
    target,
    brushes: bsp.brushes.map(({ origin, angles, solid }) => ({ origin, angles, solid })),
    armor,
    armorValue,
    weapon: selectedWeaponID(),
    expansion: number('expansion'),
    spacing,
    radius,
    point:
      selection === null
        ? null
        : [rows[selection * ROW], ...rows.subarray(selection * ROW + 2, selection * ROW + 5)],
    view: {
      mode,
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      orbitTarget: orbit.target.toArray(),
      yaw: lookYaw,
      pitch: lookPitch,
      walker:
        mode === 'walk' && walker
          ? { p: walker.p, duck: walker.duck, ground: walker.ground }
          : null,
      cut: number('cut'),
    },
    display: Object.fromEntries(PREFS.map((id) => [id, preference(id)])),
  };
  return { assets: assetSet, state };
}
async function restoreBookmark(assets: Assets, state: BookmarkState) {
  if (busy || loadingScene) throw Error('Cancel the scan before loading a bookmark');
  loadingScene = true;
  lockScan(false);
  bookmarks.setReady(false);
  setMode('orbit');
  try {
    $('expansion').value = String(state.expansion);
    for (const id of PREFS) {
      const value = state.display[id];
      if (value === undefined) continue;
      const el = control(id);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
      else el.value = String(value);
    }
    pointMaterial.depthTest = !$('xray').checked;
    await loadAssets({ ...assets, snapshot: JSON.stringify(state) });
    $('spacing').value = String(state.spacing);
    $('radius').value = String(state.radius);
    if (!updateTarget()) throw Error('Bookmark target could not be restored');
    const view = state.view;
    if (view.walker) {
      walker = new Walker(engine, view.walker.p);
      walker.duck = view.walker.duck;
      walker.ground = view.walker.ground;
    }
    setMode(view.mode);
    lookYaw = view.yaw;
    lookPitch = view.pitch;
    camera.position.fromArray(view.position);
    camera.quaternion.fromArray(view.quaternion);
    orbit.target.fromArray(view.orbitTarget);
    $('cut').value = String(view.cut);
    applyCut(view.cut);
    acc = 0;
    keys.clear();
    // Keep the restored point stationary until the user resumes exploring.
    walkPaused = view.mode === 'walk';
    if (state.point?.length === 4) {
      const [stance, x, y, z] = state.point;
      const fit = engine.trace([x, y, z], [x, y, z], stance ? 3 : 1);
      if (!fit[7] && !fit[8]) {
        const eye = [x, y, z + (stance ? 12 : 17)];
        // Retain coordinates, not old damage: a future engine update must not
        // resurrect stale ballistics from a saved bookmark.
        rows = new Float32Array([
          stance,
          1,
          x,
          y,
          z,
          eye[2],
          ...pose.aims.flatMap((aim) => engine.fire(eye, aim)),
        ]);
        updatePoints();
        selectPoint(0);
      }
    }
    $('progress').value = 0;
    $('progressText').textContent = 'Bookmark loaded. Scan when ready.';
    schedule();
  } finally {
    loadingScene = false;
    lockScan(false);
    bookmarks.setReady(!!engine);
  }
}
function applySnapshot(text: string) {
  if (!bsp) return;
  if (text.trim().startsWith('{')) {
    const data = JSON.parse(text) as {
      target?: Target;
      brushes?: Brush[];
      armor?: number;
      armorValue?: number;
      weapon?: string;
    };
    if (data.weapon !== undefined) {
      selectWeapon(data.weapon);
      engine.setWeapon(selectedWeapon());
    }
    if (data.target) {
      const t = data.target;
      (['tx', 'ty', 'tz'] as const).forEach((id, i) => {
        $(id).value = String(t.p[i]);
      });
      $('yaw').value = String(t.yaw);
      $('pitch').value = String(t.pitch);
      $('sequence').value = String(t.seq);
      for (const [k, v] of Object.entries(t.options || {}))
        control(k as ElementID).value = String(v);
    }
    if (data.brushes) {
      if (data.brushes.length !== bsp.brushes.length)
        throw Error('Scene does not match map brush count');
      for (let i = 0; i < data.brushes.length; i++) Object.assign(bsp.brushes[i], data.brushes[i]);
    }
    if (data.armor !== undefined) $('armor').value = String(data.armor);
    if (data.armorValue !== undefined) $('armorValue').value = String(data.armorValue);
    syncArmor();
  } else {
    for (const line of text.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f[0] === 'TARGET') {
        (['tx', 'ty', 'tz', 'yaw'] as const).forEach((id, i) => {
          $(id).value = String(f[i + 1]);
        });
      }
      if (f[0] === 'BRUSH') {
        const b = bsp.brushes[Number(f[1])];
        if (b) {
          b.origin = f.slice(2, 5).map(Number);
          b.angles = f.slice(5, 8).map(Number);
          b.solid = Number(f[8]) === 4;
        }
      }
    } /* Snapshot omits private CS pose blends: retain an explicit editor pose. */
  }
  engine.syncBrushes();
  renderMap();
}
function setMode(next: Mode, fromSelection = false) {
  if (next !== 'orbit' && !engine) return;
  if (next === mode && !fromSelection) return;
  const previous = mode;
  pauseNavigation();
  dragLook = false;
  walkPaused = fromSelection;
  if (next === 'walk') {
    try {
      if (fromSelection && selection !== null) {
        const r = rows.subarray(selection * ROW, (selection + 1) * ROW);
        walker = new Walker(engine, Array.from(r.slice(2, 5)));
        walker.duck = !!r[0];
        walker.ground = true;
        const aim = pose.aims[shotAt(r).anchor],
          eye = walker.eye,
          d = aim.map((x, i) => x - eye[i]);
        lookYaw = Math.atan2(d[1], d[0]);
        lookPitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
      } else if (!walker || walker.engine !== engine) {
        const spawn = findWalkStart(engine, bsp, [
          { p: targetSettings().p, yaw: targetSettings().yaw },
        ]);
        walker = new Walker(engine, spawn.p);
        walker.ground = true; // findWalkStart already traced this walkable floor.
        lookYaw = (spawn.yaw * Math.PI) / 180;
        lookPitch = 0;
      }
      const fit = walker.trace(walker.p, walker.p);
      if (fit[7] || fit[8])
        throw Error('The player hull does not fit here. Select another firing position.');
      camera.position.fromArray(walker.eye);
      crouchToggle = walker.duck;
      acc = 0;
    } catch (e) {
      error(e);
      return;
    }
  } else if (next === 'fly') {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    lookYaw = Math.atan2(dir.y, dir.x);
    lookPitch = Math.asin(dir.z);
  } else if (next === 'orbit' && previous !== 'orbit') {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    orbit.target.copy(camera.position).addScaledVector(dir, 250);
  }
  mode = next;
  if (next !== 'orbit') look();
  orbit.enabled = next === 'orbit';
  for (const id of ['orbit', 'walk', 'fly'] as const) {
    $(id).classList.toggle('active', id === next);
    $(id).setAttribute('aria-pressed', String(id === next));
  }
  navigationHint();
  schedule();
}
function look() {
  const d = new THREE.Vector3(
    Math.cos(lookYaw) * Math.cos(lookPitch),
    Math.sin(lookYaw) * Math.cos(lookPitch),
    Math.sin(lookPitch),
  );
  camera.lookAt(camera.position.clone().add(d));
}
function clearSelection() {
  design.selected(false);
  selection = null;
  selectionMarker.visible = false;
  if (selectionLine) {
    scene.remove(selectionLine);
    selectionLine.geometry.dispose();
    selectionLine.material.dispose();
    selectionLine = null;
  }
  $('detailTitle').textContent = '';
  $('detailText').textContent = 'Click a point to see its damage and aim.';
  $('standHere').hidden = true;
  schedule();
}
function selectPoint(i: number) {
  const r = rows.subarray(i * ROW, (i + 1) * ROW),
    best = shotAt(r),
    eye = [r[2], r[3], r[5]],
    aim = pose.aims[best.anchor];
  clearSelection();
  selection = i;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...eye, ...aim], 3));
  selectionLine = new THREE.Line(
    g,
    new THREE.LineBasicMaterial({ color: cssValue('selection'), depthTest: false }),
  );
  scene.add(selectionLine);
  selectionMarker.position.fromArray(pointCloud.geometry.attributes.position.array, i * 3);
  selectionMarker.visible = true;
  const delta = aim.map((x, k) => x - eye[k]),
    yaw = (Math.atan2(delta[1], delta[0]) * 180) / Math.PI,
    pitch = (-Math.atan2(delta[2], Math.hypot(delta[0], delta[1])) * 180) / Math.PI;
  $('detailTitle').textContent = best.hp
    ? `${best.walls ? 'Wallbang' : 'Direct'} · ${best.hp} HP${selectedWeapon().pellets > 1 ? '/pellet' : ''} · ${HITGROUPS[best.group] ?? `hitgroup ${best.group}`}`
    : 'No hit';
  $('detailText').textContent =
    `${r[0] ? 'Crouching' : 'Standing'} shooter · ${best.walls} wall${best.walls === 1 ? '' : 's'} · aim yaw ${yaw.toFixed(2)}° pitch ${pitch.toFixed(2)}° · origin ${[r[2], r[3], r[4]].map((x) => x.toFixed(1)).join(' ')}`;
  $('standHere').hidden = false;
  design.selected(true);
}
function projectClick(e: PointerEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const rect = canvas.getBoundingClientRect(),
    mx = e.clientX - rect.left,
    my = e.clientY - rect.top;
  let best = -1,
    min = 12;
  const v = new THREE.Vector3(),
    p = pointCloud.geometry.attributes.position.array;
  for (let i = 0; i < shown.length; i++) {
    if (!shown[i] || p[i * 3 + 2] > cut.constant) continue;
    v.fromArray(p, i * 3).project(camera);
    if (v.z < -1 || v.z > 1) continue;
    const dist = Math.hypot(((v.x + 1) * rect.width) / 2 - mx, ((1 - v.y) * rect.height) / 2 - my);
    if (dist < min) {
      min = dist;
      best = i;
    }
  }
  if (best >= 0) selectPoint(best);
}
// Percentages and ETA need the final grid size, even though tracing starts earlier.
function progress(m: Omit<Progress, 'type'>, summary?: string) {
  const seconds = m.seconds || 0,
    rate = m.done / Math.max(0.001, seconds),
    eta =
      m.totalKnown && m.computed && m.total > m.done ? (m.total - m.done) / Math.max(1, rate) : 0,
    fraction = scanFraction(m);
  $('progress').max = 1;
  if (fraction === null) $('progress').removeAttribute('value');
  else $('progress').value = fraction;
  $('progressText').textContent =
    summary ||
    `${m.phase}${m.total ? ` · ${fmt(m.done)}/${fmt(m.total)}` : ''}${eta ? ` · ~${eta.toFixed(1)} s left` : ''}`;
  $('progressText').title =
    `${fmt(m.reused)} cached · ${fmt(m.placementReused)} placements reused · ${fmt(m.computed)} new · ${seconds.toFixed(2)} s`;
  design.progress(m.phase, fraction, seconds, eta);
  window.labProgress = m;
}
function lockScan(active: boolean) {
  const returnFocus =
    !active &&
    (document.activeElement === $('cancel') ||
      (focusScanAfterStop && document.activeElement === document.body));
  design.scanning(active);
  busy = active;
  $('scan').disabled = active || loadingScene || !engine;
  $('cancel').disabled = !active;
  $('cancel').textContent = 'Stop';
  if (!active) focusScanAfterStop = false;
  if (returnFocus && !$('scan').disabled) $('scan').focus({ preventScroll: true });
  bookmarks.setScanning(active || loadingScene);
  library.setBusy(active || loadingScene);
  for (const id of ['restore', 'mapFile', 'modelFile', 'materialFile', 'snapshotFile'] as const)
    $(id).disabled = active || loadingScene;
}
function invalidateScan(message: string) {
  revision++;
  if (busy) stopScan();
  rows = new Float32Array();
  updatePoints();
  $('progressText').textContent = message;
  $('progress').value = 0;
}
function stopScan() {
  if (!busy) return;
  focusScanAfterStop = document.activeElement === $('cancel');
  worker?.postMessage({ type: 'cancel' });
  $('cancel').disabled = true;
  $('cancel').textContent = 'Stopping…';
}
function scan() {
  clearError();
  if (!engine || !pose || busy || loadingScene || !assetSet.map || assetSet.materials === undefined)
    return;
  pauseNavigation();
  if (!updateTarget(false)) return;
  const spacing = number('spacing'),
    radius = number('radius'),
    workers = number('workers');
  for (const id of ['spacing', 'radius', 'armorValue'] as const) {
    if (!$(id).disabled && !$(id).checkValidity()) {
      design.reveal($(id));
      $(id).reportValidity();
      return;
    }
  }
  if (
    !Number.isInteger(spacing) ||
    spacing < 3 ||
    spacing > 128 ||
    !Number.isInteger(radius) ||
    radius < 64 ||
    radius > selectedWeapon().maxDistance ||
    ![1, 2, 4].includes(workers)
  ) {
    error(
      Error(
        `Spacing must be 3–128; radius 64–${selectedWeapon().maxDistance}; workers 1, 2, or 4.`,
      ),
    );
    return;
  }
  scanRevision = revision;
  lockScan(true);
  worker = new Worker(new URL('./workers/scan.worker.ts', import.meta.url), { type: 'module' });
  worker.onerror = (e) => {
    lockScan(false);
    error(Error(errorMessage(e)));
    worker?.terminate();
  };
  worker.onmessage = ({ data: m }: MessageEvent<ScanResponse>) => {
    if (m.type === 'progress') {
      if (scanRevision === revision) progress(m);
    } else if (m.type === 'error') {
      lockScan(false);
      error(Error(m.message));
      worker?.terminate();
    } else if (m.type === 'complete') {
      lockScan(false);
      worker?.terminate();
      if (scanRevision !== revision) {
        return;
      }
      rows = m.rows;
      pointMaterial.uniforms.size.value = spacing * 0.8;
      updatePoints();
      progress(
        { ...m, phase: m.cancelled ? 'Cancelled' : 'Complete' },
        m.cancelled
          ? `Cancelled at ${fmt(m.done)}/${fmt(m.total)} · finished work cached`
          : `Done in ${(m.seconds ?? 0).toFixed(1)} s · ${fmt(m.computed)} new, ${fmt(m.reused)} cached`,
      );
      window.labLastScan = { ...m, rows: undefined };
    }
  };
  worker.postMessage({
    type: 'scan',
    map: assetSet.map,
    brushes: bsp.brushes,
    materials: assetSet.materials,
    modelHash,
    pose,
    expansion: number('expansion'),
    target: targetSettings().p,
    spacing,
    radius,
    workers,
    weapon: selectedWeaponID(),
  } satisfies ScanRequest);
}
for (const id of [
  'tx',
  'ty',
  'tz',
  'yaw',
  'sequence',
  'yawBlend',
  'pitchBlend',
  'gait',
  'expansion',
] as const)
  $(id).addEventListener('change', () => updateTarget());
$('armor').addEventListener('change', syncArmor);
$('weapon').onchange = () => {
  clearError();
  try {
    selectWeapon($('weapon').value);
    if (engine) engine.setWeapon(selectedWeapon());
    invalidateScan('Weapon changed. Scan to update.');
  } catch (e) {
    error(e);
  }
};
for (const id of ['spacing', 'radius'] as const) {
  $(id).required = true;
  $(id).addEventListener('change', () => invalidateScan('Scan settings changed. Scan to update.'));
}
$('armorValue').required = true;
for (const id of ['armor', 'armorValue'] as const)
  $(id).addEventListener('change', () => {
    if (!$('armorValue').disabled && !$('armorValue').reportValidity()) return;
    updatePoints(true);
  });
for (const id of [
  'showWallbang',
  'showDirect',
  'showMiss',
  'showWeak',
  'showStanding',
  'showCrouching',
  'minDamage',
] as const)
  $(id).addEventListener('input', filterPoints);
for (const id of PREFS) $(id).addEventListener('change', savePrefs);
function resetFilters() {
  for (const id of ['showWallbang', 'showDirect', 'showStanding'] as const) $(id).checked = true;
  for (const id of ['showMiss', 'showWeak', 'showCrouching'] as const) $(id).checked = false;
  $('minDamage').value = '1';
  filterPoints();
  savePrefs();
}
$('standHere').onclick = () => setMode('walk', true);
$('restore').onclick = async () => {
  try {
    const a = await get<Assets>('assets', 'last');
    if (!a) throw Error('No map assets have been cached yet');
    await loadAssets(a, false);
  } catch (e) {
    error(e);
  }
};
for (const [id, key] of [
  ['mapFile', 'map'],
  ['modelFile', 'model'],
  ['materialFile', 'materials'],
] as const)
  $(id).onchange = async (e) => {
    try {
      const f = (e.currentTarget as HTMLInputElement).files?.[0];
      if (!f) return;
      if (f.size > (key === 'map' ? 32 : 16) * 1048576) throw Error('File exceeds import limit');
      const value = key === 'materials' ? await f.text() : await f.arrayBuffer();
      await loadAssets({
        [key]: value,
        ...(key === 'map' ? { mapName: f.name, snapshot: undefined } : {}),
      });
    } catch (e) {
      error(e);
    }
  };
$('skyFiles').onchange = async (e) => {
  try {
    if (!(e.currentTarget as HTMLInputElement).files?.length) return;
    if (!bsp) throw Error('Load a BSP map first');
    const map = bsp,
      name = skyName(map),
      data = await importSkyFiles(
        Array.from((e.currentTarget as HTMLInputElement).files ?? []),
        name,
      );
    if (map !== bsp) return;
    const texture = buildSkybox(data);
    skyRevision++;
    skyTexture?.dispose();
    skyTexture = texture;
    assetSet.skybox = data;
    assetSet.skyOverride = data;
    showSky();
    $('skyStatus').textContent = `Sky: ${name}`;
    await put('assets', `sky/${name}`, data);
    await put('assets', 'last', assetRecord(assetSet));
  } catch (e) {
    error(e);
  } finally {
    (e.target as HTMLInputElement).value = '';
  }
};
$('sky').onchange = showSky;
$('snapshotFile').onchange = async (e) => {
  try {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 2 * 1048576) throw Error('Scene file exceeds 2 MiB');
    const text = await file.text();
    applySnapshot(text);
    assetSet.snapshot = text;
    updateTarget();
  } catch (e) {
    error(e);
  }
};
$('pitch').addEventListener('change', () => {
  const angle = Math.max(-45, Math.min(45, Math.trunc(-number('pitch'))));
  $('pitchBlend').value = String(Math.trunc(((45 - angle) * 255) / 90));
  updateTarget();
});
$('focus').onclick = focus;
$('scan').onclick = scan;
$('cancel').onclick = stopScan;
function applyCut(value: number) {
  $('cut').value = String(value);
  cut.constant = number('cut');
  design.cut(cut.constant, Number($('cut').max));
  updateFilterStatus();
  if (
    selection !== null &&
    pointCloud.geometry.getAttribute('position').getZ(selection) > cut.constant
  )
    clearSelection();
  schedule();
}
$('cut').oninput = () => applyCut(number('cut'));
$('xray').onchange = () => {
  pointMaterial.depthTest = !$('xray').checked;
  schedule();
};
$('textures').onchange = () => {
  for (const c of mapGroup.children) {
    if (!(c instanceof THREE.Mesh)) continue;
    const material = c.material as THREE.MeshBasicMaterial;
    material.map = $('textures').checked ? material.userData.texture : null;
    material.needsUpdate = true;
  }
  schedule();
};
for (const id of ['orbit', 'walk', 'fly'] as const) $(id).onclick = () => setMode(id);
$('overview').onclick = () => {
  if (!bsp) return;
  setMode('orbit');
  const lo = bsp.world.mins,
    hi = bsp.world.maxs,
    center = lo.map((x, i) => (x + hi[i]) / 2),
    size = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  orbit.target.fromArray(center);
  camera.position.set(center[0] - size * 0.4, center[1] - size * 0.5, center[2] + size * 0.9);
  orbit.update();
  applyCut(Number($('cut').max));
  schedule();
};
function placeTarget() {
  if (!engine || !model) return;
  if (mode !== 'walk') {
    setMode('walk');
    return;
  }
  try {
    const placed = capturePlacement(walker, lookYaw, lookPitch, model.sequences);
    (['tx', 'ty', 'tz'] as const).forEach((id, i) => {
      $(id).value = String(placed.p[i]);
    });
    $('yaw').value = String(placed.yaw);
    $('pitch').value = String(placed.pitch);
    $('targetPosture').value = String(placed.duck ? '1' : '0');
    $('sequence').value = String(placed.seq);
    for (const [key, value] of Object.entries(placed.options))
      control(key as ElementID).value = String(value);
    if (updateTarget()) clearError();
  } catch (e) {
    error(e);
  }
}
$('targetPosture').onchange = () => {
  if (!model) return;
  const previous = model.sequences[number('sequence')]?.name.startsWith('crouch'),
    duck = $('targetPosture').value === '1',
    sequence = postureSequence(model.sequences, duck);
  if (!sequence) {
    error(Error('Matching posture is not available in this model'));
    return;
  }
  if (previous !== duck) $('tz').value = String(number('tz') + (duck ? -18 : 18));
  $('sequence').value = String(sequence.index);
  $('gait').value = String(duck ? 2 : 1);
  updateTarget();
};
$('export').onclick = () => {
  if (!bsp || !assetSet.map) return;
  const map = assetSet.map;
  const data = {
    version: 1,
    mapHash: null as string | null,
    map: assetSet.mapName,
    target: targetSettings(),
    armor: number('armor'),
    armorValue: number('armorValue'),
    weapon: $('weapon').value,
    brushes: bsp.brushes,
    accuracy: 'Experimental static scene; no shot or movement parity certification',
  };
  hash(map).then((h) => {
    data.mapHash = h;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'wallbang-scene.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
};
orbit.addEventListener('change', schedule);
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'orbit' && e.button !== 0) return;
  canvas.focus({ preventScroll: true });
  drag = { x: e.clientX, y: e.clientY };
  if (mode !== 'orbit') {
    navigationActive = true;
    acc = 0;
    last = performance.now();
    navigationHint();
    wakeNavigation();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* Pointer capture is optional; pointer lock or drag-look still works. */
    }
    if (dragLook || document.pointerLockElement === canvas) return;
    try {
      if (canvas.requestPointerLock) canvas.requestPointerLock()?.catch?.(fallbackLook);
      else fallbackLook();
    } catch {
      fallbackLook();
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (
    mode === 'orbit' ||
    !ownsNavigation() ||
    document.pointerLockElement === canvas ||
    !drag ||
    !(e.buttons & 1)
  )
    return;
  lookYaw -= (e.clientX - drag.x) * 0.002;
  lookPitch = Math.max(-1.5, Math.min(1.5, lookPitch - (e.clientY - drag.y) * 0.002));
  drag.x = e.clientX;
  drag.y = e.clientY;
  look();
  schedule();
});
canvas.addEventListener('pointerup', (e) => {
  if (
    e.button === 0 &&
    mode === 'orbit' &&
    drag &&
    Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5
  )
    projectClick(e);
  drag = null;
});
document.addEventListener('mousemove', (e) => {
  if (mode === 'orbit' || !ownsNavigation() || document.pointerLockElement !== canvas) return;
  lookYaw -= e.movementX * 0.002;
  lookPitch = Math.max(-1.5, Math.min(1.5, lookPitch - e.movementY * 0.002));
  look();
  schedule();
});
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (e.code === 'Escape') {
    if (navigationActive || document.pointerLockElement === canvas) {
      e.preventDefault();
      pauseNavigation();
    } else if (
      mode === 'orbit' &&
      selection !== null &&
      !/INPUT|SELECT|TEXTAREA/.test((e.target as HTMLElement).tagName) &&
      !(e.target as HTMLElement).isContentEditable
    ) {
      e.preventDefault();
      clearSelection();
    }
    return;
  }
  if (e.code === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault();
    if (!e.repeat && !$('scan').disabled) {
      const field = document.activeElement;
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.blur();
      scan();
    }
    return;
  }
  const action = navigationAction(e.code, {
    mode,
    active: ownsNavigation(),
    focused: document.activeElement === canvas,
    altKey: e.altKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    repeat: e.repeat,
  });
  if (!action) return;
  e.preventDefault();
  if (action === 'next' || action === 'previous') {
    const positions = pointCloud.geometry.getAttribute('position');
    const index = nextVisible(
      shown,
      selection,
      action === 'next' ? 1 : -1,
      (i) => positions.getZ(i) <= cut.constant,
    );
    if (index !== null) selectPoint(index);
    return;
  }
  if (action === 'target') return focus();
  if (action === 'map') return $('overview').click();
  if (action === 'place') return placeTarget();
  walkPaused = false;
  if (action === 'crouch') crouchToggle = !walker.duck;
  else keys.add(movementKey(e.code));
  wakeNavigation();
});
document.addEventListener('keyup', (e) => {
  const key = movementKey(e.code);
  if ((key === 'ControlLeft' && e.ctrlKey) || (key === 'ShiftLeft' && e.shiftKey)) return;
  if (keys.delete(key) && ownsNavigation()) wakeNavigation();
});
function fallbackLook() {
  if (mode === 'orbit' || !ownsNavigation()) return;
  dragLook = true;
  navigationHint();
}
canvas.addEventListener('blur', () => {
  if (navigationActive) pauseNavigation();
});
canvas.addEventListener('pointercancel', () => {
  if (navigationActive) pauseNavigation();
  else drag = null;
});
window.addEventListener('pointerup', () => {
  drag = null;
});
window.addEventListener('blur', pauseNavigation);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseNavigation();
});
document.addEventListener('pointerlockerror', fallbackLook);
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas && mode !== 'orbit' && ownsNavigation()) {
    navigationHint();
    wakeNavigation();
    return;
  }
  pauseNavigation();
});
new ResizeObserver(() => {
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    ratio = renderer.getPixelRatio();
  if (w && h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pointMaterial.uniforms.scale.value = (h * ratio) / 2;
    pointMaterial.uniforms.sizeRange.value.set(3 * ratio, 16 * ratio);
    schedule();
  }
}).observe($('viewport'));
function tick(now: number) {
  frameRequested = false;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mode !== 'orbit' && engine && ownsNavigation()) {
    let moving = false;
    if (mode === 'walk') {
      acc = walkPaused ? 0 : Math.min(0.1, acc + dt);
      while (acc >= 0.01) {
        walker.step(
          0.01,
          {
            forward: (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
            side: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
            jump: keys.has('Space'),
            duck: keys.has('ControlLeft') || crouchToggle,
          },
          lookYaw,
        );
        acc -= 0.01;
      }
      camera.position.fromArray(walker.eye);
      moving =
        !walkPaused &&
        (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].some((key) => keys.has(key)) ||
          !walker.ground ||
          walker.v.some((v) => Math.abs(v) > 0.01));
    } else {
      const speed = (keys.has('ShiftLeft') ? 1500 : 400) * dt,
        f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
        s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
        z = (keys.has('Space') ? 1 : 0) - (keys.has('ControlLeft') ? 1 : 0);
      camera.position.x += (Math.cos(lookYaw) * f + Math.sin(lookYaw) * s) * speed;
      camera.position.y += (Math.sin(lookYaw) * f - Math.cos(lookYaw) * s) * speed;
      camera.position.z += z * speed;
      moving = f !== 0 || s !== 0 || z !== 0;
    }
    look();
    if (moving) schedule();
  }
  renderer.render(scene, camera);
  frame++;
}
window.labDebug = {
  get map() {
    return assetSet.mapName;
  },
  get faces() {
    return bsp?.faces.length;
  },
  get triangles() {
    return renderer.info.render.triangles;
  },
  get points() {
    return shownCount;
  },
  get rows() {
    return rows.length / ROW;
  },
  get mode() {
    return mode;
  },
  get frame() {
    return frame;
  },
  get errors() {
    return errorCount;
  },
  get gl() {
    return renderer.getContext().getError();
  },
};
window.lab = {
  whenStarted,
  get engine() {
    return engine;
  },
  get bsp() {
    return bsp;
  },
  get model() {
    return model;
  },
  get pose() {
    return pose;
  },
  get rows() {
    return rows;
  },
  get shown() {
    return shown;
  },
  get walker() {
    return walker;
  },
  get camera() {
    return camera;
  },
  loadAssets,
  scan,
  selectPoint,
  setMode,
  updateTarget,
  updatePoints,
  filterPoints,
  damage,
};
initializeWeapons();
loadPrefs();
showSky();
syncArmor();
pointMaterial.depthTest = !$('xray').checked;
updatePoints();
design.initialize({ clearSelection, resetFilters });
design.cut(cut.constant, Number($('cut').max));
navigationHint();
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((e) => console.warn('Offline shell unavailable', errorMessage(e)));
lockScan(false);
$('progressText').textContent = 'Restoring last map…';
const initialLoad = get<Assets>('assets', 'last')
  .then((a) => {
    if (a) return loadAssets(a, false);
  })
  .catch((e) => console.warn('Cached assets unavailable', errorMessage(e)))
  .finally(() => {
    loadingScene = false;
    lockScan(false);
    bookmarks.setReady(!!engine);
    if (!engine) $('progressText').textContent = 'Load a map to begin.';
  });
function whenStarted() {
  return initialLoad;
}

export type LabAPI = typeof windowAPI;
const windowAPI = {
  whenStarted,
  loadAssets,
  scan,
  selectPoint,
  setMode,
  updateTarget,
  updatePoints,
  filterPoints,
  damage,
};
declare global {
  interface Window {
    labReady?: boolean;
    labProgress?: Omit<Progress, 'type'>;
    labLastScan?: Omit<import('./engine/types.ts').Complete, 'rows'> & { rows?: undefined };
    labDebug: {
      map?: string;
      faces?: number;
      triangles: number;
      points: number;
      rows: number;
      mode: Mode;
      frame: number;
      errors: number;
      gl: number;
    };
    lab: typeof windowAPI & {
      engine: Engine;
      bsp: BSP;
      model: ReturnType<typeof readStudio>;
      pose: Pose;
      rows: Float32Array;
      shown: Uint8Array;
      walker: Walker;
      camera: THREE.PerspectiveCamera;
    };
  }
}
