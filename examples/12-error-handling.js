/**
 * Error Handling: Gracefully handle all the ways things can go wrong.
 *
 * Run: node examples/12-error-handling.js
 *
 * This demonstrates robust error handling with classified error codes,
 * retry logic for transient failures, and timeout management.
 */
import { claude, AgentError, classifyError } from "../dist/index.js";

/**
 * Run a prompt with automatic retry for transient errors.
 */
async function runWithRetry(prompt, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await claude.run(prompt, options);
    } catch (err) {
      const classified = classifyError(err);

      switch (classified.code) {
        case "NOT_AUTHENTICATED":
          // Not retryable — user needs to log in
          console.error("Auth error: Run `claude login` to authenticate.");
          throw classified;

        case "RATE_LIMITED":
          // Retryable — wait and try again
          if (attempt < maxRetries) {
            const wait = (attempt + 1) * 5000;
            console.log(`Rate limited. Retrying in ${wait / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw classified;

        case "NETWORK":
          // Retryable
          if (attempt < maxRetries) {
            console.log(`Network error. Retrying... (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw classified;

        case "BILLING":
          console.error("Billing issue. Check your Anthropic account.");
          throw classified;

        case "SDK_NOT_FOUND":
          console.error("@anthropic-ai/claude-code is not installed. Run: npm install @anthropic-ai/claude-code");
          throw classified;

        case "ABORTED":
          console.log("Request was cancelled.");
          throw classified;

        default:
          throw classified;
      }
    }
  }
}

// --- Demo: successful run with retry wrapper ---
try {
  console.log("Running with retry logic...\n");
  const result = await runWithRetry(
    "What is 2 + 2? Reply with just the number.",
    { cwd: process.cwd() }
  );
  console.log(`Result: ${result.text}`);
  console.log(`Cost: $${result.cost.toFixed(4)}`);
} catch (err) {
  if (err instanceof AgentError) {
    console.error(`Failed [${err.code}]: ${err.message}`);
  } else {
    console.error("Unexpected error:", err);
  }
}

// --- Demo: timeout with AbortSignal ---
console.log("\n--- Timeout demo ---");
try {
  const result = await runWithRetry(
    "List all files in the project.",
    {
      cwd: process.cwd(),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    }
  );
  console.log(`Result: ${result.text.slice(0, 100)}...`);
} catch (err) {
  if (err instanceof AgentError) {
    console.error(`Failed [${err.code}]: ${err.message}`);
  }
}
