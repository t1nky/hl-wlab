import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface LocalMap {
  id: string;
  name: string;
  ready: boolean;
  installed: boolean;
}
interface SourceMap extends LocalMap {
  source: string;
  resource: string;
}
export interface PrepareJob {
  id: string;
  map: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  phase: string;
}
export const validMapId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);

/** Read only the VPK directory, never the hundreds of MB of embedded map payload. */
export async function mapResources(file: string): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(28);
    await handle.read(header, 0, 28, 0);
    const version = header.readUInt32LE(4);
    const size = header.readUInt32LE(8);
    if (header.readUInt32LE(0) !== 0x55aa1234 || ![1, 2].includes(version) || size > 32 << 20)
      return [];
    const tree = Buffer.alloc(size);
    const { bytesRead } = await handle.read(tree, 0, size, version === 1 ? 12 : 28);
    if (bytesRead !== size) throw Error('Truncated VPK directory');
    let offset = 0;
    const string = () => {
      const end = tree.indexOf(0, offset);
      if (end < 0) throw Error('Invalid VPK directory');
      const value = tree.toString('utf8', offset, end);
      offset = end + 1;
      return value;
    };
    const maps: string[] = [];
    const physics = new Set<string>();
    for (let extension = string(); extension; extension = string())
      for (let path = string(); path; path = string())
        for (let name = string(); name; name = string()) {
          if (offset + 18 > size || tree.readUInt16LE(offset + 16) !== 0xffff)
            throw Error('Invalid VPK entry');
          const preload = tree.readUInt16LE(offset + 4);
          offset += 18 + preload;
          if (offset > size) throw Error('Truncated VPK preload');
          const resource = `${path === ' ' ? '' : `${path}/`}${name}.vmap`;
          if (name === 'world_physics' && ['vrman_c', 'vphys_c'].includes(extension))
            physics.add(path);
          if (
            extension === 'vmap_c' &&
            /^[a-zA-Z0-9_./-]+\.vmap$/.test(resource) &&
            !resource.includes('..')
          )
            maps.push(resource);
        }
    // VPKs also contain prefab VMAPs, UI scenes and 3D skies. Offer playable
    // worlds with a collision package, rather than all embedded scene assets.
    return maps.filter((map) => physics.has(map.slice(0, -5)));
  } finally {
    await handle.close();
  }
}

async function vpks(folder: string, depth = 0): Promise<string[]> {
  if (depth > 4 || !existsSync(folder)) return [];
  const result: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) result.push(...(await vpks(path, depth + 1)));
    else if (entry.isFile() && /\.vpk$/i.test(entry.name) && !/_\d{3}\.vpk$/i.test(entry.name))
      result.push(path);
  }
  return result;
}

async function chooseFolder(): Promise<string> {
  const command =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-STA',
            '-WindowStyle',
            'Hidden',
            '-Command',
            'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Select Counter-Strike Global Offensive (CS2)"; if ($dialog.ShowDialog() -eq "OK") { [Console]::Write($dialog.SelectedPath) }',
          ],
        ]
      : process.platform === 'darwin'
        ? [
            'osascript',
            ['-e', 'POSIX path of (choose folder with prompt "Select your CS2 installation")'],
          ]
        : ['zenity', ['--file-selection', '--directory', '--title=Select your CS2 installation']];
  return new Promise((done, reject) => {
    const child = spawn(command[0] as string, command[1] as string[], { windowsHide: true });
    let value = '';
    child.stdout.on('data', (chunk: Buffer) => {
      value += chunk.toString();
    });
    child.on('error', () =>
      reject(
        Error('Folder picker unavailable. Set CS2_GAME to your CS2 installation and restart.'),
      ),
    );
    child.on('close', () => done(value.trim()));
  });
}

/** Local development only. Map payloads stay in ignored .local/cs2; one exporter at a time. */
export class LocalCs2Library {
  readonly root: string;
  private readonly repo: string;
  private game = '';
  private sources = new Map<string, SourceMap>();
  private jobs = new Map<string, PrepareJob>();
  private child?: ChildProcess;
  private current?: PrepareJob;
  constructor(root: string, repo: string) {
    this.root = root;
    this.repo = repo;
  }

