/**
 * Test Generator: Point Claude at a source file, get tests back.
 *
 * Usage:
 *   node examples/11-test-generator.js src/errors.ts
 *   node examples/11-test-generator.js src/permissions.ts
 *
 * Claude reads the source file, figures out the testing framework from package.json,
 * and writes a test file next to the source. Uses acceptEdits so it can write files
 * but won't run arbitrary commands.
 */
import { claude } from "../dist/index.js";

const sourceFile = process.argv[2];
if (!sourceFile) {
  console.error("Usage: node examples/11-test-generator.js <source-file>");
  process.exit(1);
}

console.log(`Generating tests for: ${sourceFile}\n`);

const result = await claude.run(
  `Write tests for the file "${sourceFile}".

  Rules:
  - Check package.json to find the test framework (vitest, jest, etc.)
  - Put the test file next to the source file with a .test.ts extension
  - Test real behavior, not implementation details
  - Each test should fail if the code is wrong
  - Cover edge cases and error paths
  - Don't over-mock — use real objects where possible`,
  {
    cwd: process.cwd(),
    permissionMode: "acceptEdits",
  }
);

console.log(result.text);
console.log(`\n---`);
console.log(`Cost: $${result.cost.toFixed(4)} | ${(result.duration / 1000).toFixed(1)}s`);
console.log(`Files written: ${result.tools.filter((t) => t.tool === "Write" || t.tool === "Edit").length}`);
