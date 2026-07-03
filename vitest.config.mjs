import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["tests/**/*.test.mjs"],
    reporters: ["default"],
    testTimeout: 20000,
    setupFiles: ["./tests/setup/test-home.mjs"]
  }
});
