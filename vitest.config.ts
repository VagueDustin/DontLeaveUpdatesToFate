import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Component tests render TSX with the same automatic JSX runtime the app uses.
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The parsers import each other with explicit .js specifiers (NodeNext style); Vite resolves
    // those to the .ts sources without a build step.
    alias: [
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' },
      // Renderer components import shared code as @shared/..., as electron-vite resolves it.
      { find: /^@shared\/(.*)$/, replacement: resolve(import.meta.dirname, 'src/shared/$1') },
    ],
  },
});
