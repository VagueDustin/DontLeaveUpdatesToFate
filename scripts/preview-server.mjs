/**
 * preview-server.mjs: serves the design harness (`src/renderer/preview.html`) in a plain browser.
 *
 * Separate from `electron-vite dev` because the harness deliberately runs WITHOUT Electron: it stubs
 * the preload bridge so UI states that are awkward to reach on demand, a run mid-flight, a run that
 * ended in a permission failure, the settings sheet, can be inspected and screenshotted directly.
 *
 *   node scripts/preview-server.mjs   →   http://localhost:5199/preview.html?state=running
 *
 * States: running | finished | settings | update | empty
 */

import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  configFile: false,
  root: resolve(ROOT, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(ROOT, 'src/renderer/src'),
      '@shared': resolve(ROOT, 'src/shared'),
    },
  },
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});

await server.listen();
console.log('READY http://localhost:5199/preview.html?state=running');
