import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Never resolve the on-PATH `claude` CLI in tests (see findClaudeCLI in
    // src/engine.ts): `pnpm dlx vitest` puts node_modules/.bin, which holds
    // `claude`, on PATH.
    env: {
      OTTERLY_DISABLE_CLAUDE_CLI: "1",
    },
  },
});
