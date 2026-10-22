// Audit the Git index (the exact bytes that will be committed), never print secrets.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const paths = git('ls-files', '--cached', '-z').toString().split('\0').filter(Boolean);
const blocked =
  /(^|\/)(source|server|downloads|atlas|\.local|node_modules|dist|coverage|\.vite)(\/|$)|^web\/assets\/|^tools\/(reference|zig-[^/]+)\/|\.(go|sma|inc|bsp|mdl|wad|tga|spr|dem|wav|mp3|ogg|zip|7z|exe|dll|amxx|pdb|obj|lib|exp|png|jpe?g|webp|log|pid|pem|key)$|(^|\/)(running\.json(?:\.tmp)?|\.env(?:\..*)?)$|~$/i;
const failures = [];
let total = 0;
for (const p of paths) {
  if (
    blocked.test(p) ||
    /\.(vpk|v[a-z0-9_]+_c|nav|glb|gltf|cs2map|bin)$/i.test(p) ||
    /^tools\/cs2-import\/(bin|obj)\//i.test(p)
  ) {
    failures.push(`${p} [excluded content]`);
    continue;
  }
  const bytes = git('show', `:${p}`);
  total += bytes.length;
  if (p.endsWith('.wasm')) continue;
  const text = bytes.toString('utf8');
  if (
    /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,})\b/.test(
      text,
    ) ||
    /\brcon_password\s+["']?[a-f0-9]{24,}\b/i.test(text) ||
    /^\s*-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(text)
  )
    failures.push(`${p} [possible credential]`);
}
if (!paths.length) failures.push('[empty Git index]');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Repository index check passed: ${paths.length} files, ${total.toLocaleString()} bytes; no blocked assets/artifacts or recognized credentials. This is a targeted packaging check, not a full legal or security audit.`,
  );
