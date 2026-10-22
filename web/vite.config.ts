import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { localCs2 } from './local-cs2.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicBuild = process.env.VITE_PUBLIC_BUILD === '1';

// Precache only our built application. Private map files live in IndexedDB,
// never in the deployable bundle or this cache's manifest.
function offlineShell(): Plugin {
  let base = '/';
  return {
    name: 'wallbang-offline-shell',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => name !== 'sw.js')
        .map((name) => `${base}${name}`);
      files.push(base, `${base}index.html`, `${base}manifest.json`, `${base}help.md`);
      for (const name of [
        'GPL-3.0.txt',
        'ReHLDS-LICENSE.txt',
        'ReGameDLL-LICENSE.txt',
        'THREE-LICENSE.txt',
        'OCTICONS-LICENSE.txt',
        'THREE-MESH-BVH-LICENSE.txt',
        'MESHOPTIMIZER-LICENSE.txt',
      ])
        files.push(`${base}licenses/${name}`);
      const version = createHash('sha256')
        .update(readFileSync(new URL('index.html', import.meta.url)))
        .update(readFileSync(new URL('public/help.md', import.meta.url)))
        .update(readFileSync(new URL('public/manifest.json', import.meta.url)))
        .update(base)
        .update(
          Object.values(bundle)
            .map((entry) => (entry.type === 'chunk' ? entry.code : String(entry.source)))
            .join(''),
        )
        .digest('hex')
        .slice(0, 16);
      const worker = bundle['sw.js'];
      if (worker?.type !== 'chunk') throw Error('Missing service-worker entry');
      worker.code = worker.code
        .replaceAll('__WB_PRECACHE__', JSON.stringify([...new Set(files)]))
        .replaceAll('__WB_CACHE_VERSION__', JSON.stringify(`wallbang-browser-${base}-${version}`));
    },
  };
}

export default defineConfig({
  root,
  base: process.env.WB_BASE_PATH || '/',
  publicDir: 'public',
  plugins: [offlineShell(), localCs2()],
  server: {
    host: '127.0.0.1',
    port: 8768,
    strictPort: true,
    fs: {
      strict: true,
      allow: [root, fileURLToPath(new URL('../node_modules', import.meta.url))],
      deny: [
        '**/.git/**',
        '**/.env*',
        '**/running.json',
        '**/atlas/**',
        '**/server/**',
        '**/.local/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'static',
    target: 'es2023',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: (info) => (info.name === 'offline' ? 'sw.js' : 'static/[name]-[hash].js'),
      },
      input: {
        offline: fileURLToPath(new URL('src/service-worker.ts', import.meta.url)),
        app: fileURLToPath(new URL('index.html', import.meta.url)),
        ...(publicBuild
          ? {}
          : {
              textures: fileURLToPath(new URL('tests/texture-render.html', import.meta.url)),
              lamps: fileURLToPath(new URL('tests/lamp-render.html', import.meta.url)),
              skybox: fileURLToPath(new URL('tests/skybox-render.html', import.meta.url)),
              controls: fileURLToPath(new URL('tests/controls-browser.html', import.meta.url)),
            }),
      },
    },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
});
