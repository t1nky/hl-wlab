// A Pages artifact must contain only the built program, notices and matching source.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../web/dist/', import.meta.url);
const base = process.env.WB_BASE_PATH || '/';
const paths = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).replaceAll('\\', '/'));
const allowed = /\.(?:html|js|css|wasm|json|md|txt)$|\/source\.tar\.gz$/;
for (const path of paths) {
  assert.ok(allowed.test(path), `Unexpected public artifact: ${path}`);
  assert.ok(!/\/(?:assets|atlas|server|downloads|node_modules)\//.test(path));
}
const html = readFileSync(new URL('index.html', root), 'utf8');
const worker = readFileSync(new URL('sw.js', root), 'utf8');
assert.ok(html.includes(`${base}static/`), 'Application entry must use the deployment base');
assert.ok(!worker.includes('__WB_PRECACHE__'), 'Offline manifest was not replaced');
const precache = JSON.parse(worker.match(/new Set\((\[[^;]+?\])\)/)?.[1] ?? 'null');
assert.ok(Array.isArray(precache), 'Missing offline manifest');
for (const path of precache) {
  assert.ok(path.startsWith(base), `Offline path escapes deployment base: ${path}`);
  assert.ok(!path.includes('/assets/'), 'Private assets must not be precached');
}
assert.ok(precache.includes(base), 'Offline navigation must include the site root');
assert.ok(precache.includes(`${base}help.md`), 'Help must be available offline');
console.log(`Pages artifact check passed: ${paths.length} files; base ${base}; no game assets.`);
