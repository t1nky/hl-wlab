import type { GameFile } from './library-types.ts';

const roots = ['cstrike', 'cstrike_downloads', 'valve'];
const player = /^models\/player\/(leet|urban|gign|gsg9|sas|arctic|guerilla|terror|vip)\/\1\.mdl$/;
export function gamePath(input: string): string | null {
  const parts = input.replaceAll('\\', '/').toLowerCase().split('/');
  if (parts.some((p) => p === '..' || p === '.' || !p)) return null;
  const root = parts.findIndex((p) => roots.includes(p));
  if (root < 0) return null;
  const path = parts.slice(root + 1).join('/');
  const mod = parts[root] !== 'valve';
  if (
    (mod && /^maps\/[^/]+\.bsp$/.test(path)) ||
    (mod && (path === 'models/player.mdl' || player.test(path))) ||
    path === 'sound/materials.txt' ||
    /^[^/]+\.wad$/.test(path) ||
    /^gfx\/env\/[a-z0-9_-]+(?:rt|bk|lf|ft|up|dn)\.tga$/.test(path)
  )
    return parts.slice(root).join('/');
  return null;
}
export function chooseFiles(files: GameFile[]) {
  const byPath = new Map<string, GameFile>();
  for (const source of files) {
    const path = gamePath(source.path);
    if (!path) continue;
    if (byPath.has(path)) throw Error(`Duplicate game file: ${path}`);
    byPath.set(path, { path, file: source.file });
  }
  // Deterministic priority: installed CS files, downloaded CS additions, then
  // base Half-Life resources. Source enumeration order never decides a winner.
  const ordered = [...byPath.values()].sort(
    (a, b) =>
      roots.indexOf(a.path.split('/')[0]) - roots.indexOf(b.path.split('/')[0]) ||
      a.path.localeCompare(b.path),
  );
  const maps = new Map<string, GameFile>(),
    wads = new Map<string, GameFile>(),
    skies = new Map<string, GameFile>();
  const models: GameFile[] = [];
  let materials: GameFile | undefined;
  for (const source of ordered) {
    const relative = source.path.slice(source.path.indexOf('/') + 1);
    const filename = relative.split('/').at(-1) || '';
    if (relative.startsWith('maps/')) {
      if (!maps.has(filename)) maps.set(filename, source);
    } else if (relative.endsWith('.mdl')) models.push(source);
    else if (relative === 'sound/materials.txt') materials ||= source;
    else if (relative.endsWith('.wad')) {
      if (!wads.has(filename)) wads.set(filename, source);
    } else if (relative.startsWith('gfx/env/')) {
      if (!skies.has(filename)) skies.set(filename, source);
    }
  }
  models.sort(
    (a, b) =>
      Number(!a.path.endsWith('/models/player.mdl')) -
      Number(!b.path.endsWith('/models/player.mdl')),
  );
  if (!maps.size)
    throw Error(
      'No Counter-Strike maps found. Choose Half-Life (containing cstrike), or cstrike itself.',
    );
  if (!models.length)
    throw Error(
      'No CS player model found in cstrike/models. Choose the complete Half-Life folder.',
    );
  if (!materials) throw Error('Missing sound/materials.txt. Choose the complete Half-Life folder.');
  return { maps: [...maps.values()], models, materials, wads, skies };
}

export function filesFromUpload(files: FileList | File[]): GameFile[] {
  const selected: GameFile[] = [];
  for (const file of Array.from(files)) {
    const path = gamePath(file.webkitRelativePath || file.name);
    if (path) selected.push({ path, file });
  }
  return selected;
}

export function mapDependencies(buffer: ArrayBuffer) {
  const d = new DataView(buffer);
  if (buffer.byteLength < 124 || buffer.byteLength > 32 * 1048576 || d.getInt32(0, true) !== 30)
    throw Error('Expected GoldSrc BSP v30 (maximum 32 MiB)');
  for (let j = 0; j < 15; j++) {
    const p = d.getInt32(4 + j * 8, true),
      n = d.getInt32(8 + j * 8, true);
    if (p < 0 || n < 0 || p > buffer.byteLength - n) throw Error('Invalid BSP lump');
  }
  const offset = d.getInt32(4, true),
    length = d.getInt32(8, true);
  const text = new TextDecoder().decode(new Uint8Array(buffer, offset, length));
  const world =
    [...text.matchAll(/\{([^{}]*)\}/g)].find((m) => /"classname"\s*"worldspawn"/.test(m[1]))?.[1] ||
    '';
  const sky = world.match(/"skyname"\s*"([^"\r\n]*)"/i)?.[1] || 'desert';
  if (!/^[a-z0-9_-]{1,64}$/i.test(sky)) throw Error('Unsupported skybox name');
  const wads = (world.match(/"wad"\s*"([^"\r\n]*)"/i)?.[1] || '')
    .split(';')
    .map((path) => path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() || '')
    .filter((name) => /^[^/:]+\.wad$/.test(name));
  const tp = d.getInt32(20, true),
    tn = d.getInt32(24, true);
  if (tn < 4) throw Error('Missing BSP texture index');
  const count = d.getInt32(tp, true);
  if (count < 0 || count > 4096 || 4 + count * 4 > tn) throw Error('Invalid BSP texture index');
  const external: string[] = [];
  for (let j = 0; j < count; j++) {
    const at = d.getInt32(tp + 4 + j * 4, true);
    if (at < 0) continue;
    if (at > tn - 40) throw Error('Invalid BSP texture header');
    if (d.getUint32(tp + at + 24, true) === 0)
      external.push(
        new TextDecoder()
          .decode(new Uint8Array(buffer, tp + at, 16))
          .split('\0')[0]
          .toLowerCase(),
      );
  }
  return { sky: sky.toLowerCase(), wads: external.length ? [...new Set(wads)] : [], external };
}
