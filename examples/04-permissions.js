/**
 * Custom permissions: Control what Claude can and can't do.
 *
 * Run: node examples/04-permissions.js
 */
import { claude, READONLY } from "../dist/index.js";

// --- Read-only mode: Claude can read but not modify anything ---
console.log("--- Read-only mode ---");
try {
  const result = await claude.run(
    "Read package.json and tell me the version number. Do NOT modify any files.",
    { cwd: process.cwd(), onPermission: READONLY }
  );
  console.log(result.text);
  console.log(`Tools used: ${result.tools.map((t) => `${t.tool}${t.isError ? " (denied)" : ""}`).join(", ")}\n`);
} catch (err) {
  console.error("Error:", err.message, "\n");
}

// --- Custom handler: allow reads, block writes, log everything ---
console.log("--- Custom permission handler ---");
const result = await claude.run(
  "What files are in the src/ directory?",
  {
    cwd: process.cwd(),
    onPermission: ({ tool, input, reason }) => {
      const action = ["Write", "Edit", "Bash", "NotebookEdit"].includes(tool)
        ? "DENY"
        : "ALLOW";
      console.log(`  [permission] ${action} ${tool}`);
      return { allow: action === "ALLOW" };
    },
  }
);
console.log(result.text);
