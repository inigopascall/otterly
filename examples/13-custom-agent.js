/**
 * Custom Agent: Build a specialized coding agent with a system prompt and tool restrictions.
 *
 * Run: node examples/13-custom-agent.js
 *
 * This shows how to create a focused agent that only does one thing well.
 * Example: a "documentation agent" that reads code and writes markdown docs,
 * but can't run commands or modify source files.
 */
import { ClaudeEngine } from "../dist/index.js";

// Create a docs-only agent with restricted capabilities
const docsAgent = new ClaudeEngine({
  systemPrompt: `You are a documentation writer. Your job:
  - Read source code files
  - Generate clear, concise documentation in markdown
  - Document function signatures, parameters, return types, and usage examples
  - Never modify source code files
  - Output documentation to stdout — do not create files`,

  // Only allow reading tools — no writes, no bash
  allowedTools: ["Read", "Glob", "Grep"],
});

console.log("Docs Agent: Generating API docs for the engine module...\n");

const result = await docsAgent.run(
  `Read src/engine.ts and generate API documentation for the ClaudeEngine class.
  Include: constructor, all public methods, parameters, return types, and a short usage example for each method.
  Format as markdown.`,
  { cwd: process.cwd() }
);

console.log(result.text);
console.log(`\n---`);
console.log(`Cost: $${result.cost.toFixed(4)} | ${(result.duration / 1000).toFixed(1)}s`);
