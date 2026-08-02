import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["bench/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
