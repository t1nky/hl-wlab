import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { localCs2 } from '../local-cs2.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite-wlab-cs2', import.meta.url)),
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
  plugins: [localCs2()],
  worker: { format: 'es' },
  build: { outDir: '../../.local/cs2-build', emptyOutDir: true, target: 'es2023' },
});
