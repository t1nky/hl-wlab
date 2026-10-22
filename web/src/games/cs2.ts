import * as THREE from 'three';
import type { WalkState } from '../../cs2/movement';
import { loadRenderMap, type RenderMap } from '../../cs2/render-map';
import { type Metadata, required, type Shot, type V3 } from '../../cs2/types';
import { AsyncMovement, type MoveInput, type NavigationBody } from './navigation';

export interface ScanPoint {
  source: V3;
  damage: number | null;
  status: Shot['status'];
}
interface Reply {
  id: number;
  kind: string;
  error?: string;
  meta?: Metadata;
  state?: WalkState;
  shot?: Shot;
  points?: ScanPoint[];
  tested?: number;
  total?: number;
  ms?: number;
  cancelled?: boolean;
  loadMs?: number;
  buildMs?: number;
  cached?: boolean;
}

/** Source 2 backend. Owns private map resources and worker; never owns DOM/input/camera. */
export class Cs2Game {
  readonly group = new THREE.Group();
  readonly shots = new THREE.Group();
  readonly worker = new Worker(new URL('../../cs2/worker.ts', import.meta.url), { type: 'module' });
  readonly bounds = new THREE.Box3();
  readonly movement: AsyncMovement<WalkState>;
  readonly walker: NavigationBody;
  meta!: Metadata;
  render?: RenderMap;
  target: V3 = [457.28, 1846.2, 184];
  points: ScanPoint[] = [];
  state?: WalkState;
  timing?: Pick<Reply, 'loadMs' | 'buildMs' | 'cached'>;
  private sequence = 0;
  private disposed = false;
  private abort = new AbortController();
  private pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (e: Error) => void }
  >();
  private scanProgress?: (tested: number, total: number) => void;
  constructor(changed: () => void, error: (error: unknown) => void) {
    this.worker.onmessage = ({ data: reply }: MessageEvent<Reply>) => {
      if (reply.kind === 'progress') {
        this.scanProgress?.(reply.tested ?? 0, reply.total ?? 625);
        return;
      }
      const request = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      if (reply.kind === 'error') request?.reject(Error(reply.error));
      else request?.resolve(reply);
    };
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(Error(event.message));
      this.pending.clear();
      if (!this.disposed) error(Error(event.message));
    };
    this.movement = new AsyncMovement(
      async (dt, input, yaw) =>
        required(
          (await this.request({ op: 'walk-step', dt, input: { ...input, side: -input.side }, yaw }))
            .state,
        ),
      (state) => {
        this.state = state;
      },
      changed,
      error,
    );
    const game = this;
    this.walker = {
      get eye() {
        return game.state?.eye ?? game.target;
      },
      get duck() {
        return game.state?.crouched ?? false;
      },
      get ground() {
        return game.state?.grounded ?? false;
      },
      get v() {
        return game.state?.velocity ?? [0, 0, 0];
      },
      step: (dt: number, input: MoveInput, yaw: number) => this.movement.step(dt, input, yaw),
    };
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(-1000, -1000, 4000);
    this.group.add(new THREE.AmbientLight(0xffffff, 1.6), sun);
  }
  private request(op: object): Promise<Reply> {
    if (this.disposed) return Promise.reject(Error('CS2 map closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...op });
    });
  }
  async load(progress: (message: string) => void) {
    progress('Loading CS2 physics and cached BVH…');
    const reply = await this.request({ op: 'load', includeBuffer: false });
    this.meta = required(reply.meta);
    this.timing = { loadMs: reply.loadMs, buildMs: reply.buildMs, cached: reply.cached };
    this.render = await loadRenderMap({
      signal: this.abort.signal,
      collisionFingerprint: this.meta.fingerprint,
      onProgress: progress,
    });
    if (this.disposed) {
      this.render.dispose();
      throw Error('CS2 map closed');
    }
    this.group.add(this.render.group);
    this.bounds.setFromObject(this.render.group);
    await this.startWalk([77.46, 1227.8, 156.9]);
  }
  async startWalk(eye: V3, resume = false) {
    this.movement.pause();
    if (!resume || !this.state)
      this.state = required((await this.request({ op: 'walk-start', eye })).state);
    return required(this.state);
  }
  async trace(source: V3, target = this.target) {
    return required((await this.request({ op: 'trace', source, target })).shot);
  }
  async scan(progress: (tested: number, total: number) => void) {
    this.scanProgress = progress;
    try {
      const reply = await this.request({ op: 'scan', target: this.target });
      this.points = required(reply.points);
      return reply;
    } finally {
      this.scanProgress = undefined;
    }
  }
  cancel() {
    void this.request({ op: 'cancel' }).catch(() => {});
  }
  classified() {
    const positions = new Float32Array(this.points.length * 3);
    const hp = new Float32Array(this.points.length);
    const kind = new Float32Array(this.points.length);
    this.points.forEach((point, i) => {
      positions.set([point.source[0], point.source[1], point.source[2] - 63], i * 3);
      hp[i] = point.damage ?? 0;
      kind[i] = point.status === 'clear' ? 1 : point.status === 'estimated-penetration' ? 2 : 0;
    });
    return { positions, hp, kind };
  }
  textures(enabled: boolean) {
    this.render?.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material.userData.cs2TexturesEnabled)
          material.userData.cs2TexturesEnabled.value = Number(enabled);
        if (!('map' in material)) continue;
        if (!Object.hasOwn(material.userData, 'displayTexture'))
          material.userData.displayTexture = material.map;
        material.map = enabled ? material.userData.displayTexture : null;
        material.needsUpdate = true;
      }
    });
  }
  clearShot() {
    for (const object of [...this.shots.children]) {
      this.shots.remove(object);
      if (object instanceof THREE.Line) {
        object.geometry.dispose();
        object.material.dispose();
      }
    }
  }
  drawShot(shot: Shot) {
    this.clearShot();
    const from = new THREE.Vector3(...shot.source);
    const direction = new THREE.Vector3(...shot.target).sub(from).normalize();
    const line = (a: THREE.Vector3, b: THREE.Vector3, color: number) =>
      this.shots.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([a, b]),
          new THREE.LineBasicMaterial({ color, depthTest: false }),
        ),
      );
    line(from, new THREE.Vector3(...shot.target), 0x55ccee);
    for (const span of shot.spans) {
      const entry = from.clone().addScaledVector(direction, span.enter);
      const exit = from.clone().addScaledVector(direction, span.exit);
      line(entry, exit, 0xff6633);
      for (const point of [entry, exit])
        for (const axis of [
          new THREE.Vector3(3, 0, 0),
          new THREE.Vector3(0, 3, 0),
          new THREE.Vector3(0, 0, 3),
        ])
          line(point.clone().sub(axis), point.clone().add(axis), 0xffcc33);
    }
  }
  describe(shot: Shot) {
    const material = (id: number) => `${this.meta.materials[id]?.name ?? 'unknown'} (#${id})`;
    return [
      `${shot.status.replaceAll('-', ' ')} · ${shot.damage === null ? 'damage unknown' : `${shot.damage.toFixed(2)} estimated residual damage`} · ${shot.ms.toFixed(2)} ms`,
      `Source ${shot.source.map((n) => n.toFixed(2)).join(' ')} → Target ${shot.target.map((n) => n.toFixed(2)).join(' ')}`,
      ...shot.spans.map(
        (s) =>
          `${material(s.material)} → ${material(s.exitMaterial)} · entry ${s.enter.toFixed(2)} / exit ${s.exit.toFixed(2)} u · ${(s.exit - s.enter).toFixed(2)} u (${((s.exit - s.enter) * 2.54).toFixed(1)} cm)${s.startInside ? ' · start inside' : ''}`,
      ),
      ...shot.issues,
      'Simulator only; no target hitgroup or armor multiplier. Current CS2 damage parity is unverified.',
    ].join('\n');
  }
  dispose() {
    this.disposed = true;
    this.movement.pause();
    this.abort.abort();
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(Error('CS2 map closed'));
    this.pending.clear();
    this.clearShot();
    this.shots.removeFromParent();
    this.render?.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
