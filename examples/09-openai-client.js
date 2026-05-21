/**
 * OpenAI Client Compatibility: Use any OpenAI SDK to talk to otterly.
 *
 * Prerequisites:
 *   1. Start the server: node examples/08-http-server.js
 *   2. Install the OpenAI SDK: npm install openai
 *   3. Run this: node examples/09-openai-client.js
 *
 * This proves otterly is a drop-in replacement for OpenAI in your existing tools.
 * Any app that talks to OpenAI's API can point at otterly instead.
 */
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "not-needed", // otterly doesn't require an API key by default
});

// --- Non-streaming ---
console.log("--- Non-streaming ---");
const response = await client.chat.completions.create({
  model: "claude",
  messages: [
    { role: "user", content: "What is this project about? One sentence." },
  ],
});

console.log(response.choices[0].message.content);
console.log();

// --- Streaming ---
console.log("--- Streaming ---");
const stream = await client.chat.completions.create({
  model: "claude",
  stream: true,
  messages: [
    { role: "user", content: "List the top 3 source files by size." },
  ],
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}
console.log();
