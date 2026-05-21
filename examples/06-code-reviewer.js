/**
 * Code Reviewer: Point Claude at a file and get a code review.
 *
 * Usage:
 *   node examples/06-code-reviewer.js src/engine.ts
 *   node examples/06-code-reviewer.js src/          # review a whole directory
 *
 * This shows how to build a practical CLI tool on top of otterly.
 * Uses READONLY permissions — Claude can read your code but can't modify anything.
 */
import { claude, READONLY } from "../dist/index.js";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node examples/06-code-reviewer.js <file-or-directory>");
  process.exit(1);
}

console.log(`Reviewing: ${target}\n`);

const result = await claude.run(
  `Review the code in "${target}". Focus on:
  1. Bugs or logic errors
  2. Security issues
  3. Missing error handling that would matter in production
  4. Unclear naming or confusing patterns

  Skip nitpicks about formatting or style.
  Be specific — reference file names and line numbers.
  If the code looks solid, say so briefly.`,
  {
    cwd: process.cwd(),
    onPermission: READONLY,
  }
);

console.log(result.text);
console.log(`\n---`);
console.log(`Cost: $${result.cost.toFixed(4)} | ${(result.duration / 1000).toFixed(1)}s`);
console.log(`Files read: ${result.tools.filter((t) => t.tool === "Read").length}`);
