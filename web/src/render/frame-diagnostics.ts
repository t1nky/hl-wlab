// Leave a little scheduling tolerance around the 60 Hz target.
export const SLOW_FRAME_MS = 1000 / 55;

export interface SlowFrame {
  at: number;
  phase: 'wake' | 'active';
  gapMs?: number;
  queueMs: number;
  cpuMs: number;
  frameCpuMs: number;
  idleBeforeMs: number;
  burstMs: number;
  burstFrames: number;
  causes: string[];
}

/** Follows actual requested work. An idle gap is never a missed continuous frame. */
export class FrameDiagnostics {
  private pending?: number;
  private started = 0;
  private previous?: number;
  private continuing = false;
  private continuousFrame = false;
  private queueMs = 0;
  private active = false;
  private idleAt?: number;
  private idleBeforeMs = 0;
  private wakeAt = 0;
  private frames = 0;
  private transitions: { state: 'active' | 'idle'; at: number }[] = [];

  request(now: number) {
    this.pending ??= now;
    if (!this.active) {
      this.active = true;
      this.idleBeforeMs = this.idleAt === undefined ? 0 : Math.max(0, now - this.idleAt);
      this.wakeAt = now;
      this.frames = 0;
      this.transition('active', now);
    }
  }

  begin(now: number) {
    if (!this.active) this.request(now);
    this.continuousFrame = this.continuing;
    this.started = now;
    this.queueMs = this.pending === undefined ? 0 : Math.max(0, now - this.pending);
    this.pending = undefined;
    this.frames++;
  }

  end(now: number, cpuMs: number): SlowFrame | undefined {
    const gapMs =
      this.continuousFrame && this.previous !== undefined
        ? this.started - this.previous
        : undefined;
    this.previous = this.started;
    this.continuing = this.pending !== undefined;
    const frameCpuMs = Math.max(0, now - this.started);
    if (!this.continuing) {
      this.active = false;
      this.idleAt = now;
      this.transition('idle', now);
    }
    if (
      (gapMs ?? 0) <= SLOW_FRAME_MS &&
      this.queueMs <= SLOW_FRAME_MS &&
      frameCpuMs <= SLOW_FRAME_MS &&
      cpuMs <= SLOW_FRAME_MS
    )
      return;
    const causes = [];
    if (gapMs !== undefined && gapMs > SLOW_FRAME_MS) causes.push('frame-gap');
    if (this.queueMs > SLOW_FRAME_MS) causes.push('queue-delay');
    if (cpuMs > SLOW_FRAME_MS) causes.push('cpu-render');
    if (frameCpuMs > SLOW_FRAME_MS) causes.push('frame-cpu');
    return {
      at: now,
      phase: this.continuousFrame ? 'active' : 'wake',
      gapMs,
      queueMs: this.queueMs,
      cpuMs,
      frameCpuMs,
      idleBeforeMs: this.idleBeforeMs,
      burstMs: Math.max(0, now - this.wakeAt),
      burstFrames: this.frames,
      causes,
    };
  }

  activity() {
    return this.transitions.slice();
  }

  reset() {
    this.pending = this.previous = this.idleAt = undefined;
    this.continuing = this.continuousFrame = this.active = false;
    this.frames = this.queueMs = this.idleBeforeMs = this.wakeAt = 0;
    this.transitions = [];
  }

  private transition(state: 'active' | 'idle', at: number) {
    this.transitions.push({ state, at });
    if (this.transitions.length > 12) this.transitions.shift();
  }
}
