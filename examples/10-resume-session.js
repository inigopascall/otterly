/**
 * Resume a Session: Pick up a conversation where you left off.
 *
 * Usage:
 *   node examples/10-resume-session.js              # starts a new session
 *   node examples/10-resume-session.js <sessionId>  # resumes a previous session
 *
 * This shows how to persist conversation context across process restarts.
 * You could save the session ID to a file, database, or pass it between services.
 */
import { claude } from "../dist/index.js";

const previousSessionId = process.argv[2];

if (previousSessionId) {
  // --- Resume an existing session ---
  console.log(`Resuming session: ${previousSessionId}\n`);

  const result = await claude.run(
    "What were we talking about? Summarize our previous conversation in one sentence, then tell me if there's anything you'd recommend as a next step.",
    { cwd: process.cwd(), resume: previousSessionId }
  );

  console.log(result.text);
  console.log(`\nSession: ${result.sessionId}`);
  console.log(`Cost: $${result.cost.toFixed(4)}`);
} else {
  // --- Start a new session, print the ID to resume later ---
  console.log("Starting new session...\n");

  const session = claude.session({ cwd: process.cwd() });

  const r1 = await session.send("What is this project? Give me the name, description, and version from package.json.");
  console.log(r1.text);

  const r2 = await session.send("What would you improve first if you were maintaining this project?");
  console.log("\n" + r2.text);

  console.log(`\n--- Session ID: ${session.id} ---`);
  console.log(`Re-run with: node examples/10-resume-session.js ${session.id}`);

  session.close();
}
