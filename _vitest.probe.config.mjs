import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@wasm': fileURLToPath(new URL('./src/wasm', import.meta.url)),
    },
  },
  test: {
    include: [
      '_probe_frontend.test.ts',
      '_probe_store.test.ts',
      '_probe_dimension.test.ts',
      '_probe_tangent.test.ts',
      '_probe_dof.test.ts',
    ],
    pool: 'threads',
    environment: 'node',
  },
});
