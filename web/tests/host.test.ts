import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createLabServer } from '../../tools/serve-web.mjs';

test('production host isolates private assets, revalidates files and rejects escaped paths', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'wallbang-host-'));
  const dist = join(folder, 'dist'),
    assets = join(folder, 'assets');
  await mkdir(join(dist, 'static'), { recursive: true });
  await mkdir(assets);
  await mkdir(join(folder, 'outside'));
  await writeFile(join(dist, 'index.html'), '<title>Fixture</title>');
  await writeFile(join(dist, 'static/test.js'), 'export const fixture = true;');
  await writeFile(join(assets, 'fixture.txt'), 'local fixture');
  await writeFile(join(folder, 'outside/private.txt'), 'must stay outside');
  await symlink(
    join(folder, 'outside'),
    join(dist, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const server = createLabServer({ dist, assets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    const local = await fetch(`${base}/assets/fixture.txt`);
    assert.equal(await local.text(), 'local fixture');
    assert.equal(local.headers.get('cache-control'), 'no-cache');
    const script = await fetch(`${base}/static/test.js`, { method: 'HEAD' });
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await script.text(), '');
    assert.equal(
      (
        await fetch(`${base}/static/test.js`, {
          headers: { 'If-None-Match': script.headers.get('etag') ?? '' },
        })
      ).status,
      304,
    );
    assert.equal((await fetch(`${base}/running.json`)).status, 404);
    assert.equal((await fetch(`${base}/src/main.ts`)).status, 404);
    assert.equal((await fetch(`${base}/escape/private.txt`)).status, 403);
    assert.equal((await fetch(`${base}/assets/%2e%2e%2foutside/private.txt`)).status, 403);
    assert.equal((await fetch(`${base}/%00`)).status, 400);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
