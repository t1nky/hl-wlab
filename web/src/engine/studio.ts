import type { Bone, PoseOptions, Sequence } from './types.ts';

type LocalPose = { p: number[]; q: number[] };
// IDST v10, fixed animation frame zero. Uses real imported MDL hitboxes and
// bone animations; no capsule or generic human hitbox substitutes.
const F = Math.fround;
function multiply(a: number[], b: number[]) {
  const o = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 4; j++)
      o[i * 4 + j] = F(
        F(F(a[i * 4] * b[j]) + F(a[i * 4 + 1] * b[j + 4])) +
          F(a[i * 4 + 2] * b[j + 8]) +
          (j === 3 ? a[i * 4 + 3] : 0),
      );
  return o;
}
function quaternion(a: number[]) {
  const [sx, sy, sz] = a.map((x) => Math.sin(x * 0.5)),
    [cx, cy, cz] = a.map((x) => Math.cos(x * 0.5));
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ].map(F);
}
function slerp(a: number[], b: number[], t: number) {
  let cos = a.reduce((s, x, i) => s + x * b[i], 0);
  if (cos < 0) {
    cos = -cos;
    b = b.map((x) => -x);
  }
  let x = 1 - t,
    y = t;
  if (1 - cos > 1e-6) {
    const o = Math.acos(Math.min(1, cos)),
      s = Math.sin(o);
    x = Math.sin((1 - t) * o) / s;
    y = Math.sin(t * o) / s;
  }
  return a.map((v, i) => F(v * x + b[i] * y));
}
function matrix(q: number[], p: number[]) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    p[0],
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    p[1],
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
    p[2],
  ].map(F);
}
export function readStudio(buffer: ArrayBuffer) {
  const d = new DataView(buffer),
    u = new Uint8Array(buffer),
    i = (p: number) => d.getInt32(p, true),
    f = (p: number) => d.getFloat32(p, true),
    s = (p: number) => d.getInt16(p, true),
    w = (p: number) => d.getUint16(p, true),
    str = (p: number, n: number) => new TextDecoder().decode(u.subarray(p, p + n)).split('\0')[0];
  const check = (p: number, n: number) => {
    if (p < 0 || n < 0 || p > buffer.byteLength - n) throw Error('Invalid MDL range');
  };
  check(0, 244);
  if (str(0, 4) !== 'IDST' || i(4) !== 10) throw Error('Expected a GoldSrc IDST v10 player model');
  const nb = i(140),
    bi = i(144),
    nc = i(148),
    ci = i(152),
    nh = i(156),
    hi = i(160),
    ns = i(164),
    si = i(168),
    gi = i(176);
  if (nb < 1 || nb > 128 || nc < 0 || nc > 8 || nh < 1 || nh > 128 || ns < 1 || ns > 2048)
    throw Error('Unsupported MDL counts');
  check(bi, nb * 112);
  check(ci, nc * 24);
  check(hi, nh * 32);
  check(si, ns * 176);
  check(gi, 104);
  const bones = Array.from({ length: nb }, (_, j) => {
    const p = bi + j * 112;
    return {
      name: str(p, 32),
      parent: i(p + 32),
      controllers: Array.from({ length: 6 }, (_, k) => i(p + 40 + k * 4)),
      value: Array.from({ length: 6 }, (_, k) => f(p + 64 + k * 4)),
      scale: Array.from({ length: 6 }, (_, k) => f(p + 88 + k * 4)),
    };
  });
  bones.forEach((b, j) => {
    if (b.parent >= j || b.parent < -1) throw Error('Invalid bone hierarchy');
  });
  const controllers = Array.from({ length: nc }, (_, j) => {
    const p = ci + j * 24;
    return { type: i(p + 4), start: f(p + 8), end: f(p + 12), index: i(p + 20) };
  });
  const boxes = Array.from({ length: nh }, (_, j) => {
    const p = hi + j * 32,
      bone = i(p);
    if (bone < 0 || bone >= nb) throw Error('Invalid hitbox bone');
    return {
      bone,
      group: i(p + 4),
      mins: [f(p + 8), f(p + 12), f(p + 16)],
      maxs: [f(p + 20), f(p + 24), f(p + 28)],
    };
  });
  const sequences = Array.from({ length: ns }, (_, j) => {
    const p = si + j * 176;
    return {
      index: j,
      name: str(p, 32),
      frames: i(p + 56),
      blends: i(p + 120),
      anim: i(p + 124),
      start: f(p + 136),
      end: f(p + 144),
      group: i(p + 156),
    };
  });
  function pose(
    sequence: number,
    origin: number[],
    yaw: number,
    pitch = 0,
    client = true,
    options: PoseOptions = {},
  ) {
    const seq = sequences[sequence];
    if (seq?.group !== 0 || ![1, 2, 9].includes(seq.blends))
      throw Error('This prototype supports embedded sequences with one, two, or nine blends');
    let blend = 0,
      pa = pitch;
    if (client) {
      blend = Math.trunc(pa * 3);
      if (blend < seq.start) {
        blend = 0;
        pa -= seq.start / 3;
      } else if (blend <= seq.end) {
        blend =
          seq.end - seq.start >= 0.1
            ? Math.trunc(((blend - seq.start) * 255) / (seq.end - seq.start))
            : 127;
        pa = 0;
      } else {
        blend = 255;
        pa -= seq.end / 3;
      }
    }
    const adj = controllers.map((c) => {
      const control = client ? 127 : 0,
        v =
          c.type & 0x8000
            ? (control * 360) / 256 + c.start
            : (1 - control / 255) * c.start + (control / 255) * c.end;
      return F(v * (c.type & 0x38 ? Math.PI / 180 : 1));
    });
    check(seq.anim, nb * 12 * seq.blends);
    function channel(b: number, k: number, bl: number, sequence: Sequence = seq) {
      check(sequence.anim, nb * 12 * sequence.blends);
      if (sequence.group !== 0) throw Error('External animation group is required');
      const p = sequence.anim + (bl * nb + b) * 12,
        off = w(p + k * 2);
      if (!off) return 0;
      const value = p + off;
      check(value, 4);
      if (!u[value + 1] || u[value] > u[value + 1]) throw Error('Invalid MDL animation span');
      return s(value + 2);
    }
    function localPose(b: Bone, j: number, bl: number, sequence: Sequence = seq) {
      const vals = b.value.map((v, k) =>
        F(
          F(v + F(channel(j, k, bl, sequence) * b.scale[k])) +
            (b.controllers[k] >= 0 ? adj[b.controllers[k]] || 0 : 0),
        ),
      );
      return { p: vals.slice(0, 3), q: quaternion(vals.slice(3)) };
    }
    const root = matrix(quaternion([0, 0, (yaw * Math.PI) / 180]), origin);
    if (pa) {
      const p = (-pa * Math.PI) / 180,
        c = Math.cos(p),
        s = Math.sin(p),
        y = (yaw * Math.PI) / 180;
      root.splice(
        0,
        12,
        Math.cos(y) * c,
        -Math.sin(y),
        Math.cos(y) * s,
        origin[0],
        Math.sin(y) * c,
        Math.cos(y),
        Math.sin(y) * s,
        origin[1],
        -s,
        0,
        c,
        origin[2],
      );
    }
    const mix = (a: LocalPose, b: LocalPose, t: number) => ({
      p: a.p.map((v, k) => F(v * (1 - t) + b.p[k] * t)),
      q: slerp(a.q, b.q, t),
    });
    const locals = [];
    for (let j = 0; j < nb; j++) {
      const b = bones[j];
      let a = localPose(b, j, 0);
      if (seq.blends === 2) a = mix(a, localPose(b, j, 1), blend / 255);
      if (seq.blends === 9) {
        const sy = options.yawBlend ?? 127.5,
          pt = options.pitchBlend ?? 127,
          x = sy <= 127 ? sy * 2 : 2 * (sy - 127),
          y = pt <= 127 ? pt * 2 : 2 * (pt - 127),
          base = (sy <= 127 ? 0 : 1) + (pt <= 127 ? 0 : 3);
        a = mix(
          mix(localPose(b, j, base), localPose(b, j, base + 1), x / 255),
          mix(localPose(b, j, base + 3), localPose(b, j, base + 4), x / 255),
          y / 255,
        );
      }
      locals.push(a);
    }
    if (seq.blends === 9 && sequence < 101 && sequence !== 8 && sequence !== 9) {
      const gait = sequences[options.gait ?? 1];
      if (!gait) throw Error('Invalid gait sequence');
      let copy = true;
      for (let j = 0; j < nb; j++) {
        const b = bones[j];
        if (b.name === 'Bip01 Spine') copy = false;
        else if (b.parent >= 0 && bones[b.parent].name === 'Bip01 Pelvis') copy = true;
        if (copy) locals[j] = localPose(b, j, 0, gait);
      }
    }
    const transforms: number[][] = [];
    for (let j = 0; j < nb; j++) {
      const b = bones[j],
        a = locals[j];
      transforms[j] = multiply(b.parent < 0 ? root : transforms[b.parent], matrix(a.q, a.p));
    }
    return {
      transforms,
      boxes: boxes.map((b) => ({ ...b, matrix: transforms[b.bone] })),
      aims: (
        [
          ['spine2', 3],
          ['head', 4],
          ['pelvis', 8],
        ] as [string, number][]
      ).map(([name, dz]) => {
        const index = bones.findIndex((b) => b.name.toLowerCase().endsWith(name));
        if (index < 0) throw Error(`Missing aim bone ${name}`);
        const m = transforms[index];
        return [m[3], m[7], m[11] + dz].map(F);
      }),
    };
  }
  return { buffer, bones, boxes, sequences, pose };
}
