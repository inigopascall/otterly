// Native client-tool mode (OTTERLY_NATIVE_TOOLS=1).
//
// A streamed request that carries client `tools` can be answered by giving the
// Claude CLI those tools as real tools. Each request gets a private directory
// holding a placeholder MCP server, which lists the tools and executes nothing,
// and the CLI runs with permissions that refuse every call to them
// (buildCLICommand in engine.ts). Each call the model requested is read from
// the CLI's streamed output (ClaudeEngine.stream) and returned to the client as
// OpenAI tool_calls (handleNativeToolStream in routes-openai.ts).
//
// This module holds what does not depend on the route: which requests qualify,
// the placeholder server and its directory, the count of calls that reached
// it, name resolution, argument coercion, and the startup check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeClaudeCLI, checkNativeInit } from "../engine.js";
import type { OpenAIChatRequest } from "./openai-compat.js";

/** The placeholder server's name. The CLI shows each offered tool `x` to the
 *  model as mcp__c__x. */
export const NATIVE_SERVER_NAME = "c";

/** The prefix the CLI gives each of the placeholder server's tools. */
export const NATIVE_TOOL_PREFIX = `mcp__${NATIVE_SERVER_NAME}__`;

/** The tool names native mode accepts. */
const NATIVE_TOOL_NAME = /^[A-Za-z0-9_-]{1,56}$/;

/**
 * Why a chat-completion request cannot take the native client-tool path, or
 * null when it can: a streamed request offering one or more uniquely named
 * functions, with tool_choice unset or "auto".
 */
export function nativeToolsIneligible(body: OpenAIChatRequest): string | null {
  if (body.stream !== true) return "the request is not streamed";
  const tools: unknown = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return "the request offers no tools";
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") {
    return `tool_choice is ${JSON.stringify(body.tool_choice)}`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i] && typeof tools[i] === "object" ? tools[i] as Record<string, unknown> : {};
    if (tool.type !== "function") return `tool ${i} is not of type function`;
    const fn = tool.function && typeof tool.function === "object" ? tool.function as Record<string, unknown> : {};
    const name = fn.name;
    if (typeof name !== "string" || !NATIVE_TOOL_NAME.test(name)) {
      return `tool ${i} has a name native mode does not accept: ${JSON.stringify(name)}`;
    }
    if (seen.has(name)) return `the tool name ${name} is offered twice`;
    seen.add(name);
  }
  return null;
}

/** Renames each offered tool `x` in the history to mcp__c__x, the name the
 *  model sees it under. Every other name is left as it is. */
export function nativeHistoryName(toolNames: string[]): (name: string) => string {
  const offered = new Set(toolNames);
  return (name) => (offered.has(name) ? NATIVE_TOOL_PREFIX + name : name);
}

/** A call name the CLI reported, as the client knows it. */
export interface ResolvedToolName {
  /** The name sent to the client. */
  name: string;
  /** The model called an offered tool by its plain name, without the prefix. */
  nameFixed: boolean;
  /** False when the name is no offered tool. */
  known: boolean;
}

/**
 * Resolve a call name taken from the CLI. mcp__c__x, where x is offered, is x.
 * An offered name itself is accepted, counted as a name fix. Any other name is
 * unknown, and is forwarded with a leading mcp__c__ removed.
 */
export function resolveNativeToolName(name: string, offered: ReadonlySet<string>): ResolvedToolName {
  const prefixed = name.startsWith(NATIVE_TOOL_PREFIX);
  const plain = prefixed ? name.slice(NATIVE_TOOL_PREFIX.length) : name;
  if (prefixed && offered.has(plain)) return { name: plain, nameFixed: false, known: true };
  if (offered.has(name)) return { name, nameFixed: true, known: true };
  return { name: plain, nameFixed: false, known: false };
}

/** A value's JSON Schema type; a whole number is "integer". */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Whether a value has a schema type; "number" accepts integers. */
function fits(value: unknown, type: unknown): boolean {
  const t = typeOf(value);
  return type === "number" ? t === "number" || t === "integer" : t === type;
}

/** The types a schema declares, or null when it declares none. */
function typesOf(schema: unknown): unknown[] | null {
  if (!schema || typeof schema !== "object") return null;
  const type = (schema as Record<string, unknown>).type;
  if (type === undefined) return null;
  return Array.isArray(type) ? type : [type];
}

/**
 * Coerce a call's top-level arguments to the types its tool's `parameters`
 * declare. A property declared in `parameters.properties` whose value has the
 * wrong type, and is a string holding JSON of the declared type, is replaced
 * by that JSON. Nothing else changes. `fixed` names the replaced properties.
 */
export function coerceNativeArguments(
  args: Record<string, unknown>,
  parameters: unknown,
): { args: Record<string, unknown>; fixed: string[] } {
  const schema = parameters && typeof parameters === "object" ? parameters as Record<string, unknown> : {};
  const props = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = { ...args };
  const fixed: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const types = typesOf(props[key]);
    if (!types || types.some((t) => fits(value, t)) || typeof value !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue; // not JSON: stays a string
    }
    if (types.some((t) => fits(parsed, t))) {
      out[key] = parsed;
      fixed.push(key);
    }
  }
  return { args: out, fixed };
}

/**
 * The placeholder MCP server, written into each request's directory as
 * server.mjs. It is kept here as source text so that it also runs when this
 * module is loaded from src/ by the tests.
 */
