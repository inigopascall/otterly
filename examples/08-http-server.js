/**
 * HTTP Server: Run otterly as a local API server.
 *
 * Usage:
 *   node examples/08-http-server.js
 *
 * Then hit the API:
 *
 *   # One-shot
 *   curl -X POST http://localhost:11434/api/run \
 *     -H "Content-Type: application/json" \
 *     -d '{"prompt": "What files are in the current directory?"}'
 *
 *   # Streaming (Server-Sent Events)
 *   curl -N -X POST http://localhost:11434/api/stream \
 *     -H "Content-Type: application/json" \
 *     -d '{"prompt": "Summarize the README.md"}'
 *
 *   # OpenAI-compatible (works with any OpenAI SDK client)
 *   curl -X POST http://localhost:11434/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model": "claude", "messages": [{"role": "user", "content": "Hello!"}]}'
 *
 *   # Health check
 *   curl http://localhost:11434/api/status
 */
import { startApiServer } from "../dist/server/index.js";

const PORT = parseInt(process.env.PORT || "11434", 10);

const handle = await startApiServer({
  port: PORT,
  workingDir: process.cwd(),
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  handle.close();
  process.exit(0);
});
