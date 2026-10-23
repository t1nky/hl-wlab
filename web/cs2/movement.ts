import { Vector3 } from 'three';
import type { CollisionMap } from './collision';
import type { V3 } from './types';

export interface WalkInput {
  forward: number;
  side: number;
  jump: boolean;
  duck: boolean;
}
export interface WalkState {
  foot: V3;
  eye: V3;
  velocity: V3;
  grounded: boolean;
  crouched: boolean;
}
const SKIN = 0.025;
const STAND = 72;
const CROUCH = 54;
const STEP = 18;
const v3 = (value: Vector3): V3 => value.toArray() as V3;

// Exploration controller, not a reimplementation of CS2 acceleration or prediction.
// Origin is the feet. The axis-aligned 32u box is swept continuously through physics
// triangles; bullet flags never decide movement collision. All work runs in map worker.
export class WalkController {
  private foot = new Vector3();
  private velocity = new Vector3();
  private grounded = false;
  private crouched = false;
  private jumpHeld = false;
  readonly map: CollisionMap;
  constructor(map: CollisionMap) {
    this.map = map;
  }
  get state(): WalkState {
    return {
      foot: v3(this.foot),
      eye: [this.foot.x, this.foot.y, this.foot.z + (this.crouched ? 46 : 64)],
      velocity: v3(this.velocity),
      grounded: this.grounded,
      crouched: this.crouched,
    };
  }
  // Explicit teleport used by tests and integrations that already have a floor coordinate.
  teleport(foot: V3, crouched = false): WalkState {
    if (!foot.every(Number.isFinite)) throw Error('Walk coordinates must be finite');
    if (!this.map.playerFits(foot, crouched ? CROUCH : STAND, true))
      throw Error('Player volume intersects solid collision at this position');
    this.foot.set(...foot);
    this.crouched = crouched;
    this.velocity.set(0, 0, 0);
    this.jumpHeld = false;
    this.grounded = false;
    this.snapGround(2);
    return this.state;
  }
  start(eye: V3, crouched = false): { state: WalkState; placement: string } {
    if (!eye.every(Number.isFinite)) throw Error('Walk coordinates must be finite');
    const candidates: { foot: V3; label: string }[] = [
      { foot: [eye[0], eye[1], eye[2] - (crouched ? 46 : 64)], label: 'source' },
      ...this.map.metadata.spawns.map((spawn) => ({ foot: spawn.origin, label: spawn.classname })),
    ];
    for (const candidate of candidates) {
      // Snap to actual player collision, including playerclip, not render geometry.
      const floor = this.map.pick(
        [candidate.foot[0], candidate.foot[1], candidate.foot[2] + 18],
        [0, 0, -1],
        'player',
      );
      if (!floor || floor.normal[2] < 0.7 || floor.point[2] < candidate.foot[2] - 256) continue;
      const foot: V3 = [floor.point[0], floor.point[1], floor.point[2] + SKIN];
      if (!this.map.playerFits(foot, crouched ? CROUCH : STAND, true)) continue;
      return { state: this.teleport(foot, crouched), placement: candidate.label };
    }
    throw Error('No clear standing floor near source or map spawns; choose another source');
  }
  private slide(
    start: Vector3,
    displacement: Vector3,
    height: number,
    horizontal = false,
  ): Vector3 {
    const position = start.clone();
    const remaining = displacement.clone();
    for (let bump = 0; bump < 5 && remaining.lengthSq() > 1e-10; bump++) {
      const hit = this.map.sweepPlayer(v3(position), height, v3(remaining));
      if (!hit) {
        position.add(remaining);
        break;
      }
      const advance = Math.max(0, hit.fraction - SKIN / remaining.length());
      position.addScaledVector(remaining, advance);
      remaining.multiplyScalar(1 - hit.fraction);
      const normal = new Vector3(...hit.normal);
      // Walkable ramps may lift the box. Steep faces behave as horizontal walls,
      // rather than letting WASD supply unlimited upward motion along their tangent.
      if (horizontal && normal.z > 0 && normal.z < 0.7) normal.setZ(0).normalize();
      const into = remaining.dot(normal);
      if (into < 0) remaining.addScaledVector(normal, -into);
      else break;
    }
    return position;
  }
  private snapGround(distance: number) {
    const hit = this.map.sweepPlayer(v3(this.foot), this.crouched ? CROUCH : STAND, [
      0,
      0,
      -distance,
    ]);
    this.grounded = !!hit && hit.normal[2] >= 0.7;
    if (this.grounded && hit) {
      this.foot.z -= Math.max(0, distance * hit.fraction - SKIN);
      this.velocity.z = 0;
    }
  }
  step(dt: number, input: WalkInput, yaw: number): WalkState {
    if (![dt, yaw, input.forward, input.side].every(Number.isFinite))
      throw Error('Walk timestep and input must be finite');
    // Dropped frames never cause unbounded catch-up; every substep still has a continuous sweep.
    const duration = Math.max(0, Math.min(dt, 0.1));
    const count = Math.max(1, Math.ceil(duration / (1 / 60)));
    const jump = input.jump && !this.jumpHeld;
    this.jumpHeld = input.jump;
    for (let i = 0; i < count; i++) this.tick(duration / count, input, yaw, jump && i === 0);
    return this.state;
  }
  private tick(dt: number, input: WalkInput, yaw: number, jump: boolean) {
    if (input.duck) this.crouched = true;
    else if (this.crouched && this.map.playerFits(v3(this.foot), STAND)) this.crouched = false;
    const height = this.crouched ? CROUCH : STAND;
    const move = new Vector3(
      Math.cos(yaw) * input.forward - Math.sin(yaw) * input.side,
      Math.sin(yaw) * input.forward + Math.cos(yaw) * input.side,
      0,
    );
    if (move.lengthSq() > 1) move.normalize();
    move.multiplyScalar(this.crouched ? 90 : 210);
    this.velocity.x = move.x;
    this.velocity.y = move.y;
    if (jump && this.grounded) {
      this.velocity.z = 280;
      this.grounded = false;
    }
    const displacement = move.multiplyScalar(dt);
    const previous = this.foot.clone();
    let next = this.slide(previous, displacement, height, true);
    const flatDistance = (p: Vector3) => (p.x - previous.x) ** 2 + (p.y - previous.y) ** 2;
    if (this.grounded && flatDistance(next) < displacement.lengthSq() * 0.99) {
      const up = this.map.sweepPlayer(v3(previous), height, [0, 0, STEP + SKIN]);
      if (!up) {
        const raised = previous.clone().add(new Vector3(0, 0, STEP + SKIN));
        const across = this.slide(raised, displacement, height, true);
        const down = this.map.sweepPlayer(v3(across), height, [0, 0, -STEP - 2 * SKIN]);
        if (down && down.normal[2] >= 0.7) {
          across.z -= Math.max(0, (STEP + 2 * SKIN) * down.fraction - SKIN);
          if (flatDistance(across) > flatDistance(next) + 1e-6) next = across;
        }
      }
    }
    this.foot.copy(next);
    this.velocity.z -= 800 * dt;
    const vertical = new Vector3(0, 0, this.velocity.z * dt);
    const beforeVertical = this.foot.z;
    this.foot.copy(this.slide(this.foot, vertical, height));
    if (Math.abs(this.foot.z - beforeVertical - vertical.z) > SKIN * 2) this.velocity.z = 0;
    if (this.velocity.z <= 0) this.snapGround(2);
    else this.grounded = false;
  }
}
