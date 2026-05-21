/**
 * One-shot: Ask Claude to do something, get the result.
 *
 * Run: node examples/01-oneshot.js
 */
import { claude } from "../dist/index.js";

const result = await claude.run(
  "List the files in the current directory and tell me what this project is about. Keep it to 2-3 sentences.",
  { cwd: process.cwd() }
);

console.log("\n--- Result ---");
console.log(result.text);
console.log(`\nCost: $${result.cost.toFixed(4)}`);
console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
console.log(`Session: ${result.sessionId}`);
console.log(`Tools used: ${result.tools.map((t) => t.tool).join(", ") || "none"}`);
console.log(`Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`);
