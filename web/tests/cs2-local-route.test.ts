import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { test } from 'vitest';
import { localCs2 } from '../local-cs2';

test('private CS2 route serves WebP and PNG, revalidates, and restricts asset paths', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'wallbang-cs2-route-'));
  const assets = join(folder, 'package');
  await mkdir(join(assets, 'render'), { recursive: true });
  const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  await writeFile(join(assets, 'render/fixture.webp'), webp);
  await writeFile(join(assets, 'render/alpha.png'), 'png fixture');
  await writeFile(join(assets, 'render/not-allowed.txt'), 'private');
  await writeFile(join(folder, 'outside.webp'), 'must stay outside');
  const server = await createServer({
    configFile: false,
    root: folder,
    publicDir: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [localCs2(assets)],
    server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    await server.listen();
    assert.ok(server.httpServer);
    const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/local/render/fixture.webp`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    assert.equal(response.headers.get('content-length'), String(webp.byteLength));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), webp);
    const etag = response.headers.get('etag');
    assert.ok(etag);
    const cached = await fetch(`${base}/local/render/fixture.webp`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    const png = await fetch(`${base}/local/render/alpha.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(await png.text(), 'png fixture');
    for (const path of [
      'render/not-allowed.txt',
      'render/fixture.webp.js',
      'render/missing.webp',
      'render/%2e%2e%2f%2e%2e%2foutside.webp',
      'render/%2e%2e%5c%2e%2e%5coutside.webp',
    ])
      assert.equal((await fetch(`${base}/local/${path}`)).status, 404, path);
    assert.equal((await fetch(`${base}/local/render/%zz.webp`)).status, 400);
  } finally {
    await server.close();
    await rm(folder, { recursive: true, force: true });
  }
});
