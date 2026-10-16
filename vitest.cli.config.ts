import { defineConfig } from "vitest/config";

// The CLI suite (tests-cli/): runs the real, installed `claude`. It uses the
// Claude Code subscription for a few low-effort turns and needs network access.
export default defineConfig({
  test: {
    include: ["tests-cli/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
