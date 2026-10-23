const INTERVAL = 1000 / 60;
// An early callback must not lose a whole 60 Hz refresh. A sub-millisecond
// alternating phase otherwise repeatedly resets the deadline and locks to 30.
// The deadline still advances by a full interval, so this is jitter allowance,
// not a higher sustained frame cap.
const TOLERANCE = 2;

/** Caps active rendering at 60 Hz without scheduling work for an idle scene. */
export class FrameLimiter {
  private next = -Infinity;

  ready(now: number): boolean {
    if (now + TOLERANCE < this.next) return false;
    // Retain cadence on high-refresh displays; reset after stalls instead of
    // spending subsequent frames catching up on missed renders.
    this.next = now - this.next >= INTERVAL - TOLERANCE ? now + INTERVAL : this.next + INTERVAL;
    return true;
  }
}
