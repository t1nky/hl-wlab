import type { Engine } from './engine.ts';

type Motion = { p: number[]; v: number[] };
export interface Input {
  forward: number;
  side: number;
  jump: boolean;
  duck: boolean;
}
// Collision-aware exploration. This is not a complete port of PM_Move.
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0),
  add = (a: number[], b: number[], k = 1) => a.map((x, i) => x + b[i] * k);
export class Walker {
  get origin() {
    return this.p;
  }
  engine: Engine;
  p: number[];
  v: number[];
  duck: boolean;
  ground: boolean;
  constructor(engine: Engine, position: number[]) {
    this.engine = engine;
    this.p = position.slice();
    this.v = [0, 0, 0];
    this.duck = false;
    this.ground = false;
  }
  trace(a: number[], b: number[]) {
    return this.engine.trace(a, b, this.duck ? 3 : 1);
  }
  slide(position: number[], velocity: number[], dt: number): Motion {
    let p = position.slice(),
      v = velocity.slice(),
      remaining = dt,
      planes: number[][] = [];
    for (let bump = 0; bump < 4; bump++) {
      const tr = this.trace(p, add(p, v, remaining));
      if (tr[7] || tr[8]) return { p, v: [0, 0, 0] };
      if (tr[0] > 0) p = tr.slice(1, 4);
      if (tr[0] === 1) break;
      remaining *= 1 - tr[0];
      const normal = tr.slice(4, 7);
      planes.push(normal);
      const old = v.slice();
      let found = false;
      for (let i = 0; i < planes.length; i++) {
        const n = planes[i],
          back = dot(old, n);
        let next = add(old, n, -back);
        next = next.map((x) => (Math.abs(x) < 0.1 ? 0 : x));
        if (planes.every((pl, j) => i === j || dot(next, pl) >= 0)) {
          v = next;
          found = true;
          break;
        }
      }
      if (!found) {
        if (planes.length === 2) {
          const [a, b] = planes,
            c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
            len = Math.hypot(...c);
          v = len > 0 ? c.map((x) => ((x / len) * dot(old, c)) / len) : [0, 0, 0];
        } else v = [0, 0, 0];
      }
      if (dot(v, velocity) <= 0) {
        v = [0, 0, 0];
        break;
      }
    }
    return { p, v };
  }
  step(dt: number, input: Input, yaw: number) {
    if (input.duck !== this.duck) {
      const old = this.duck;
      this.duck = input.duck;
      const p = add(this.p, [0, 0, old ? 18 : -18]),
        t = this.trace(p, p);
      if (t[7] || t[8]) this.duck = old;
      else this.p = p;
    }
    const down = this.trace(this.p, add(this.p, [0, 0, -2]));
    this.ground = down[0] < 1 && !down[7] && down[6] >= 0.7;
    if (this.ground) {
      this.p = down.slice(1, 4);
      this.v[2] = 0;
      const speed = Math.hypot(this.v[0], this.v[1]),
        drop = Math.max(speed, 100) * 4 * dt;
      if (speed) {
        this.v[0] *= Math.max(0, speed - drop) / speed;
        this.v[1] *= Math.max(0, speed - drop) / speed;
      }
    }
    let wish = [
        Math.cos(yaw) * input.forward + Math.sin(yaw) * input.side,
        Math.sin(yaw) * input.forward - Math.cos(yaw) * input.side,
        0,
      ],
      len = Math.hypot(...wish),
      speed = this.duck ? 210 / 3 : 210;
    if (len) {
      wish = wish.map((x) => x / len);
      const target = this.ground ? speed : 30,
        needed = target - dot(this.v, wish);
      if (needed > 0) this.v = add(this.v, wish, Math.min(needed, 10 * speed * dt));
    }
    if (this.ground && input.jump) {
      this.v[2] = 268.328157;
      this.ground = false;
    }
    if (!this.ground) this.v[2] -= 800 * dt * 0.5;
    const start = this.p.slice(),
      velocity = this.v.slice(),
      flat = this.slide(start, velocity, dt);
    let result = flat;
    if (this.ground) {
      const up = this.trace(start, add(start, [0, 0, 18]));
      if (!up[7] && !up[8]) {
        const stepped = this.slide(up.slice(1, 4), velocity, dt),
          floor = this.trace(stepped.p, add(stepped.p, [0, 0, -18]));
        if (floor[0] < 1 && floor[6] >= 0.7) {
          stepped.p = floor.slice(1, 4);
          const d = (x: Motion) => (x.p[0] - start[0]) ** 2 + (x.p[1] - start[1]) ** 2;
          if (d(stepped) > d(flat)) result = stepped;
        }
      }
    }
    this.p = result.p;
    this.v = result.v;
    if (!this.ground) this.v[2] -= 800 * dt * 0.5;
  }
  get eye() {
    return add(this.p, [0, 0, this.duck ? 12 : 17]);
  }
}
