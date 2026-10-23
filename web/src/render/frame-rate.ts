const INTERVAL = 1000 / 60;
// Browser timestamps can straddle a refresh boundary by a fraction of a millisecond.
const TOLERANCE = 0.5;

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
