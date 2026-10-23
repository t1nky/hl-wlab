// Local-only exact browser benchmark. Never serves private assets outside loopback.
// First generate reference rows with cs2-collision-bench (see docs/cs2-poc.md).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = '.local/perf-scan-2048-20261022';
mkdirSync(root, { recursive: true });
const revision = '2438bab';
for (const name of [
  'collision',
  'scan',
  'damage',
  'types',
  'target-intersection',
  'trace-ray',
  'worker',
]) {
  let source = execFileSync('git', ['show', `${revision}:web/cs2/${name}.ts`], {
    encoding: 'utf8',
  });
  for (const dependency of [
    'collision',
    'scan',
    'damage',
    'types',
    'target-intersection',
    'trace-ray',
  ])
    source = source.replaceAll(`'./${dependency}'`, `'./reference-${dependency}'`);
  source = source
    .replaceAll("'../src/", "'../../web/src/")
    .replaceAll("'./movement'", "'../../web/cs2/movement'");
  writeFileSync(`${root}/reference-${name}.ts`, source);
}
for (const [name, entrypoint] of [
  ['baseline', `${root}/reference-worker.ts`],
  ['current', 'web/cs2/worker.ts'],
  ['part', 'web/cs2/scan-part.worker.ts'],
]) {
  const result = await Bun.build({ entrypoints: [entrypoint], target: 'browser', minify: true });
  if (!result.success) throw Error(JSON.stringify(result.logs));
  writeFileSync(
    `${root}/${name}-worker.js`,
    (await result.outputs[0].text()).replaceAll(
      './scan-part.worker.ts',
      '/benchmark-part-worker.js',
    ),
  );
}
const reference = `${root}/head2438bab-before-exact2048-cold.f32`;
if (!existsSync(reference)) throw Error('Generate HEAD2438bab exact2048 baseline rows first');
const port = Number(process.env.CS2_BROWSER_BENCH_PORT ?? 8772);
const upstream = Number(process.env.CS2_DEV_PORT ?? 8768);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const worker = /^\/benchmark-(baseline|current|part)-worker\.js$/.exec(url.pathname);
    if (worker)
      return new Response(Bun.file(`${root}/${worker[1]}-worker.js`), {
        headers: {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        },
      });
    if (url.pathname === '/benchmark-reference.f32')
      return new Response(Bun.file(reference), { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname === '/benchmark-report' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin)
        return new Response('Origin denied', { status: 403 });
      const label = url.searchParams.get('label');
      if (!label || !/^[\w-]+$/.test(label)) return new Response('Invalid label', { status: 400 });
      writeFileSync(resolve(root, `${label}.json`), JSON.stringify(await request.json(), null, 2));
      return new Response('Saved');
    }
    if (request.method !== 'GET') return new Response('Method denied', { status: 405 });
    url.port = String(upstream);
    const response = await fetch(url);
    const headers = new Headers(response.headers);
    if (headers.get('content-type')?.includes('text/html')) {
      // Concurrent checkout edits must not reload and lose an in-flight measurement.
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(
        (await response.text()).replace(
          /<script type="module" src="\/@vite\/client"><\/script>/g,
          '',
        ),
        { status: response.status, headers },
      );
    }
    return new Response(response.body, { status: response.status, headers });
  },
});
console.log(`Browser benchmark: http://localhost:${server.port}/tests/cs2-scan-benchmark.html`);
console.log('Console: await runScanBenchmark([1], "browser-baseline", "baseline")');
console.log('Then: await runScanBenchmark([1, 2, 4], "browser-current", "current")');
