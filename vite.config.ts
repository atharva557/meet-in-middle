import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // MapLibre alone is ~800 kB minified (≈230 kB gzipped); that's expected.
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
