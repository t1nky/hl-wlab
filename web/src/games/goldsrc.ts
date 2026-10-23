import { aimAnchor } from '../engine/aims';
import type { Engine } from '../engine/engine';
import { damage } from '../engine/engine';
import { capturePlacement } from '../engine/placement';
import { bestShot, classify, ROW } from '../engine/results';
import type { readStudio } from '../engine/studio';
import type { Assets, BSP, Pose, ScanRequest, ScanResponse, V3 } from '../engine/types';
import { required } from '../engine/types';
import type { WeaponID } from '../engine/weapons';
import {
  type AnalysisProgress,
  type DamageView,
  type GameAnalysis,
  GOLDSRC,
  type ScanOutcome,
  type ScanSettings,
  type TargetInput,
} from './contracts';
import { goldsrcPose, type TargetPose } from './target';

interface Context {
  engine: Engine;
  model: ReturnType<typeof readStudio>;
  bsp: BSP;
  assets: Assets;
  modelHash: string;
  weapon: WeaponID;
}
/** Adapter around the existing GoldSrc engine/cache protocol; its numeric behavior is unchanged. */
export class GoldsrcAnalysis implements GameAnalysis {
  readonly definition = GOLDSRC;
  rows: Float32Array = new Float32Array();
  nativePose?: Pose;
  targetPose?: TargetPose;
  private worker?: Worker;
  private context: () => Context;
  private expansion = 0.5;
  constructor(context: () => Context) {
    this.context = context;
  }
  get count() {
    return this.rows.length / ROW;
  }
  get poseChoices() {
    return (
      this.context().model?.sequences.map((s) => ({
        index: s.index,
        name: s.name,
        frames: s.frames,
        crouched: s.name.startsWith('crouch'),
      })) ?? []
    );
  }
  setTarget(input: TargetInput) {
    const { model, engine } = this.context();
    this.nativePose = model.pose(input.seq, input.p, input.yaw, -input.pitch / 3, true, {
      yawBlend: input.yawBlend,
      pitchBlend: input.pitchBlend,
      gait: input.gait,
      frame: input.frame,
    });
    engine.target(this.nativePose, input.expansion);
    this.expansion = input.expansion;
    this.targetPose = goldsrcPose(this.nativePose, input.p);
    return this.targetPose;
  }
  clearSamples() {
    this.rows = new Float32Array();
  }
  placement(
    body: { origin: V3; crouched: boolean; grounded: boolean },
    yaw: number,
    pitch: number,
  ): TargetInput {
    const placed = capturePlacement(
      { p: body.origin, duck: body.crouched, ground: body.grounded },
      yaw,
      pitch,
      this.context().model.sequences,
    );
    return {
      p: placed.p as V3,
      yaw: placed.yaw,
      pitch: placed.pitch,
      seq: placed.seq,
      frame: 0,
      yawBlend: placed.options.yawBlend ?? 128,
      pitchBlend: placed.options.pitchBlend ?? 127,
      gait: placed.options.gait ?? 1,
      expansion: this.expansion,
    };
  }
  classify(view: DamageView) {
    return classify(this.rows, view.armor, view.armorValue, view.armorRatio, view.aimPoint);
  }
  selection(index: number, view: DamageView) {
    const r = this.rows.subarray(index * ROW, (index + 1) * ROW),
      best = bestShot(r, view.armor, view.armorValue, view.armorRatio, view.aimPoint);
    return {
      eye: [r[2], r[3], r[5]] as V3,
      origin: [r[2], r[3], r[4]] as V3,
      crouched: !!r[0],
      aim: required(this.nativePose).aims[best.anchor] as V3,
      ...best,
      status: best.hp ? (best.walls ? 'penetration' : 'direct') : 'miss',
    };
  }
  async inspect(source: V3, view: DamageView, anchor = aimAnchor(view.aimPoint) ?? 1) {
    const aim = required(this.nativePose).aims[anchor] as V3;
    const [raw, group, walls] = this.context().engine.fire(source, aim);
    const hp = damage(raw, group, view.armor, view.armorValue, view.armorRatio);
    return {
      source,
      aim,
      title: hp ? `${walls ? 'Wallbang' : 'Direct'} · ${hp} HP` : 'No hit',
      summary: `${walls} walls · hitgroup ${group}`,
      text: `Source ${source.map((n) => n.toFixed(2)).join(' ')} → Aim ${aim.map((n) => n.toFixed(2)).join(' ')}\n${hp} HP · raw ${raw.toFixed(2)} · hitgroup ${group} · ${walls} walls\nStatic GoldSrc posed-target simulation; game parity unverified.`,
    };
  }
  cancel() {
    this.worker?.postMessage({ type: 'cancel' });
  }
  scan(settings: ScanSettings, progress: (event: AnalysisProgress) => void): Promise<ScanOutcome> {
    const context = this.context();
    if (!context.assets.map || context.assets.materials === undefined || !this.nativePose)
      return Promise.reject(Error('Load a map and target first'));
    const worker = new Worker(new URL('../workers/scan.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        worker.terminate();
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        if (this.worker === worker) this.worker = undefined;
        return true;
      };
      worker.onerror = (event) => {
        if (!finish()) return;
        reject(Error(event.message));
      };
      worker.onmessageerror = () => {
        if (finish()) reject(Error('Scan worker message could not be decoded'));
      };
      worker.onmessage = ({ data: m }: MessageEvent<ScanResponse>) => {
        if (finished) return;
        if (m.type === 'progress')
          progress({
            phase: m.phase,
            done: m.done,
            total: m.total,
            seconds: m.seconds ?? 0,
            native: m,
          });
        else if (m.type === 'error') {
          finish();
          reject(Error(m.message));
        } else {
          this.rows = m.rows;
          finish();
          resolve({
            cancelled: m.cancelled,
            ms: (m.seconds ?? 0) * 1000,
            native: m,
            summary: m.cancelled
              ? `Cancelled at ${m.done}/${m.total} · finished work cached`
              : `Done in ${(m.seconds ?? 0).toFixed(1)} s · ${m.computed} new, ${m.reused} cached`,
          });
        }
      };
      try {
        worker.postMessage({
          type: 'scan',
          map: required(context.assets.map),
          brushes: context.bsp.brushes,
          materials: required(context.assets.materials),
          modelHash: context.modelHash,
          pose: required(this.nativePose),
          expansion: this.expansion,
          target: required(this.targetPose).origin,
          ...settings,
          weapon: context.weapon,
        } satisfies ScanRequest);
      } catch (error) {
        if (finish()) reject(error);
      }
    });
  }
}
