/**
 * Multi-turn session: Have a conversation where Claude remembers context.
 *
 * Run: node examples/03-session.js
 */
import { claude } from "../dist/index.js";

const session = claude.session({ cwd: process.cwd() });

console.log("--- Turn 1: Ask about the project ---");
const r1 = await session.send("What is this project? Just the name and one sentence.");
console.log(r1.text);
console.log(`(cost: $${r1.cost.toFixed(4)})\n`);

console.log("--- Turn 2: Follow-up using context from turn 1 ---");
const r2 = await session.send("How many source files does it have in src/? Just the count.");
console.log(r2.text);
console.log(`(cost: $${r2.cost.toFixed(4)})\n`);

console.log("--- Turn 3: Another follow-up ---");
const r3 = await session.send("Which of those files is the largest? Just the filename and line count.");
console.log(r3.text);
console.log(`(cost: $${r3.cost.toFixed(4)})\n`);

console.log(`Session ID: ${session.id}`);
console.log("(You can resume this session later with { resume: sessionId })\n");

session.close();
