import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative paths so the built app loads from file:// inside Electron.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
