import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const local = fileURLToPath(new URL('../../.local/cs2/de_inferno/', import.meta.url));
export default defineConfig({
  root,
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 8770,
    strictPort: true,
    fs: {
      strict: true,
      allow: [root, fileURLToPath(new URL('../../node_modules', import.meta.url))],
      deny: ['**/.local/**', '**/.git/**', '**/.env*'],
    },
  },
  plugins: [
    {
      name: 'local-cs2-package',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          if (!path?.startsWith('/local/')) return next();
          let name: string;
          try {
            name = decodeURIComponent(path.slice(7));
          } catch {
            res.statusCode = 400;
            res.end();
            return;
          }
          const isRender = /^render\/[a-zA-Z0-9_.-]+\.(gltf|bin|png)$/.test(name);
          const file = resolve(local, name);
          if (
            (name !== 'map.json' && name !== 'map.cs2map' && name !== 'render.json' && !isRender) ||
            !file.startsWith(resolve(local) + sep)
          ) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (!existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404;
            res.end('Run bun run cs2:prepare --render first');
            return;
          }
          const stats = statSync(file);
          // Revalidate private assets on reload without downloading the entire map again.
          const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
          res.setHeader('Cache-Control', 'private, no-cache');
          res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }
          res.setHeader(
            'Content-Type',
            name.endsWith('.json') || name.endsWith('.gltf')
              ? 'application/json'
              : name.endsWith('.png')
                ? 'image/png'
                : 'application/octet-stream',
          );
          res.setHeader('Content-Length', stats.size);
          const stream = createReadStream(file);
          res.once('close', () => stream.destroy());
          stream.on('error', () => res.destroy()).pipe(res);
        });
      },
    },
  ],
  worker: { format: 'es' },
  build: { outDir: '../../.local/cs2-build', emptyOutDir: true, target: 'es2023' },
});
