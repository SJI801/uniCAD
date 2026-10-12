import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@wasm': fileURLToPath(new URL('./src/wasm', import.meta.url)),
    },
  },
  // The wasm-bindgen glue (built by scripts/build-wasm.mjs with `--target web`)
  // is imported as an ordinary ES module, and the `.wasm` binary is pulled in
  // via `?url` so Vite treats it as a static asset. `bundler`-target output is
  // NOT used because Vite 6 rejects its bare `import x from './x.wasm'`.
  optimizeDeps: {
    exclude: ['unicad-kernel'],
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    port: 5273,
    open: false,
    fs: {
      // src/wasm/pkg is generated, so make sure the dev server serves it.
      allow: ['.'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
