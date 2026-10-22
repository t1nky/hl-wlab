import { createReadStream, existsSync } from 'node:fs';
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
          const name = path.slice(7);
          if (name !== 'map.json' && name !== 'map.cs2map') {
            res.statusCode = 404;
            res.end();
            return;
          }
          const file = `${local}${name}`;
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.end('Run bun run cs2:prepare first');
            return;
          }
          res.setHeader(
            'Content-Type',
            name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          );
          res.setHeader('Cache-Control', 'private, no-store');
          createReadStream(file)
            .on('error', () => res.destroy())
            .pipe(res);
        });
      },
    },
  ],
  worker: { format: 'es' },
  build: { outDir: '../../.local/cs2-build', emptyOutDir: true, target: 'es2023' },
});
