import { defineConfig } from "vite";

// Browser demo bundle. `tsc` separately type-checks and emits the library/tests into dist/.
export default defineConfig({
  base: "./",
  // Three.js alone is ~650 kB minified; this single-page reference demo does not code-split.
  build: { outDir: "dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1024 },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
