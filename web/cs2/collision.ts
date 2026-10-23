import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Ray,
  type Triangle,
  Vector3,
} from 'three';
import { CENTER, MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import { penetrationLoss, penetrationParameters } from './damage';
import { EPS, type MapData, type Metadata, required, type Shot, type Span, type V3 } from './types';

export interface Crossing {
  distance: number;
  facing: number;
  material: number;
}

export interface PlayerSweep {
  fraction: number;
  normal: V3;
}

// Continuous separating-axis test: moving axis-aligned player box versus a triangle.
// The 13 axes are the box axes, triangle normal, and box-axis/edge cross products.
// Unlike sampling rays or destination overlap, this cannot skip a thin wall between ticks.
function sweepTriangle(
  triangle: Triangle,
  center: Vector3,
  half: Vector3,
  delta: Vector3,
): PlayerSweep | null {
  const edges = [
    new Vector3().subVectors(triangle.b, triangle.a),
    new Vector3().subVectors(triangle.c, triangle.b),
    new Vector3().subVectors(triangle.a, triangle.c),
  ];
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const candidates = [...axes, new Vector3().crossVectors(edges[0], edges[1])];
  for (const edge of edges)
    for (const axis of axes) candidates.push(new Vector3().crossVectors(edge, axis));
  let enter = -Infinity;
  let exit = Infinity;
  let normal = new Vector3();
  for (const axis of candidates) {
    if (axis.lengthSq() < 1e-14) continue;
    axis.normalize();
    const projections = [triangle.a.dot(axis), triangle.b.dot(axis), triangle.c.dot(axis)];
    const radius =
      Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
    const low = Math.min(...projections) - radius - center.dot(axis);
    const high = Math.max(...projections) + radius - center.dot(axis);
    const speed = delta.dot(axis);
    if (Math.abs(speed) < 1e-10) {
      // A merely touching, parallel face must not stop sliding along a floor/wall.
      if (low >= -1e-7 || high <= 1e-7) return null;
      continue;
    }
    const first = Math.min(low / speed, high / speed);
    const last = Math.max(low / speed, high / speed);
    if (first > enter) {
      enter = first;
      normal = axis.clone().multiplyScalar(speed > 0 ? -1 : 1);
    }
    exit = Math.min(exit, last);
    if (enter > exit + 1e-8) return null;
  }
  // Pre-existing overlap is rejected at placement, not pushed through arbitrary walls.
  if (enter < -1e-7 || enter > 1 || exit < 0 || !Number.isFinite(enter)) return null;
  return { fraction: Math.max(0, enter), normal: normal.toArray() as V3 };
}
// Closed outward-wound meshes alternate entry/front and exit/back faces. Never invent an exit.
export function meshSpans(
  hits: Crossing[],
  length: number,
  shape: number,
): { spans: Span[]; issues: string[] } {
  const sorted = hits
    .filter((h) => Math.abs(h.facing) > 1e-6)
    .sort((a, b) => a.distance - b.distance);
  const unique: Crossing[] = [];
  const issues: string[] = [];
  for (const hit of sorted) {
    const previous = unique.at(-1);
    if (previous && Math.abs(previous.distance - hit.distance) < EPS) {
      if (previous.distance <= length && previous.facing * hit.facing < 0)
        issues.push(`Ambiguous coincident faces in shape ${shape}`);
    } else unique.push(hit);
  }
  const spans: Span[] = [];
  let entry: Crossing | undefined;
  let inside = unique[0]?.facing > 0;
  if (inside) entry = { distance: 0, facing: -1, material: unique[0].material };
  for (const hit of unique) {
    if (hit.distance > length && !entry) break;
    if (hit.facing < 0) {
      if (entry) issues.push(`Non-alternating mesh entry in shape ${shape}`);
      entry ??= hit;
    } else if (entry) {
      if (entry.distance < length && hit.distance - entry.distance > EPS)
        spans.push({
          enter: entry.distance,
          exit: hit.distance,
          material: entry.material,
          exitMaterial: hit.material,
          shape,
          startInside: inside,
        });
      entry = undefined;
      inside = false;
    } else if (hit.distance < length) issues.push(`Unpaired mesh exit in shape ${shape}`);
    if (hit.distance > length && !entry) break;
  }
  if (entry && entry.distance < length) issues.push(`No closed mesh exit in shape ${shape}`);
  return { spans, issues };
}

// Analytic convex clipping: dot(n, p) <= offset. Works when the origin is already inside.
export function hullSpan(
  planes: number[][],
  source: Vector3,
  direction: Vector3,
  length: number,
): [number, number] | null {
  let enter = 0;
  let exit = Number.POSITIVE_INFINITY;
  for (const [x, y, z, d] of planes) {
    const distance = d - (x * source.x + y * source.y + z * source.z);
    const velocity = x * direction.x + y * direction.y + z * direction.z;
    if (Math.abs(velocity) < 1e-10) {
      if (distance < -1e-5) return null;
    } else if (velocity < 0) enter = Math.max(enter, distance / velocity);
    else exit = Math.min(exit, distance / velocity);
    if (enter > exit + 1e-5) return null;
  }
  return enter < length && exit - enter > EPS && exit > EPS ? [enter, exit] : null;
}

// Union overlapping solids into non-overlapping intervals; choose the lower distance modifier
// conservatively, rather than charging overlapping world/prop volumes twice.
export function unionSpans(spans: Span[], metadata: Metadata): Span[] {
  const points = [...new Set(spans.flatMap((s) => [s.enter, s.exit]))].sort((a, b) => a - b);
  const result: Span[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    if (b - a < EPS) continue;
    const active = spans.filter((s) => s.enter <= a + 1e-6 && s.exit >= b - 1e-6);
    active.sort(
      (x, y) =>
        (metadata.materials[x.material].distanceModifier ?? -1) -
        (metadata.materials[y.material].distanceModifier ?? -1),
    );
    if (!active.length) continue;
    const winner = active[0];
    const previous = result.at(-1);
    if (
      previous &&
      previous.shape === winner.shape &&
      previous.material === winner.material &&
      Math.abs(previous.exit - a) < EPS
    )
      previous.exit = b;
    else result.push({ ...winner, enter: a, exit: b });
  }
  return result;
}

// Static collision intervals -> residual energy. Target hitgroup/armor is a separate stage.
export function estimate(
  spans: Span[],
  distance: number,
  meta: Metadata,
  issues: string[],
): Pick<Shot, 'damage' | 'status' | 'losses'> {
  const losses: NonNullable<Shot['losses']> = [];
  const unknown = () => ({ damage: null, status: 'indeterminate' as const, losses });
  if (issues.length) return unknown();
  if (distance > meta.weapon.range) return { damage: 0, status: 'blocked', losses };
  let damage = meta.weapon.damage,
    travelled = 0,
    obstacles = 0;
  const falloff = (to: number) => {
    damage *= meta.weapon.rangeModifier ** ((to - travelled) / 500);
    travelled = to;
  };
  for (let i = 0; i < spans.length; i++) {
    const first = spans[i];
    let exit = first.exit;
    let parameters: ReturnType<typeof penetrationParameters> = null;
    // Adjacent/overlapping pieces form one solid: charge impact once, square total thickness.
    // Mixed internal pieces conservatively use the most resistant resolved pair.
    for (;;) {
      const s = spans[i],
        entry = meta.materials[s.material],
        out = meta.materials[s.exitMaterial];
      if (s.startInside || s.exit >= distance - EPS) return unknown();
      if (
        entry.name === 'blockbullets' ||
        out.name === 'blockbullets' ||
        meta.shapes[s.shape].tags.includes('sky')
      )
        return { damage: 0, status: 'blocked', losses };
      const p = penetrationParameters(entry, out);
      if (!p) return unknown();
      if (!parameters || p.modifier < parameters.modifier) parameters = p;
      else parameters.fraction = Math.max(parameters.fraction, p.fraction);
      exit = Math.max(exit, s.exit);
      if (!spans[i + 1] || spans[i + 1].enter > exit + EPS) break;
      i++;
    }
    falloff(first.enter);
    if (++obstacles > 4 || meta.weapon.penetration <= 0)
      return { damage: 0, status: 'blocked', losses };
    const loss = penetrationLoss(
      damage,
      exit - first.enter,
      meta.weapon.penetration,
      required(parameters),
    );
    losses.push({
      enter: first.enter,
      exit,
      before: damage,
      after: Math.max(0, damage - loss.total),
      impact: loss.impact,
      mass: loss.mass,
      modifier: required(parameters).modifier,
    });
    damage = Math.max(0, damage - loss.total);
    if (damage < 1) return { damage: 0, status: 'blocked', losses };
    // Falloff for the remaining interval (including material distance) happens once.
  }
  falloff(distance);
  return { damage, status: spans.length ? 'estimated-penetration' : 'clear', losses };
}

export class CollisionMap {
  readonly geometry: BufferGeometry;
  readonly bvh: MeshBVH;
  readonly far: number;
  readonly data: MapData;
  readonly metadata: Metadata;
  constructor(data: MapData, metadata: Metadata, cached?: SerializedBVH) {
    this.data = data;
    this.metadata = metadata;
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    this.geometry.setIndex(new BufferAttribute(data.indices, 1));
    this.bvh = cached
      ? MeshBVH.deserialize(cached, this.geometry, { setIndex: false })
      : new MeshBVH(this.geometry, { strategy: CENTER, indirect: true, maxLeafSize: 8 });
    this.geometry.computeBoundingBox();
    this.far = required(this.geometry.boundingBox).getSize(new Vector3()).length() * 2;
  }
  hits(source: Vector3, direction: Vector3, kind: 'bullet' | 'player', far = this.far) {
    return this.bvh
      .raycast(new Ray(source, direction), DoubleSide, EPS / 10, far)
      .filter(
        (h) => h.faceIndex != null && this.metadata.shapes[this.data.shapes[h.faceIndex]][kind],
      );
  }
  pick(source: V3, direction: V3, kind: 'bullet' | 'player' = 'bullet', maxZ = Infinity) {
    const hits = this.hits(
      new Vector3(...source),
      new Vector3(...direction).normalize(),
      kind,
    ).sort((a, b) => a.distance - b.distance);
    const h = hits.find((h) => h.point.z <= maxZ);
    return h
      ? {
          point: h.point.toArray(),
          normal: required(h.face).normal.toArray(),
          material: this.data.materials[required(h.faceIndex)],
          shape: this.data.shapes[required(h.faceIndex)],
        }
      : null;
  }
  trace(source: V3, target: V3, kind: 'bullet' | 'player' = 'bullet'): Shot {
    const start = performance.now();
    if (![...source, ...target].every(Number.isFinite)) throw Error('Coordinates must be finite');
    const origin = new Vector3(...source),
      direction = new Vector3(...target).sub(origin);
    const distance = direction.length();
    if (distance < EPS) throw Error('Source and target must be different');
    direction.normalize();
    const hits = this.hits(origin, direction, kind, Math.max(this.far, distance + this.far));
    const contacts: Shot['contacts'] = [];
    for (const h of hits
      .filter((h) => h.distance <= distance)
      .sort((a, b) => a.distance - b.distance)) {
      const tri = required(h.faceIndex),
        shape = this.data.shapes[tri];
      if (contacts.some((c) => c.shape === shape && Math.abs(c.distance - h.distance) < EPS))
        continue;
      contacts.push({
        distance: h.distance,
        material: this.data.materials[tri],
        shape,
        facing: required(h.face).normal.dot(direction),
      });
    }
    const candidates = new Map<number, Crossing[]>();
    for (const h of hits) {
      const tri = required(h.faceIndex),
        shape = this.data.shapes[tri];
      let list = candidates.get(shape);
      if (!list) {
        list = [];
        candidates.set(shape, list);
      }
      list.push({
        distance: h.distance,
        facing: required(h.face).normal.dot(direction),
        material: this.data.materials[tri],
      });
    }
    const spans: Span[] = [],
      issues: string[] = [];
    let crossesSky = false;
    for (const [id, crossings] of candidates) {
      const shape = this.metadata.shapes[id];
      // Sky encloses playable space with inward-facing/open boundary surfaces.
      // A distant backface is not evidence that the source is inside solid matter.
      // Only an actual boundary crossing before the target blocks this shot.
      if (shape.tags.includes('sky')) {
        crossesSky ||= crossings.some((hit) => hit.distance <= distance);
        continue;
      }
      if (shape.kind === 'hull') {
        const interval = hullSpan(shape.planes, origin, direction, distance);
        if (interval)
          spans.push({
            enter: interval[0],
            exit: interval[1],
            material: crossings[0].material,
            exitMaterial: crossings[0].material,
            shape: id,
            startInside: interval[0] < EPS,
          });
      } else {
        // Ignore remote inconsistent geometry after target, but retain first crossing beyond it
        // so a source already inside a closed mesh or a target in a wall is identified.
        const result = meshSpans(crossings, distance, id);
        spans.push(...result.spans);
        issues.push(...result.issues);
      }
    }
    const merged = unionSpans(spans, this.metadata);
    return {
      source,
      target,
      distance,
      spans: merged,
      contacts,
      issues,
      ...(crossesSky
        ? { damage: 0, status: 'blocked' as const }
        : estimate(merged, distance, this.metadata, issues)),
      ms: performance.now() - start,
    };
  }
  standable(foot: V3): boolean {
    const center = new Vector3(foot[0], foot[1], foot[2] + 37);
    const box = new Box3(
      new Vector3(foot[0] - 16, foot[1] - 16, foot[2] + 1),
      new Vector3(foot[0] + 16, foot[1] + 16, foot[2] + 73),
    );
    let overlap = false;
    this.bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (triangle, index) => {
        if (!this.metadata.shapes[this.data.shapes[index]].player) return false;
        if (triangle.intersectsBox(box)) {
          overlap = true;
          return true;
        }
        return false;
      },
    });
    if (overlap) return false;
    // Surface-only overlap misses a box wholly contained in solid geometry.
    return !this.trace(
      center.toArray() as V3,
      [center.x, center.y, center.z + 1],
      'player',
    ).spans.some((s) => s.startInside);
  }
  sweepPlayer(foot: V3, height: number, displacement: V3): PlayerSweep | null {
    const center = new Vector3(foot[0], foot[1], foot[2] + height / 2);
    const half = new Vector3(16, 16, height / 2);
    const delta = new Vector3(...displacement);
    const bounds = new Box3(center.clone().sub(half), center.clone().add(half));
    bounds.union(new Box3(bounds.min.clone().add(delta), bounds.max.clone().add(delta)));
    bounds.expandByScalar(0.001);
    let closest: PlayerSweep | null = null;
    this.bvh.shapecast({
      intersectsBounds: (box) => bounds.intersectsBox(box),
      intersectsTriangle: (triangle, index) => {
        if (!this.metadata.shapes[this.data.shapes[index]].player) return false;
        const hit = sweepTriangle(triangle, center, half, delta);
        if (hit && (!closest || hit.fraction < closest.fraction)) closest = hit;
        return false;
      },
    });
    return closest;
  }
  playerFits(foot: V3, height: number, checkInside = false): boolean {
    const box = new Box3(
      new Vector3(foot[0] - 15.99, foot[1] - 15.99, foot[2] + 0.01),
      new Vector3(foot[0] + 15.99, foot[1] + 15.99, foot[2] + height - 0.01),
    );
    let overlap = false;
    this.bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (triangle, index) => {
        if (!this.metadata.shapes[this.data.shapes[index]].player) return false;
        if (triangle.intersectsBox(box)) overlap = true;
        return overlap;
      },
    });
    if (overlap) return false;
    if (!checkInside) return true;
    const center: V3 = [foot[0], foot[1], foot[2] + height / 2];
    return !this.trace(center, [center[0], center[1], center[2] + 1], 'player').spans.some(
      (span) => span.startInside,
    );
  }
  dispose() {
    this.geometry.dispose();
  }
}