export const NATIVE_MCP_SERVER_SOURCE = String.raw`#!/usr/bin/env node
// Otterly's placeholder MCP server for native client-tool mode.
//
// Speaks MCP over stdio: one JSON-RPC 2.0 message per line. It lists the tools
// in the file named by argv[2] and executes nothing. Every tools/call is logged
// and answered with an error result. The only file it writes is its own log,
// argv[3]; a failed write is ignored.
import { readFileSync, appendFileSync } from "node:fs";

const [, , toolsPath, logPath] = process.argv;
if (!toolsPath || !logPath) {
  process.stderr.write("usage: node server.mjs <tools.json> <log.ndjson>\n");
  process.exit(2);
}

// tools.json holds an OpenAI tools array: [{ type: "function", function: { name, description, parameters } }].
// An optional function.annotations object is served as the MCP tool's annotations.
const tools = JSON.parse(readFileSync(toolsPath, "utf8")).map((t) => ({
  name: t.function.name,
  description: t.function.description || "",
  inputSchema: t.function.parameters || { type: "object", properties: {} },
  ...(t.function.annotations ? { annotations: t.function.annotations } : {}),
}));

function log(entry) {
  try {
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
  } catch {
    // The directory may already be gone; the server keeps answering.
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log({ event: "unparsed", head: line.slice(0, 300) });
    return;
  }
  log({ event: "recv", method: msg.method ?? null, id: msg.id ?? null, ...(msg.method === "tools/call" ? { params: msg.params } : {}) });
  // Notifications carry no id; responses carry no method. Neither is answered.
  if (msg.id === undefined || msg.id === null || !msg.method) return;
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "otterly-native-tools", version: "0.0.0" },
        },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      return;
    case "tools/call":
      log({ event: "EXECUTION_REQUEST", name: msg.params?.name ?? null });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "This tool is a placeholder. Nothing was executed." }], isError: true },
      });
      return;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
}

log({ event: "start", toolCount: tools.length });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => {
  log({ event: "stdin_end" });
  process.exit(0);
});
`;

/** The files of one request's placeholder server. */
export interface NativeToolDir {
  /** The private directory holding them. */
  dir: string;
  serverPath: string;
  toolsPath: string;
  logPath: string;
  /** The engine's mcpServers option: the one placeholder server. */
  mcpServers: Record<string, unknown>;
}

/**
 * Create a private directory for one request's placeholder server: server.mjs,
 * tools.json (the request's `tools` as received) and, once the server writes
 * it, mcp.log.ndjson. Remove it with removeNativeToolDir.
 */
export function createNativeToolDir(tools: unknown[]): NativeToolDir {
  const dir = mkdtempSync(join(tmpdir(), "otterly-native-"));
  const serverPath = join(dir, "server.mjs");
  const toolsPath = join(dir, "tools.json");
  const logPath = join(dir, "mcp.log.ndjson");
  try {
    writeFileSync(serverPath, NATIVE_MCP_SERVER_SOURCE);
    writeFileSync(toolsPath, JSON.stringify(tools));
  } catch (err) {
    removeNativeToolDir(dir);
    throw err;
  }
  return {
    dir,
    serverPath,
    toolsPath,
    logPath,
    mcpServers: {
      [NATIVE_SERVER_NAME]: { type: "stdio", command: process.execPath, args: [serverPath, toolsPath, logPath] },
    },
  };
}

/** Remove a request's directory. Never throws. */
export function removeNativeToolDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing more can be done; the directory is in the system temp folder.
  }
}

/** The placeholder server's log, for the trace; "" when it cannot be read. */
export function readNativeToolLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * How many tools/call requests reached the placeholder server, from its log.
 * Every line that is not a JSON object counts as one as well, so that a
 * damaged log fails safe. A missing log counts 0; one that cannot be read
 * counts 1.
 */
export function countToolCallsReceived(logPath: string): number {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : 1;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      count++;
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      count++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.event === "recv" && e.method === "tools/call") count++;
  }
  return count;
}

/**
 * Check native client-tool mode against the installed claude CLI before the
 * server listens: one start of the CLI with the native flags, offering one
 * tool, `otterly_probe`, and a user message marked `shouldQuery: false`, so the
 * model is not called (probeClaudeCLI). It passes when the CLI exits 0,
 * reports that one tool and that one connected server alone (checkNativeInit),
 * and no call reached the server.
 */
export async function verifyNativeClientTools(cwd: string): Promise<{ ok: boolean; problem?: string }> {
  const toolNames = ["otterly_probe"];
  let files: NativeToolDir | null = null;
  try {
    files = createNativeToolDir([
      { type: "function", function: { name: "otterly_probe", description: "Startup check.", parameters: { type: "object", properties: {} } } },
    ]);
    const probe = await probeClaudeCLI({
      cwd,
      permissionMode: "dontAsk",
      maxTurns: 1,
      mcpServers: files.mcpServers,
      clientToolsNative: { serverName: NATIVE_SERVER_NAME, toolNames },
    });
    if (probe.exitCode !== 0 || !probe.init) {
      const detail = probe.stderr.trim().slice(-500) || "no output";
      return { ok: false, problem: `claude did not start in native client-tool mode (exit ${probe.exitCode}): ${detail}` };
    }
    const problem = checkNativeInit(probe.init, { serverName: NATIVE_SERVER_NAME, toolNames });
    if (problem) {
      return { ok: false, problem: `claude failed the native client-tool isolation check: ${problem}` };
    }
    const calls = countToolCallsReceived(files.logPath);
    if (calls !== 0) {
      return { ok: false, problem: `claude passed ${calls} tool call(s) to the placeholder server during the native client-tool check` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: `the native client-tool check failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (files) removeNativeToolDir(files.dir);
  }
}
