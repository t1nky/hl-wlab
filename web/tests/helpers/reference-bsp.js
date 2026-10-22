// GoldSrc BSP v30 import. Render geometry is never used as the collision oracle.
export function readBSP(buffer) {
  const d = new DataView(buffer),
    u = new Uint8Array(buffer),
    i = (p) => d.getInt32(p, true),
    w = (p) => d.getUint16(p, true),
    f = (p) => d.getFloat32(p, true);
  if (buffer.byteLength < 124 || buffer.byteLength > 32 * 1024 * 1024 || i(0) !== 30)
    throw Error('Expected a GoldSrc BSP v30 file (maximum 32 MiB).');
  const stride = [1, 20, 1, 12, 1, 24, 40, 20, 1, 8, 28, 2, 4, 4, 64],
    l = [];
  for (let j = 0; j < 15; j++) {
    const p = i(4 + j * 8),
      n = i(8 + j * 8);
    if (p < 0 || n < 0 || p > buffer.byteLength - n || n % stride[j])
      throw Error(`Invalid BSP lump ${j}`);
    l.push({ p, n });
  }
  const range = (j, k, n) => {
      if (k < 0 || k + n > l[j].n) throw Error(`Invalid BSP index in lump ${j}`);
      return l[j].p + k;
    },
    v = (p) => [f(p), f(p + 4), f(p + 8)],
    text = (p, n) => new TextDecoder().decode(u.subarray(p, p + n)).split('\0')[0];
  const entities = [];
  const raw = text(l[0].p, l[0].n);
  for (const match of raw.matchAll(/\{([^{}]*)\}/g)) {
    const e = {};
    for (const kv of match[1].matchAll(/"([^"\r\n]*)"\s*"([^"\r\n]*)"/g)) e[kv[1]] = kv[2];
    entities.push(e);
  }
  const textures = [];
  if (l[2].n < 4) throw Error('BSP has no texture index');
  const nt = i(l[2].p);
  if (nt < 0 || nt > 4096 || 4 + nt * 4 > l[2].n) throw Error('Invalid texture count');
  for (let j = 0; j < nt; j++) {
    const off = i(l[2].p + 4 + j * 4);
    if (off < 0) {
      textures.push({ name: 'missing', width: 16, height: 16 });
      continue;
    }
    const p = range(2, off, 40),
      width = i(p + 16),
      height = i(p + 20),
      mip = i(p + 24);
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096)
      throw Error('Invalid texture dimensions');
    let rgba = null;
    if (mip) {
      const size = width * height,
        idx = range(2, off + mip, size),
        pal = range(2, off + i(p + 36) + (size >> 6), 2 + 768) + 2;
      rgba = new Uint8Array(size * 4);
      for (let k = 0; k < size; k++) {
        const c = u[idx + k];
        rgba[k * 4] = u[pal + c * 3];
        rgba[k * 4 + 1] = u[pal + c * 3 + 1];
        rgba[k * 4 + 2] = u[pal + c * 3 + 2];
        rgba[k * 4 + 3] = text(p, 16).startsWith('{') && c === 255 ? 0 : 255;
      }
    }
    textures.push({ name: text(p, 16), width, height, rgba });
  }
  const brushes = [];
  for (let j = 0; j < l[14].n / 64; j++) {
    const p = l[14].p + j * 64,
      ent = entities.find((e) => e.model === `*${j}`),
      cls = ent?.classname || '';
    const origin = (ent?.origin || '0 0 0').split(/\s+/).map(Number),
      angles = (ent?.angles || `0 ${ent?.angle || 0} 0`).split(/\s+/).map(Number);
    if (
      origin.length !== 3 ||
      angles.length !== 3 ||
      ![...origin, ...angles].every(Number.isFinite)
    )
      throw Error('Invalid brush transform');
    const solid =
      j === 0 ||
      (!!ent &&
        !cls.startsWith('trigger_') &&
        ![
          'func_illusionary',
          'func_ladder',
          'func_buyzone',
          'func_bomb_target',
          'func_hostage_rescue',
        ].includes(cls));
    brushes.push({
      index: j,
      origin,
      angles,
      solid,
      classname: cls,
      first: i(p + 56),
      count: i(p + 60),
      mins: v(p),
      maxs: v(p + 12),
    });
  }
  const faces = [];
  for (const b of brushes) {
    if (b.first < 0 || b.count < 0 || b.first + b.count > l[7].n / 20)
      throw Error('Invalid model face range');
    for (let j = b.first; j < b.first + b.count; j++) {
      const p = l[7].p + j * 20,
        pp = range(1, w(p) * 20, 20),
        normal = v(pp).map((x) => (w(p + 2) ? -x : x)),
        edge = i(p + 4),
        ne = w(p + 8),
        ti = range(6, w(p + 10) * 40, 40),
        texture = i(ti + 32),
        sv = v(ti),
        tv = v(ti + 16),
        so = f(ti + 12),
        to = f(ti + 28),
        points = [],
        uv = [];
      if (ne < 3 || ne > 256) throw Error('Invalid face edge count');
      for (let k = 0; k < ne; k++) {
        const se = i(range(13, (edge + k) * 4, 4)),
          ep = range(12, Math.abs(se) * 4, 4),
          vertex = w(ep + (se < 0 ? 2 : 0)),
          pos = v(range(3, vertex * 12, 12));
        if (!pos.every(Number.isFinite)) throw Error('Invalid vertex');
        points.push(pos);
        uv.push([
          pos.reduce((a, x, c) => a + x * sv[c], so),
          pos.reduce((a, x, c) => a + x * tv[c], to),
        ]);
      }
      faces.push({ index: j, brush: b.index, normal, texture, points, uv });
    }
  }
  return {
    buffer,
    entities,
    textures,
    brushes,
    faces,
    world: brushes[0],
    name: entities[0]?.message || 'Imported BSP',
  };
}
export function materialTable(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z])\s+(\S+)/);
    if (m) map.set(m[2].toLowerCase(), m[1].toUpperCase().charCodeAt(0));
  }
  return map;
}
export function textureMaterial(name, table) {
  name = name.toLowerCase();
  if (name[0] === '-' || name[0] === '+') name = name.slice(2);
  if (['{', '!', '~', ' '].includes(name[0])) name = name.slice(1);
  return table.get(name) || 67;
}
export function brushMatrix(b) {
  const [p, y, r] = b.angles.map((x) => (x * Math.PI) / 180),
    cp = Math.cos(p),
    sp = Math.sin(p),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cr = Math.cos(r),
    sr = Math.sin(r);
  return [
    cp * cy,
    sr * sp * cy - cr * sy,
    cr * sp * cy + sr * sy,
    b.origin[0],
    cp * sy,
    sr * sp * sy + cr * cy,
    cr * sp * sy - sr * cy,
    b.origin[1],
    -sp,
    sr * cp,
    cr * cp,
    b.origin[2],
  ];
}
export function transform(m, v) {
  return [0, 1, 2].map((j) =>
    Math.fround(m[j * 4] * v[0] + m[j * 4 + 1] * v[1] + m[j * 4 + 2] * v[2] + m[j * 4 + 3]),
  );
}
// World-aligned grid plus a centroid for narrow standable ledges. Origins are
// float32 canonical; spacing is intentionally absent from cache keys.
export function* candidates(bsp, spacing, radius, target) {
  const seen = new Set(),
    r2 = radius * radius;
  function* emit(p, n) {
    if ((p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 > r2) return;
    p[2] += (16 * (Math.abs(n[0]) + Math.abs(n[1]))) / n[2];
    p = p.map(Math.fround);
    const key = p.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      yield p;
    }
  }
  for (const face of bsp.faces) {
    const b = bsp.brushes[face.brush];
    if (!b.solid || bsp.textures[face.texture]?.name.toLowerCase() === 'sky') continue;
    const m = brushMatrix(b),
      n = transform([...m.slice(0, 3), 0, ...m.slice(4, 7), 0, ...m.slice(8, 11), 0], face.normal);
    if (n[2] < 0.7) continue;
    const p = face.points.map((v) => transform(m, v)),
      lo = [0, 1].map((j) => Math.min(...p.map((v) => v[j]))),
      hi = [0, 1].map((j) => Math.max(...p.map((v) => v[j])));
    if (
      hi[0] < target[0] - radius ||
      lo[0] > target[0] + radius ||
      hi[1] < target[1] - radius ||
      lo[1] > target[1] + radius
    )
      continue;
    const dist = p[0].reduce((a, x, j) => a + x * n[j], 0);
    for (
      let y = Math.ceil(Math.max(lo[1], target[1] - radius) / spacing) * spacing;
      y <= Math.min(hi[1], target[1] + radius);
      y += spacing
    ) {
      const xs = [];
      for (let j = 0, k = p.length - 1; j < p.length; k = j++) {
        const a = p[j],
          c = p[k];
        if (a[1] > y !== c[1] > y) xs.push(((c[0] - a[0]) * (y - a[1])) / (c[1] - a[1]) + a[0]);
      }
      xs.sort((a, b) => a - b);
      const w = Math.sqrt(Math.max(0, r2 - (y - target[1]) ** 2));
      for (let j = 0; j + 1 < xs.length; j += 2)
        for (
          let x = Math.ceil(Math.max(xs[j], target[0] - w) / spacing) * spacing;
          x <= Math.min(xs[j + 1], target[0] + w) && x < xs[j + 1];
          x += spacing
        )
          yield* emit([x, y, (dist - n[0] * x - n[1] * y) / n[2]], n);
    }
    yield* emit(
      [0, 1, 2].map((j) => p.reduce((a, v) => a + v[j] / p.length, 0)),
      n,
    );
  }
}
