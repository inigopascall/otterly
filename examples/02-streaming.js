/**
 * Streaming: Watch Claude work in real-time.
 *
 * Run: node examples/02-streaming.js
 */
import { claude } from "../dist/index.js";

console.log("Streaming response...\n");

for await (const event of claude.stream(
  "Read package.json and give me a one-line summary of what this package does.",
  { cwd: process.cwd() }
)) {
  switch (event.type) {
    case "system":
      console.log(`[system] Session ${event.sessionId} | Model: ${event.model}`);
      console.log(`[system] Tools: ${event.tools.length} available\n`);
      break;

    case "text_delta":
      process.stdout.write(event.delta);
      break;

    case "text":
      // Full text block (after streaming completes)
      break;

    case "tool_use":
      console.log(`\n[tool] ${event.description}`);
      break;

    case "tool_result":
      console.log(`[tool] ${event.tool} → ${event.isError ? "ERROR" : "ok"} (${event.output.length} chars)`);
      break;

    case "result":
      console.log(`\n\n[done] Cost: $${event.cost.toFixed(4)} | ${(event.duration / 1000).toFixed(1)}s`);
      break;

    case "error":
      console.error(`\n[error] ${event.error.message}`);
      break;
  }
}
