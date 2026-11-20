import { defineConfig } from 'vite';

// base './' so the build works from any sub-path (e.g. GitHub Pages /gamestuffProj/).
export default defineConfig({
  base: './',
  server: { port: 5173, open: true },
  build: { chunkSizeWarningLimit: 2000 },
});
