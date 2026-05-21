/**
 * Abort/timeout: Cancel a request after a deadline.
 *
 * Run: node examples/05-abort.js
 */
import { claude } from "../dist/index.js";

const controller = new AbortController();

// Set a 10-second timeout
const timeout = setTimeout(() => {
  console.log("\n[timeout] 10s reached, aborting...");
  controller.abort();
}, 10_000);

try {
  console.log("Asking Claude (will abort after 10s if not done)...\n");

  for await (const event of claude.stream(
    "List all files in the current directory.",
    { cwd: process.cwd(), signal: controller.signal }
  )) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "tool_use") {
      console.log(`\n[tool] ${event.description}`);
    } else if (event.type === "result") {
      console.log(`\n\n[done] $${event.cost.toFixed(4)}`);
    }
  }
} catch (err) {
  if (err.code === "ABORTED") {
    console.log("[aborted] Request was cancelled.");
  } else {
    console.error("[error]", err.message);
  }
} finally {
  clearTimeout(timeout);
}
