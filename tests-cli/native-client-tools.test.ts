import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifyNativeClientTools } from "../src/server/native-tools.js";

// Runs the installed claude CLI once with the native client-tool flags. The
// probe's message is marked shouldQuery: false, so the model is not called.
describe("native client-tool mode against the installed claude CLI", () => {
  it("passes the startup check (verifyNativeClientTools)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "otterly-native-cli-"));
    try {
      expect(await verifyNativeClientTools(cwd)).toEqual({ ok: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
