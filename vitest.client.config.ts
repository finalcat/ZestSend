import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["client-test/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
