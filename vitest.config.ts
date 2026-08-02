import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    exclude: ["bench/**", "node_modules/**", "build/**"],
    restoreMocks: true,
  },
});
