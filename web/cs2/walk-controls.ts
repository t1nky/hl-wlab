import { type PerspectiveCamera, Vector3 } from 'three';
import type { V3 } from './types';

export interface WalkState {
  foot: V3;
  eye: V3;
  velocity: V3;
  grounded: boolean;
  crouched: boolean;
}
export interface WalkInput {
  forward: number;
  side: number;
  jump: boolean;
  duck: boolean;
}
export type WalkRequest =
  | { op: 'walk-start'; eye: V3 }
  | { op: 'walk-step'; dt: number; input: WalkInput; yaw: number };
interface WalkReply {
  state: WalkState;
  ms?: number;
  placement?: string;
}

// Browser controls only. Player collision and movement run in the existing worker.
export function createWalkControls(options: {
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  request: (message: WalkRequest) => Promise<WalkReply>;
  changed: (active: boolean, message: string) => void;
  placeTarget: (eye: V3) => void;
  error: (error: unknown) => void;
}) {
  const { camera, canvas } = options;
  const keys = new Set<string>();
  let active = false;
  let state: WalkState | null = null;
  let pending = false;
  let generation = 0;
  let yaw = 0;
  let pitch = 0;
  let elapsed = 0;
  let dragging = false;
  let fallback = false;
  let starting = false;
  let lastMs = 0;
  let hadPointerLock = false;
  canvas.tabIndex = 0;

  function applyCamera() {
    if (!active || !state) return;
    camera.position.fromArray(state.eye);
    const forward = new Vector3(
      Math.cos(pitch) * Math.cos(yaw),
      Math.cos(pitch) * Math.sin(yaw),
      -Math.sin(pitch),
    );
    camera.lookAt(camera.position.clone().add(forward));
  }
  function status() {
    if (!active) return;
    const controlling = document.pointerLockElement === canvas || document.activeElement === canvas;
    options.changed(
      true,
      controlling
        ? `${fallback ? 'Drag to look · ' : ''}WASD walk · Space jump · Ctrl crouch · E target · Esc pause`
        : 'Walk paused · click the map to look and move',
    );
  }
  async function enter(eye: V3, target: V3) {
    if (starting) return;
    starting = true;
    const token = ++generation;
    try {
      const reply = await options.request({ op: 'walk-start', eye });
      if (token !== generation) return;
      state = reply.state;
      active = true;
      elapsed = 0;
      keys.clear();
      const direction = new Vector3(...target).sub(new Vector3(...state.eye));
      yaw = Math.atan2(direction.y, direction.x);
      pitch = Math.max(
        -1.5,
        Math.min(1.5, Math.atan2(-direction.z, Math.hypot(direction.x, direction.y))),
      );
      applyCamera();
      options.changed(
        true,
        `Walk ready${reply.placement ? ` · ${reply.placement}` : ''} · click map to move`,
      );
    } finally {
      starting = false;
    }
  }
  function leave() {
    generation++;
    active = false;
    keys.clear();
    elapsed = 0;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (document.activeElement === canvas) canvas.blur();
    options.changed(false, 'Drag to orbit · right-drag pan · wheel zoom');
  }
  function pause() {
    generation++;
    keys.clear();
    elapsed = 0;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    canvas.blur();
    status();
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!active || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    dragging = true;
    if (document.pointerLockElement !== canvas && !fallback) {
      if (canvas.requestPointerLock) {
        canvas.requestPointerLock()?.catch(() => {
          fallback = true;
          status();
        });
      } else fallback = true;
    }
    status();
  });
  document.addEventListener('pointerup', () => {
    dragging = false;
  });
  document.addEventListener('pointerlockchange', () => {
    keys.clear();
    const locked = document.pointerLockElement === canvas;
    if (hadPointerLock && !locked) {
      generation++;
      elapsed = 0;
      canvas.blur();
    }
    hadPointerLock = locked;
    status();
  });
  document.addEventListener('mousemove', (event) => {
    if (!active || !(document.pointerLockElement === canvas || (fallback && dragging))) return;
    yaw -= event.movementX * 0.002;
    pitch = Math.max(-1.55, Math.min(1.55, pitch + event.movementY * 0.002));
    applyCamera();
  });
  document.addEventListener('keydown', (event) => {
    if (!active) return;
    if (event.code === 'Escape') {
      pause();
      return;
    }
    if (!(document.pointerLockElement === canvas || document.activeElement === canvas)) return;
    if (
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC'].includes(
        event.code,
      )
    ) {
      event.preventDefault();
      keys.add(event.code);
    }
    if (event.code === 'KeyE' && !event.repeat && state) {
      event.preventDefault();
      options.placeTarget([...state.eye]);
    }
  });
  document.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => {
    keys.clear();
  });
  async function update(dt: number) {
    if (
      !active ||
      !state ||
      !(document.pointerLockElement === canvas || document.activeElement === canvas)
    )
      return;
    elapsed = Math.min(0.05, elapsed + dt);
    if (pending || elapsed < 1 / 120) return;
    const token = generation;
    const delta = elapsed;
    elapsed = 0;
    pending = true;
    try {
      const reply = await options.request({
        op: 'walk-step',
        dt: delta,
        yaw,
        input: {
          forward: Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
          side: Number(keys.has('KeyA')) - Number(keys.has('KeyD')),
          jump: keys.has('Space'),
          duck: keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC'),
        },
      });
      if (token !== generation || !active) return;
      state = reply.state;
      lastMs = reply.ms ?? 0;
      applyCamera();
    } catch (error) {
      leave();
      options.error(error);
    } finally {
      pending = false;
    }
  }
  return {
    enter,
    leave,
    update,
    get active() {
      return active;
    },
    get starting() {
      return starting;
    },
    get state() {
      return state;
    },
    get ms() {
      return lastMs;
    },
  };
}
