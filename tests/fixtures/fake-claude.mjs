// A stand-in for the claude CLI that speaks its stream-json protocol on
// stdin/stdout, for tests of createCLIQueryFn. It appends its argv, and every
// line it reads on stdin, to the file named by FAKE_CLAUDE_LOG.
//
// For each user message, by its text:
//   "ASK <tool>"  sends a can_use_tool control_request for <tool> with input
//                 {"path":"x"}, waits for the control_response, and replies
//                 "allow: <updatedInput as JSON>" or "deny: <message>"
//   "SILENT <ms>" prints nothing for <ms>, then replies "echo: SILENT <ms>"
//   anything else replies "echo: <text>"
// It prints system/init once, before its first reply, then one assistant
// message and one result per user message, and exits when stdin ends.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.FAKE_CLAUDE_LOG;
const record = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
};
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
record({ argv: process.argv.slice(2), pid: process.pid });

let initSent = false;
let pending = null;
let chain = Promise.resolve();
let requests = 0;

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block && block.text) || "").join("")
      : "";

async function turn(text) {
  if (!initSent) {
    initSent = true;
    out({ type: "system", subtype: "init", session_id: "fake-session", tools: [], mcp_servers: [] });
  }
  let reply = `echo: ${text}`;
  const ask = /^ASK (\S+)/.exec(text);
  const silent = /^SILENT (\d+)/.exec(text);
  if (ask) {
    const id = `req-${++requests}`;
    const answer = new Promise((resolve) => {
      pending = { id, resolve };
    });
    out({
      type: "control_request",
      request_id: id,
      request: { subtype: "can_use_tool", tool_name: ask[1], input: { path: "x" }, tool_use_id: `toolu_${requests}` },
    });
    const decision = await answer;
    reply = decision.behavior === "allow"
      ? `allow: ${JSON.stringify(decision.updatedInput)}`
      : `deny: ${decision.message}`;
  }
  if (silent) await new Promise((resolve) => setTimeout(resolve, Number(silent[1])));
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }] }, session_id: "fake-session" });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reply,
    session_id: "fake-session",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  record({ stdin: line });
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    const response = message.response || {};
    if (pending && response.request_id === pending.id) {
      const p = pending;
      pending = null;
      p.resolve(response.response || {});
    }
    return;
  }
  if (message.type === "user") {
    const text = textOf(message.message && message.message.content);
    chain = chain.then(() => turn(text));
  }
});
rl.on("close", () => {
  chain.then(() => process.exit(0));
});
