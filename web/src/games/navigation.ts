/** Shared input convention: forward W/S, positive side D (right), yaw in radians. */
export interface MoveInput {
  forward: number;
  side: number;
  jump: boolean;
  duck: boolean;
}
export interface NavigationBody {
  readonly origin: number[];
  readonly eye: number[];
  readonly duck: boolean;
  readonly ground: boolean;
  readonly v: number[];
  step(dt: number, input: MoveInput, yaw: number): void;
}

/** Serializes async physics without slowing movement to one tiny step per rendered frame.
 * No queued time/input survives pause, teleport, or disposal. Late replies are ignored. */
export class AsyncMovement<T> {
  private pending = false;
  private generation = 0;
  private elapsed = 0;
  private run: (dt: number, input: MoveInput, yaw: number) => Promise<T>;
  private accept: (state: T) => void;
  private changed: () => void;
  private error: (error: unknown) => void;
  constructor(
    run: (dt: number, input: MoveInput, yaw: number) => Promise<T>,
    accept: (state: T) => void,
    changed: () => void,
    error: (error: unknown) => void,
  ) {
    this.run = run;
    this.accept = accept;
    this.changed = changed;
    this.error = error;
  }
  pause() {
    this.generation++;
    this.elapsed = 0;
  }
  step(dt: number, input: MoveInput, yaw: number) {
    this.elapsed = Math.min(0.05, this.elapsed + dt);
    if (this.pending) return;
    const generation = this.generation;
    const elapsed = this.elapsed;
    this.elapsed = 0;
    this.pending = true;
    void this.run(elapsed, input, yaw)
      .then((state) => {
        if (generation === this.generation) this.accept(state);
      })
      .catch((error) => {
        if (generation === this.generation) this.error(error);
      })
      .finally(() => {
        this.pending = false;
        if (generation === this.generation) this.changed();
      });
  }
}
