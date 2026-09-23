/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/.cache/**"] } },
  build: { target: "safari16", outDir: "dist", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000 },
});
