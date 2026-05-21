/**
 * Bug Fixer: Describe a bug, let Claude find and fix it.
 *
 * Usage:
 *   node examples/07-bug-fixer.js "The stream() method doesn't emit a result event when the model returns no text"
 *   node examples/07-bug-fixer.js "TypeError: Cannot read property 'length' of undefined in session.send()"
 *
 * Uses streaming so you can watch Claude investigate in real-time.
 * Uses acceptEdits permission mode — Claude can edit files but will ask before running commands.
 */
import { claude } from "../dist/index.js";

const bugDescription = process.argv[2];
if (!bugDescription) {
  console.error('Usage: node examples/07-bug-fixer.js "description of the bug"');
  process.exit(1);
}

console.log(`Bug: ${bugDescription}\n`);
console.log("Claude is investigating...\n");

for await (const event of claude.stream(
  `There's a bug in this project: "${bugDescription}"

  Steps:
  1. Read the relevant source files to understand the codebase
  2. Find the root cause of the bug
  3. Fix it with minimal changes
  4. Explain what you changed and why`,
  {
    cwd: process.cwd(),
    permissionMode: "acceptEdits",
  }
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_use":
      console.log(`\n  → ${event.description}`);
      break;
    case "tool_result":
      if (event.isError) {
        console.log(`  ✗ ${event.tool} failed`);
      }
      break;
    case "result":
      console.log(`\n\n--- Done ---`);
      console.log(`Cost: $${event.cost.toFixed(4)} | ${(event.duration / 1000).toFixed(1)}s`);
      break;
  }
}
