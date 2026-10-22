// Local-only map preparation. No game files or exports are uploaded.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const game =
  process.argv.find((arg) => arg.startsWith('--game='))?.slice(7) ||
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive';
const result = spawnSync(
  'dotnet',
  [
    'run',
    '--project',
    'tools/cs2-import',
    '--',
    game,
    fileURLToPath(new URL('../.local/cs2/de_inferno', import.meta.url)),
    ...(process.argv.includes('--force') ? ['--force'] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
