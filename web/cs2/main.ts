import {
  AmbientLight,
  BatchedMesh,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  type Intersection,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Plane,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadRenderMap, type RenderMap } from './render-map';
import { decodeMap, type MapData, type Metadata, required, type Shot, type V3 } from './types';
import { createWalkControls, type WalkState } from './walk-controls';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const input = (id: string) => element<HTMLInputElement>(id);
if (new URLSearchParams(location.search).get('view') === 'collision') {
  element<HTMLSelectElement>('display').value = 'collision';
  element('render-status').textContent =
    'Collision view · choose Textures to load local appearance.';
}
const view = element('view');
const renderer = new WebGLRenderer({ antialias: true });
const gl = renderer.getContext();
const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = rendererInfo ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)) : '';
const software = /swiftshader|llvmpipe|software/i.test(gpu);
renderer.localClippingEnabled = true;
view.append(renderer.domElement);
const scene = new Scene();
scene.background = new Color('#15232c');
scene.fog = new Fog(scene.background, 30000, 40000);
const camera = new PerspectiveCamera(55, 1, 1, 40000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 20000;
controls.minDistance = 10;
scene.add(new AmbientLight(0xffffff, 1.6));
const sun = new DirectionalLight(0xffffff, 2);
sun.position.set(-1000, -1000, 4000);
scene.add(sun);
const ceiling = new Plane(new Vector3(0, 0, -1), 40000);
let dirty = true;
let renderMs = 0;
let framesDrawn = 0;
const invalidate = () => {
  dirty = true;
};
controls.addEventListener('change', invalidate);
const material = new MeshLambertMaterial({
  vertexColors: true,
  side: DoubleSide,
  clippingPlanes: [ceiling],
});
let meta: Metadata, data: MapData, geometry: BufferGeometry;
const shotGroup = new Group();
scene.add(shotGroup);
const collisionGroup = new Group();
scene.add(collisionGroup);
let texturedMap: RenderMap | null = null;
let texturesLoading = false;
let scanPoints: Points | null = null;
let scanSources: V3[] = [];
let pickMode: 'source' | 'target' | null = null;
let currentShot: Shot | null = null;
let scanResult: unknown = null;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: Reply) => void; reject: (reason: Error) => void }
>();
interface Reply {
  id: number;
  kind: string;
  error?: string;
  meta?: Metadata;
  buffer?: ArrayBuffer;
  shot?: Shot;
  hit?: { point: V3; normal: V3 };
  points?: { source: V3; damage: number | null; status: string }[];
  tested?: number;
  total?: number;
  cancelled?: boolean;
  ms?: number;
  loadMs?: number;
  buildMs?: number;
  cached?: boolean;
  cacheSaved?: boolean;
  state?: WalkState;
  placement?: string;
}
function request(op: object): Promise<Reply> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...op });
  });
}
worker.onmessage = ({ data: reply }: { data: Reply }) => {
  if (reply.kind === 'progress') {
    element('scan-status').textContent = `Checking floor/clearance ${reply.tested}/${reply.total}…`;
    return;
  }
  const promise = pending.get(reply.id);
  pending.delete(reply.id);
  if (reply.kind === 'error') promise?.reject(Error(reply.error));
  else promise?.resolve(reply);
};
worker.onerror = (event) => showError(Error(event.message));
function showError(error: unknown) {
  element('load').textContent = String(error);
  element('load').className = 'error';
  console.error(error);
}
function updateDisplay() {
  invalidate();
  const showTextures = element<HTMLSelectElement>('display').value === 'textures' && !!texturedMap;
  collisionGroup.visible = !showTextures;
  if (texturedMap) texturedMap.group.visible = showTextures;
  if (!walking.active)
    element('hint').textContent = showTextures
      ? 'Inferno · base textures · physics traced separately'
      : 'Inferno collision · surfaces colored by material';
}
async function ensureTextures() {
  if (texturedMap || texturesLoading) {
    updateDisplay();
    return;
  }
  texturesLoading = true;
  try {
    texturedMap = await loadRenderMap({
      clippingPlanes: [ceiling],
      collisionFingerprint: meta.fingerprint,
      batch: new URLSearchParams(location.search).get('batch') !== '0',
      onProgress: (message) => {
        element('render-status').textContent = message;
      },
    });
    scene.add(texturedMap.group);
    updateDisplay();
  } catch (error) {
    element('render-status').textContent = String(error).replace(/^Error: /, '');
    element<HTMLSelectElement>('display').value = 'collision';
    updateDisplay();
  } finally {
    texturesLoading = false;
  }
}
const walking = createWalkControls({
  camera,
  canvas: renderer.domElement,
  request: async (message) => {
    const reply = await request(message);
    return { state: required(reply.state), ms: reply.ms, placement: reply.placement };
  },
  changed: (active, message) => {
    applyRenderSettings(active);
    controls.enabled = !active;
    button('walk').setAttribute('aria-pressed', String(active));
    button('orbit').setAttribute('aria-pressed', String(!active));
    button('view-source').disabled = !active;
    element('walk-status').textContent = message;
    element('hint').textContent = active
      ? 'Walk · click to look · E places stationary target'
      : texturedMap?.group.visible
        ? 'Inferno · base textures · physics traced separately'
        : 'Inferno collision · surfaces colored by material';
    if (!active)
      controls.target
        .copy(camera.position)
        .addScaledVector(camera.getWorldDirection(new Vector3()), 200);
  },
  placeTarget: (eye) => {
    writeCoordinates('target', eye);
    clearScan();
    currentShot = null;
    disposeGroup(shotGroup);
    marker(new Vector3(...eye), 0x58d8ef, 8);
    element('result').textContent =
      'Target placed at your eye. Move to a shooting position, then Trace from view.';
  },
  error: showError,
});
function applyRenderSettings(walk = walking.active) {
  const detail = element<HTMLSelectElement>('quality').value === 'detail';
  renderer.setPixelRatio(Math.min(devicePixelRatio, detail ? 1.5 : software ? 0.75 : 1));
  camera.far = walk ? 8192 : 40000;
  camera.updateProjectionMatrix();
  const fog = scene.fog as Fog;
  fog.near = camera.far * 0.8;
  fog.far = camera.far;
  ceiling.constant = input('cut-enabled').checked && !walk ? Number(input('cut').value) : 40000;
  invalidate();
}
applyRenderSettings(false);
function coordinates(id: string): V3 {
  const values = input(id).value.trim().split(/[ ,]+/).map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite))
    throw Error('Enter three finite Source coordinates');
  return values as V3;
}
function writeCoordinates(id: string, value: V3) {
  input(id).value = value.map((v) => v.toFixed(2)).join(' ');
}
function colorFor(index: number) {
  const s = meta.materials[index];
  if (/wood|paper|cardboard/.test(s.name)) return new Color('#b99a71');
  if (/metal|bell|canister/.test(s.name)) return new Color('#6e9eac');
  if (/glass/.test(s.name)) return new Color('#76cfbb');
  if (/dirt|grass|gravel/.test(s.name)) return new Color('#737b55');
  return new Color().setHSL((index * 0.077 + 0.07) % 1, 0.13, 0.48);
}
function setRenderIndex() {
  const output = new Uint32Array(data.indices.length);
  let count = 0;
  for (let i = 0; i < data.shapes.length; i++) {
    const shape = meta.shapes[data.shapes[i]];
    if (shape.bullet || input('clip').checked) {
      output[count++] = data.indices[i * 3];
      output[count++] = data.indices[i * 3 + 1];
      output[count++] = data.indices[i * 3 + 2];
    }
  }
  geometry.setIndex(new BufferAttribute(output.subarray(0, count), 1));
}
function buildView(buffer: ArrayBuffer) {
  data = decodeMap(buffer);
  geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  const colors = new Float32Array(data.positions.length);
  const palette = meta.materials.map((_, i) => colorFor(i));
  const purple = new Color('#a678c0');
  for (let i = 0; i < data.materials.length; i++) {
    const color = meta.shapes[data.shapes[i]].bullet ? palette[data.materials[i]] : purple;
    for (let k = 0; k < 3; k++) color.toArray(colors, data.indices[i * 3 + k] * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  setRenderIndex();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  collisionGroup.add(new Mesh(geometry, material));
}
function disposeGroup(group: Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof Mesh || child instanceof Line) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of materials) m.dispose();
    }
  }
}
function marker(position: Vector3, color: number, radius = 6) {
  const mesh = new Mesh(
    new SphereGeometry(radius, 12, 8),
    new MeshLambertMaterial({ color, depthTest: false }),
  );
  mesh.position.copy(position);
  mesh.renderOrder = 4;
  shotGroup.add(mesh);
}
function segment(a: Vector3, b: Vector3, color: number) {
  const line = new Line(
    new BufferGeometry().setFromPoints([a, b]),
    new LineBasicMaterial({ color, depthTest: false }),
  );
  line.renderOrder = 3;
  shotGroup.add(line);
}
function renderShot(shot: Shot) {
  invalidate();
  currentShot = shot;
  disposeGroup(shotGroup);
  const source = new Vector3(...shot.source),
    target = new Vector3(...shot.target),
    direction = target.clone().sub(source).normalize();
  marker(source, 0xffac53, 8);
  marker(target, 0x58d8ef, 8);
  segment(source, target, 0xffdf79);
  for (const s of shot.spans) {
    const a = source.clone().addScaledVector(direction, s.enter),
      b = source.clone().addScaledVector(direction, s.exit);
    segment(a, b, 0xff684f);
    marker(a, 0xffac53, 4);
    marker(b, 0x8fe6cc, 4);
  }
  for (const contact of shot.contacts)
    marker(source.clone().addScaledVector(direction, contact.distance), 0xffac53, 3);
  const result = element('result');
  result.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = shot.status.replaceAll('-', ' ');
  result.append(title);
  const damage = document.createElement('div');
  damage.className = 'damage';
  damage.textContent =
    shot.damage === null ? 'Indeterminate' : `${shot.damage.toFixed(1)} estimated damage`;
  result.append(damage);
  const timing = document.createElement('p');
  timing.textContent = `${shot.distance.toFixed(1)} units · ${shot.spans.length} material intervals · ${shot.ms.toFixed(2)} ms worker trace`;
  result.append(timing);
  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>Surface / ID</th><th>Entry to exit</th><th>Thickness</th></tr></thead>';
  for (const s of shot.spans) {
    const row = table.insertRow();
    row.insertCell().textContent = `${meta.materials[s.material].name} / ${s.material} to ${meta.materials[s.exitMaterial].name} / ${s.exitMaterial}`;
    row.insertCell().textContent = `${s.enter.toFixed(1)} to ${s.exit.toFixed(1)}${s.startInside ? ' (inside)' : ''}`;
    row.insertCell().textContent = `${(s.exit - s.enter).toFixed(2)} u`;
    row.title = `Shape ${s.shape}: ${meta.shapes[s.shape].source}; entry/exit distances along the shot. Hash ${meta.materials[s.material].hash}`;
  }
  for (const c of shot.contacts.filter(
    (c) =>
      !shot.spans.some(
        (s) => s.shape === c.shape && c.distance >= s.enter - 0.01 && c.distance <= s.exit + 0.01,
      ),
  )) {
    const row = table.insertRow();
    row.insertCell().textContent = `${meta.materials[c.material].name} / ${c.material}`;
    const sky = meta.shapes[c.shape].tags.includes('sky');
    row.insertCell().textContent = sky
      ? `Sky boundary ${c.distance.toFixed(1)}`
      : `Contact ${c.distance.toFixed(1)}; exit unresolved`;
    row.insertCell().textContent = sky ? 'Boundary' : 'Unknown';
  }
  result.append(table);
  for (const issue of shot.issues) {
    const p = document.createElement('p');
    p.textContent = issue;
    p.className = 'error';
    result.append(p);
  }
  const v = direction;
  const pitch = (-Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI,
    yaw = (Math.atan2(v.y, v.x) * 180) / Math.PI;
  element('commands').textContent =
    `map de_inferno\nsv_cheats 1\nbot_kick\ngive weapon_awp\nsv_showimpacts 1\nsv_showimpacts_penetration 1\nsv_showimpacts_time 10\nsetpos ${shot.source[0].toFixed(3)} ${shot.source[1].toFixed(3)} ${(shot.source[2] - 64).toFixed(3)}\nsetang ${pitch.toFixed(4)} ${yaw.toFixed(4)} 0\n// Target point: ${shot.target.map((n) => n.toFixed(3)).join(' ')}\n// Fire once manually; record actual impact/penetration.\n// No posed target damage has been validated.`;
}
async function trace(source = coordinates('source'), target = coordinates('target')) {
  if (currentShot?.target.some((v, i) => Math.abs(v - target[i]) > 0.01)) clearScan();
  writeCoordinates('source', source);
  writeCoordinates('target', target);
  const reply = await request({ op: 'trace', source, target });
  renderShot(required(reply.shot));
  return required(reply.shot);
}
function frame() {
  if (walking.active || walking.starting) walking.leave();
  const source = new Vector3(...coordinates('source')),
    target = new Vector3(...coordinates('target'));
  const center = source.clone().add(target).multiplyScalar(0.5),
    span = Math.max(source.distanceTo(target), 260);
  controls.target.copy(center);
  camera.position.copy(center).add(new Vector3(-0.75, -1, 1).multiplyScalar(span));
  controls.update();
}
function overview() {
  if (walking.active || walking.starting) walking.leave();
  controls.target.set(500, 1100, 100);
  camera.position.set(400, -5400, 7000);
  controls.update();
}
async function scan() {
  if (walking.active || walking.starting) walking.leave();
  button('scan').disabled = true;
  button('cancel').disabled = false;
  try {
    const reply = await request({ op: 'scan', target: coordinates('target') });
    clearScan();
    scanResult = reply;
    scanSources = required(reply.points).map((p) => p.source);
    const positions = new Float32Array(scanSources.flat()),
      colors = new Float32Array(positions.length);
    required(reply.points).forEach((p, i) => {
      new Color(p.damage === null ? '#ba89e6' : p.damage > 0 ? '#79ebac' : '#e16b5a').toArray(
        colors,
        i * 3,
      );
    });
    const pointsGeometry = new BufferGeometry();
    pointsGeometry.setAttribute('position', new BufferAttribute(positions, 3));
    pointsGeometry.setAttribute('color', new BufferAttribute(colors, 3));
    scanPoints = new Points(
      pointsGeometry,
      new PointsMaterial({ size: 10, vertexColors: true, depthTest: false }),
    );
    scanPoints.renderOrder = 5;
    scene.add(scanPoints);
    element('scan-status').textContent =
      `${reply.cancelled ? 'Cancelled · ' : ''}${reply.tested}/625 tested · ${required(reply.points).length} floor/clearance candidates · ${required(reply.points).filter((p) => (p.damage ?? 0) > 0).length} estimated reaches · ${required(reply.ms).toFixed(0)} ms`;
    return reply;
  } finally {
    button('scan').disabled = false;
    button('cancel').disabled = true;
  }
}
function clearScan() {
  invalidate();
  if (scanPoints) {
    scene.remove(scanPoints);
    scanPoints.geometry.dispose();
    (scanPoints.material as PointsMaterial).dispose();
    scanPoints = null;
  }
  scanSources = [];
  scanResult = null;
  element('scan-status').textContent = '64-unit grid · ±768 units · standability approximation';
}
button('trace').onclick = () => {
  trace().catch(showError);
};
button('focus').onclick = frame;
button('overview').onclick = overview;
button('source-pick').onclick = () => {
  if (walking.active || walking.starting) walking.leave();
  pickMode = 'source';
  element('hint').textContent = 'Click source floor · standing eye +64 units';
};
button('target-pick').onclick = () => {
  if (walking.active || walking.starting) walking.leave();
  pickMode = 'target';
  element('hint').textContent = 'Click target floor · stationary chest point +48 units';
};
button('scan').onclick = () => {
  scan().catch(showError);
};
button('cancel').onclick = () => {
  request({ op: 'cancel' }).catch(showError);
};
button('clear').onclick = clearScan;
input('cut').oninput = () => {
  applyRenderSettings();
  element('cut-value').textContent = input('cut').value;
};
input('cut-enabled').onchange = () => applyRenderSettings();
element<HTMLSelectElement>('quality').onchange = () => applyRenderSettings();
input('clip').onchange = () => {
  setRenderIndex();
  if (input('clip').checked) element<HTMLSelectElement>('display').value = 'collision';
  updateDisplay();
};
element<HTMLSelectElement>('display').onchange = () => {
  updateDisplay();
  if (element<HTMLSelectElement>('display').value === 'textures') void ensureTextures();
};
button('walk').onclick = () => {
  pickMode = null;
  walking.enter(coordinates('source'), coordinates('target')).catch(showError);
};
button('orbit').onclick = () => walking.leave();
button('view-source').onclick = () => {
  if (walking.state) trace([...walking.state.eye], coordinates('target')).catch(showError);
};
let pointerStart = new Vector2();
renderer.domElement.onpointerdown = (e) => {
  pointerStart = new Vector2(e.clientX, e.clientY);
};
renderer.domElement.onpointerup = async (e) => {
  if (walking.active) return;
  if (pointerStart.distanceTo(new Vector2(e.clientX, e.clientY)) > 4 || e.button !== 0 || !meta)
    return;
  const rect = renderer.domElement.getBoundingClientRect(),
    raycaster = new Raycaster();
  raycaster.setFromCamera(
    new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  if (e.altKey && texturedMap?.group.visible) {
    const hit = raycaster
      .intersectObject(texturedMap.group, true)
      .find((hit) => hit.point.z <= ceiling.constant) as
      | (Intersection & { batchId?: number })
      | undefined;
    const info = element('surface-info');
    info.hidden = false;
    if (hit?.object instanceof Mesh) {
      const source =
        hit.object instanceof BatchedMesh && hit.batchId !== undefined
          ? hit.object.userData.sources[hit.batchId]
          : {
              mesh: hit.object.name,
              material: (hit.object.material as MeshLambertMaterial).userData.sourceMaterial,
            };
      info.textContent = `Surface at ${hit.point
        .toArray()
        .map((n) => n.toFixed(2))
        .join(
          ' ',
        )} · ${source?.material ?? source?.mesh ?? 'unknown'} (geometry pick; alpha ignored)`;
    } else info.textContent = 'No render surface under this point.';
    return;
  }
  try {
    if (pickMode) {
      const reply = await request({
        op: 'pick',
        source: raycaster.ray.origin.toArray(),
        direction: raycaster.ray.direction.toArray(),
        maxZ: ceiling.constant,
      });
      if (!reply.hit || reply.hit.normal[2] < 0.7) {
        element('hint').textContent =
          'Choose an upward-facing floor; orbit/cut away ceilings as needed.';
        return;
      }
      const p = reply.hit.point;
      writeCoordinates(pickMode, [p[0], p[1], p[2] + (pickMode === 'source' ? 64 : 48)]);
      pickMode = null;
      updateDisplay();
      clearScan();
      await trace();
    } else if (scanPoints) {
      raycaster.params.Points = { threshold: 12 };
      const hit = raycaster.intersectObject(scanPoints)[0];
      if (hit?.index !== undefined) {
        writeCoordinates('source', scanSources[hit.index]);
        await trace();
      }
    }
  } catch (error) {
    showError(error);
  }
};
new ResizeObserver(() => {
  const width = view.clientWidth,
    height = view.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  invalidate();
}).observe(view);
let previousFrame = performance.now();
let lastStats = previousFrame;
const previousView = new Matrix4();
renderer.setAnimationLoop((time) => {
  const dt = Math.min(0.05, Math.max(0, (time - previousFrame) / 1000));
  previousFrame = time;
  if (walking.active) void walking.update(dt);
  else controls.update();
  camera.updateMatrixWorld();
  if (!camera.matrixWorld.equals(previousView)) invalidate();
  if (dirty) {
    const start = performance.now();
    renderer.render(scene, camera);
    renderMs = performance.now() - start;
    framesDrawn++;
    previousView.copy(camera.matrixWorld);
    dirty = false;
  }
  if (time - lastStats > 1000) {
    element('performance').textContent =
      `${software ? 'Software renderer · ' : ''}${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1000000).toFixed(2)}M triangles · ${renderMs.toFixed(1)} ms submission${!dirty && !walking.active ? ' · redraw on change' : ''}`;
    lastStats = time;
  }
});
async function init() {
  const reply = await request({ op: 'load' });
  meta = required(reply.meta);
  buildView(required(reply.buffer));
  element('load').textContent =
    `${meta.triangleCount.toLocaleString()} collision triangles · ${(meta.binaryBytes / 1048576).toFixed(1)} MiB · ${(required(reply.loadMs) / 1000).toFixed(2)} s load · ${required(reply.buildMs).toFixed(0)} ms BVH ${reply.cached ? 'restored' : 'built'}${reply.cacheSaved ? ' · cached' : ''}`;
  element('coverage').textContent =
    `${meta.steamInf.replaceAll('\n', ' · ')}\n${JSON.stringify(meta.stats)}\n${meta.warnings.join('\n')}`;
  for (const id of ['source-pick', 'target-pick', 'trace', 'scan', 'walk'])
    button(id).disabled = false;
  await trace();
  frame();
  if (element<HTMLSelectElement>('display').value === 'textures') void ensureTextures();
  Object.assign(window, {
    cs2: {
      meta,
      trace,
      scan,
      frame,
      overview,
      walking,
      get renderMap() {
        return texturedMap?.metadata ?? null;
      },
      get shot() {
        return currentShot;
      },
      get scanResult() {
        return scanResult;
      },
      renderer: () => ({
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        renderMs,
        framesDrawn,
        pixelRatio: renderer.getPixelRatio(),
        far: camera.far,
        gpu,
      }),
      benchmark: (frames = 10) => {
        const samples = [];
        for (let i = 0; i < Math.min(30, frames) + 2; i++) {
          const start = performance.now();
          renderer.render(scene, camera);
          gl.finish();
          if (i >= 2) samples.push(performance.now() - start);
        }
        return {
          samples,
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          pixelRatio: renderer.getPixelRatio(),
          far: camera.far,
          gpu,
        };
      },
      ready: true,
    },
  });
}
init().catch(showError);