  private async source() {
    if (this.game) return this.game;
    let saved = '';
    try {
      saved = JSON.parse(await readFile(join(this.root, 'source.json'), 'utf8')).game;
    } catch {
      /* First run. */
    }
    const fallback =
      process.platform === 'win32'
        ? 'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive'
        : '';
    this.game = process.env.CS2_GAME || saved || fallback;
    return this.game;
  }
  async browse() {
    if (this.current?.status === 'running')
      throw Error('Wait for map preparation to finish before changing the source');
    const selected = await chooseFolder();
    if (!selected) return this.catalog();
    const game = resolve(selected);
    if (!existsSync(join(game, 'game/csgo/steam.inf')))
      throw Error('Choose the Counter-Strike Global Offensive folder containing game/csgo');
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, 'source.json'), JSON.stringify({ game }));
    this.game = game;
    return this.catalog();
  }
  async catalog() {
    const game = await this.source();
    const available = existsSync(join(game, 'game/csgo/steam.inf'));
    const sources = new Map<string, SourceMap>();
    if (available) {
      const files = [
        ...(await vpks(join(game, 'game/csgo/maps'))),
        ...(await vpks(join(dirname(dirname(game)), 'workshop/content/730'))),
      ].sort();
      for (const file of files) {
        let resources: string[];
        try {
          resources = await mapResources(file);
        } catch {
          continue;
        }
        const primary = resources.filter(
          (r) => r === `maps/${basename(file, '.vpk').replace(/_dir$/, '')}.vmap`,
        );
        resources = primary.length
          ? primary
          : resources.filter(
              (r) =>
                /^maps\/[^/]+\.vmap$/.test(r) ||
                (file.includes(`${join('workshop', 'content', '730')}`) &&
                  !/^maps\/(prefabs|ui|templates)\//.test(r)),
            );
        for (const resource of resources) {
          const name = basename(resource, '.vmap');
          let id = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
          if (!validMapId(id)) continue;
          if (sources.has(id))
            id += `-${createHash('sha256')
              .update(file + resource)
              .digest('hex')
              .slice(0, 8)}`;
          sources.set(id, {
            id,
            name,
            source: file,
            resource,
            ready: this.ready(id),
            installed: true,
          });
        }
      }
    }
    this.sources = sources;
    const maps: LocalMap[] = [...sources.values()].map(({ id, name, ready, installed }) => ({
      id,
      name,
      ready,
      installed,
    }));
    if (existsSync(this.root))
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          !validMapId(entry.name) ||
          !this.ready(entry.name) ||
          maps.some((m) => m.id === entry.name)
        )
          continue;
        try {
          const meta = JSON.parse(await readFile(join(this.root, entry.name, 'map.json'), 'utf8'));
          maps.push({ id: entry.name, name: meta.map, ready: true, installed: false });
        } catch {
          /* An interrupted/unrecognized package is not a loadable map. */
        }
      }
    maps.sort((a, b) => a.name.localeCompare(b.name));
    return {
      maps,
      sourceAvailable: available,
      preparing: this.current?.status === 'running' ? this.current : undefined,
    };
  }
  private ready(id: string) {
    try {
      const folder = join(this.root, id);
      const map = JSON.parse(readFileSync(join(folder, 'map.json'), 'utf8'));
      const render = JSON.parse(readFileSync(join(folder, 'render.json'), 'utf8'));
      const player = JSON.parse(readFileSync(join(folder, 'player.json'), 'utf8'));
      return (
        map.schema === 1 &&
        render.schema === 1 &&
        render.compression?.codec === 'EXT_meshopt_compression v0' &&
        map.fingerprint === render.collisionFingerprint &&
        map.steamInf === player.steamInf &&
        statSync(join(folder, 'map.cs2map')).size === map.binaryBytes &&
        Array.isArray(render.files) &&
        render.files.every(
          (f: { path: string; bytes: number }) =>
            /^render\/[a-zA-Z0-9_.-]+$/.test(f.path) &&
            statSync(join(folder, f.path)).size === f.bytes,
        )
      );
    } catch {
      return false;
    }
  }
  job(id: string) {
    return this.jobs.get(id);
  }
  private running() {
    return this.current?.status === 'running' ? this.current : undefined;
  }
  async prepare(id: string) {
    if (!validMapId(id)) throw Error('Invalid map ID');
    const active = this.running();
    if (active) return active;
    if (this.child) throw Error('Previous preparation is stopping. Retry in a moment.');
    await this.catalog();
    // Another request may have entered while discovery was awaiting disk I/O.
    const concurrent = this.running();
    if (this.child || concurrent) {
      if (concurrent) return concurrent;
      throw Error('Another map is being prepared. Wait or cancel it first.');
    }
    const source = this.sources.get(id);
    // A transferred prepared library works on a computer without Steam or CS2.
    if (!source && this.ready(id))
      return {
        id: '',
        map: id,
        status: 'complete',
        phase: 'Cached map ready',
      } satisfies PrepareJob;
    if (!source) throw Error('Map not found in the selected CS2 installation');
    const job: PrepareJob = {
      id: randomUUID(),
      map: id,
      status: 'running',
      phase: 'Preparing player poses and map…',
    };
    // A second tab may still be polling the previous completed job.
    while (this.jobs.size >= 16) {
      const oldest = this.jobs.keys().next().value;
      if (oldest) this.jobs.delete(oldest);
    }
    this.jobs.set(job.id, job);
    this.current = job;
    const child = spawn(
      process.execPath,
      [
        join(this.repo, 'tools/cs2-prepare.mjs'),
        `--game=${this.game}`,
        `--map=${id}`,
        `--source=${source.source}`,
        `--resource=${source.resource}`,
        '--render',
        '--with-player',
      ],
      { cwd: this.repo, windowsHide: true, detached: process.platform !== 'win32' },
    );
    this.child = child;
    let tail = '';
    let pending = '';
    const progress = (data: Buffer) => {
      tail = (tail + data.toString()).slice(-4000);
      pending += data.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      const line = lines.filter((s) => s.trim()).at(-1);
      if (line && job.status === 'running') job.phase = line.slice(0, 240);
    };
    child.stdout?.on('data', progress);
    child.stderr?.on('data', progress);
    child.once('error', (error) => {
      job.status = 'error';
      job.phase = error.message;
    });
    child.once('close', (code) => {
      if (this.child === child) this.child = undefined;
      if (job.status !== 'running') return;
      job.status = code === 0 && this.ready(id) ? 'complete' : 'error';
      job.phase =
        job.status === 'complete'
          ? 'Map ready'
          : tail.trim().slice(-1200) ||
            'Map preparation failed. Install the .NET 10 SDK and retry.';
    });
    return job;
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    const child = this.child;
    if (job?.status !== 'running' || !child?.pid) return;
    job.status = 'cancelled';
    job.phase = 'Preparation cancelled';
    const stopped = new Promise<void>((done) => child.once('close', () => done()));
    if (process.platform === 'win32')
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => child.kill());
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    }
    await stopped;
  }
  close() {
    if (this.current) void this.cancel(this.current.id);
  }
}
