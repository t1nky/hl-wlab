// Production-only static host. Private game files are a separate local mount.
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const inside = (root, path) => path === root || path.startsWith(root + sep);
export function createLabServer({
  dist = resolve(project, 'web/dist'),
  assets = resolve(project, 'web/assets'),
} = {}) {
  const root = realpathSync(dist);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Wallbang-Lab', 'vite');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw Error();
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const privateAsset = pathname.startsWith('/assets/');
    let mount = root;
    try {
      if (privateAsset) mount = await realpath(assets);
    } catch {
      res.writeHead(404);
      res.end('Import your own game files.');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const relative = privateAsset ? pathname.slice('/assets'.length) : pathname;
    let path = resolve(mount, `.${relative}`);
    if (!inside(mount, path)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      path = await realpath(path);
      if (!inside(mount, path)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) throw Error();
      const immutable = !privateAsset && pathname.startsWith('/static/');
      const etag = `W/"${info.size}-${info.mtimeMs}"`;
      res.setHeader(
        'Cache-Control',
        immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Content-Length': info.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end('File not found');
      } else res.destroy();
    }
  });
}
function invokedDirectly() {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  const port = Number(process.argv[2] || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Usage: bun run start [port 1..65535]');
  let server;
  try {
    server = createLabServer();
  } catch {
    console.error('Build the app first: bun install --frozen-lockfile && bun run build');
    process.exitCode = 1;
  }
  if (server) {
    server.on('error', (e) => {
      console.error(
        e.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another port.` : e.message,
      );
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () =>
      console.log(`Wallbang Lab: http://127.0.0.1:${port}/\nCtrl+C stops the local host.`),
    );
  }
}
