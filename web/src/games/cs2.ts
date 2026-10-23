import * as THREE from 'three';
import type { WalkState } from '../../cs2/movement';
import { loadRenderMap, type RenderMap } from '../../cs2/render-map';
import { CS2_ROW, classifyCs2, cs2Sample, type ScanStats } from '../../cs2/scan';
import { type Metadata, required, type Shot, type V3 } from '../../cs2/types';
import {
  type AnalysisProgress,
  CS2,
  type DamageView,
  type GameAnalysis,
  type ScanSettings,
  type TargetInput,
} from './contracts';
import { AsyncMovement, type MoveInput, type NavigationBody } from './navigation';
import { intersectTarget, type PlayerPackage, playerPose, type TargetPose } from './target';

interface Reply {
  id: number;
  kind: string;
  error?: string;
  meta?: Metadata;
  state?: WalkState;
  shot?: Shot;
  tested?: number;
  total?: number;
  ms?: number;
  cancelled?: boolean;
  loadMs?: number;
  buildMs?: number;
  cached?: boolean;
  rows?: Float32Array;
  stats?: ScanStats;
}

/** Source 2 backend. Owns private map resources and worker; never owns DOM/input/camera. */
export class Cs2Game implements GameAnalysis {
  readonly definition = CS2;
  readonly group = new THREE.Group();
  readonly worker = new Worker(new URL('../../cs2/worker.ts', import.meta.url), { type: 'module' });
  readonly bounds = new THREE.Box3();
  readonly movement: AsyncMovement<WalkState>;
  readonly walker: NavigationBody;
  meta!: Metadata;
  render?: RenderMap;
  target: V3 = [457.28, 1846.2, 184];
  rows: Float32Array = new Float32Array();
  player!: PlayerPackage;
  targetPose?: TargetPose;
  state?: WalkState;
  timing?: Pick<Reply, 'loadMs' | 'buildMs' | 'cached'>;
  private sequence = 0;
  private disposed = false;
  private abort = new AbortController();
  private pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (e: Error) => void }
  >();
  private scanProgress?: (event: AnalysisProgress) => void;
  constructor(changed: () => void, error: (error: unknown) => void) {
    this.worker.onmessage = ({ data: reply }: MessageEvent<Reply>) => {
      if (reply.kind === 'progress') {
        this.scanProgress?.({
          phase: 'Floor/hull and posed-target tracing',
          done: reply.tested ?? 0,
          total: reply.total ?? 0,
          seconds: 0,
        });
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
      get origin() {
        return game.state?.foot ?? game.target;
      },
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
    const playerResponse = await fetch('/local/player.json', {
      signal: this.abort.signal,
      cache: 'no-store',
    });
    if (!playerResponse.ok)
      throw Error('Prepare real player poses first: bun run cs2:prepare:player');
    this.player = await playerResponse.json();
    if (this.player.steamInf !== this.meta.steamInf)
      throw Error('Player/map versions differ; prepare both from the current installation');
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
  async startWalk(eye: V3, resume = false, crouched = false) {
    this.movement.pause();
    if (!resume || !this.state)
      this.state = required((await this.request({ op: 'walk-start', eye, crouched })).state);
    return required(this.state);
  }
  async trace(source: V3, target = this.target) {
    if (this.targetPose) target = intersectTarget(source, target, this.targetPose)?.point ?? target;
    return required((await this.request({ op: 'trace', source, target })).shot);
  }
  get count() {
    return this.rows.length / CS2_ROW;
  }
  get poseChoices() {
    return (
      this.player?.clips.map((clip, index) => ({
        index,
        name: clip.name,
        frames: clip.frames.length,
        crouched: clip.crouched,
      })) ?? []
    );
  }
  setTarget(input: TargetInput) {
    this.targetPose = playerPose(this.player, input.p, input.yaw, input.seq, input.frame);
    this.target = this.targetPose.aims[1];
    return this.targetPose;
  }
  clearSamples() {
    this.rows = new Float32Array();
  }
  placement(body: { origin: V3; crouched: boolean; grounded: boolean }, yaw: number): TargetInput {
    if (!body.grounded) throw Error('Stand on a floor before placing the target');
    return {
      p: body.origin,
      yaw: (yaw * 180) / Math.PI,
      pitch: 0,
      seq: this.poseChoices.find((c) => c.crouched === body.crouched)?.index ?? 0,
      frame: 0,
      yawBlend: 128,
      pitchBlend: 127,
      gait: 0,
      expansion: 0,
    };
  }
  classify(view: DamageView) {
    return classifyCs2(this.rows, required(this.targetPose), view);
  }
  selection(index: number, view: DamageView) {
    return cs2Sample(this.rows, index, required(this.targetPose), view);
  }
  async inspect(
    source: V3,
    view: DamageView,
    anchor = view.aimPoint === 'chest' ? 0 : view.aimPoint === 'pelvis' ? 2 : 1,
  ) {
    const aim = required(this.targetPose).aims[anchor];
    const hit = intersectTarget(source, aim, required(this.targetPose));
    const shot = await this.trace(source, hit?.point ?? aim);
    return {
      source,
      aim: shot.target,
      title: `AWP · ${shot.status.replaceAll('-', ' ')}`,
      summary: `${shot.damage === null ? 'Unknown' : shot.damage.toFixed(2)} residual damage estimate · geometric hitgroup ${hit?.group ?? 'none'}`,
      text: this.describe(shot),
      intervals: shot.spans,
    };
  }
  async scan(settings: ScanSettings, progress: (event: AnalysisProgress) => void) {
    this.scanProgress = progress;
    try {
      const reply = await this.request({
        op: 'scan',
        target: required(this.targetPose).origin,
        settings,
        pose: this.targetPose,
      });
      this.rows = required(reply.rows);
      const stats = required(reply.stats);
      return {
        cancelled: !!reply.cancelled,
        ms: reply.ms ?? 0,
        summary: `${reply.cancelled ? 'Stopped' : 'Complete'} · ${stats.cells}/${stats.total} cells · ${stats.standing} standing + ${stats.crouching} crouching · ${((reply.ms ?? 0) / 1000).toFixed(2)} s · estimates only`,
      };
    } finally {
      this.scanProgress = undefined;
    }
  }
  cancel() {
    void this.request({ op: 'cancel' }).catch(() => {});
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
    this.render?.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
