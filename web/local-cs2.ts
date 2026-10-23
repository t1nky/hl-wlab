import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const local = fileURLToPath(new URL('../.local/cs2/de_inferno/', import.meta.url));
/** Dev-only, loopback local package route. Never copies assets into build output. */
export function localCs2(packageRoot = local): Plugin {
  return {
    name: 'local-cs2-package',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Immutable collision/BVH arrays are shared by the bounded CS2 scan pool.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
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
        const isRender = /^render\/[a-zA-Z0-9_.-]+\.(gltf|bin|png|webp|bc4\.gz)$/.test(name);
        const file = resolve(packageRoot, name);
        if (
          (name !== 'map.json' &&
            name !== 'map.cs2map' &&
            name !== 'render.json' &&
            name !== 'player.json' &&
            !isRender) ||
          !file.startsWith(resolve(packageRoot) + sep)
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
              : name.endsWith('.webp')
                ? 'image/webp'
                : 'application/octet-stream',
        );
        res.setHeader('Content-Length', stats.size);
        const stream = createReadStream(file);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy()).pipe(res);
      });
    },
  };
}
