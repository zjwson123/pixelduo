import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
