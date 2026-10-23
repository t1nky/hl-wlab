import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { LocalCs2Library, validMapId } from './local-cs2-library.ts';

const local = fileURLToPath(new URL('../.local/cs2/de_inferno/', import.meta.url));
/** Dev-only, loopback local package route. Never copies assets into build output. */
export function localCs2(packageRoot = local): Plugin {
  const libraryRoot = dirname(packageRoot);
  const library = new LocalCs2Library(libraryRoot, fileURLToPath(new URL('../', import.meta.url)));
  return {
    name: 'local-cs2-package',
    configureServer(server) {
      server.httpServer?.once('close', () => library.close());
      server.middlewares.use(async (req, res, next) => {
        // Immutable collision/BVH arrays are shared by the bounded CS2 scan pool.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        const path = req.url?.split('?')[0];
        if (!path?.startsWith('/local/')) return next();
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(value));
        };
        // Local preparation can read a selected installation and start a process. Keep
        // every private route on loopback; mutations additionally require our origin.
        let host: URL;
        try {
          host = new URL(`http://${req.headers.host}`);
        } catch {
          return send({ error: 'Invalid host' }, 403);
        }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname))
          return send({ error: 'Loopback only' }, 403);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.method !== 'POST' || req.headers.origin !== host.origin)
            return send({ error: 'Same-origin POST required' }, 403);
        }
        try {
          if (path === '/local/catalog.json' && req.method === 'GET')
            return send(await library.catalog());
          if (path === '/local/library/browse' && req.method === 'POST')
            return send(await library.browse());
          const prepare = path.match(/^\/local\/prepare\/([a-zA-Z0-9_-]+)$/);
          if (prepare) {
            if (req.method === 'POST') return send(await library.prepare(prepare[1]), 202);
            const job = library.job(prepare[1]);
            return job ? send(job) : send({ error: 'Preparation not found' }, 404);
          }
          const cancel = path.match(/^\/local\/cancel\/([a-zA-Z0-9_-]+)$/);
          if (cancel && req.method === 'POST') {
            await library.cancel(cancel[1]);
            return send({ cancelled: true });
          }
        } catch (error) {
          return send({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return send({ error: 'Read-only asset' }, 405);
        let name: string;
        let root = packageRoot;
        try {
          name = decodeURIComponent(path.slice(7));
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        if (name.startsWith('maps/')) {
          const match = name.match(/^maps\/([^/]+)\/(.+)$/);
          if (!match || !validMapId(match[1])) return send({ error: 'Invalid map path' }, 404);
          root = resolve(libraryRoot, match[1]);
          name = match[2];
        }
        const isRender =
          /^render\/[a-zA-Z0-9_.-]+\.(gltf|bin|png|webp|bc4\.gz|bc6h\.gz|r8\.gz)$/.test(name);
        const file = resolve(root, name);
        if (
          (name !== 'map.json' &&
            name !== 'map.cs2map' &&
            name !== 'render.json' &&
            name !== 'player.json' &&
            !isRender) ||
          !file.startsWith(resolve(root) + sep)
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('Choose a CS2 map from the map library first');
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
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy()).pipe(res);
      });
    },
  };
}
