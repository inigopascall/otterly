import { describe, it, expect } from "vitest";
import { repairToolCalls, looksLikeToolCallEnvelope } from "../../src/server/tool-call-repair.js";
import {
  parseToolCalls,
  toOpenAIToolCalls,
  buildToolInstruction,
  buildModelsList,
  claudeResultToOpenai,
  openaiToClaudeInput,
  type OpenAITool,
} from "../../src/server/openai-compat.js";
import { DEFAULT_MODEL, MODELS } from "../../src/server/models.js";

const WEATHER_TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe("parseToolCalls", () => {
  it("returns null for an ordinary text answer", () => {
    expect(parseToolCalls("The weather in Paris is sunny.")).toBeNull();
    expect(parseToolCalls("")).toBeNull();
  });

  it("parses a clean tool-call JSON object", () => {
    const calls = parseToolCalls('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}');
    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls![0].name).toBe("get_weather");
    expect(calls![0].arguments).toEqual({ city: "Paris" });
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const text = '```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}}]}\n```';
    const calls = parseToolCalls(text);
    expect(calls![0].arguments).toEqual({ city: "Tokyo" });
  });

  it("recovers JSON embedded in surrounding prose", () => {
    const text = 'Sure, let me check.\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Berlin"}}]}\nDone.';
    const calls = parseToolCalls(text);
    expect(calls).not.toBeNull();
    expect(calls![0].arguments).toEqual({ city: "Berlin" });
  });

  it("parses arguments delivered as a JSON string", () => {
    const calls = parseToolCalls('{"tool_calls":[{"name":"f","arguments":"{\\"x\\":1}"}]}');
    expect(calls![0].arguments).toEqual({ x: 1 });
  });

  it("handles multiple tool calls", () => {
    const calls = parseToolCalls('{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{"k":2}}]}');
    expect(calls).toHaveLength(2);
    expect(calls![1]).toEqual({ name: "b", arguments: { k: 2 } });
  });

  it("returns null when tool_calls is empty or malformed", () => {
    expect(parseToolCalls('{"tool_calls":[]}')).toBeNull();
    expect(parseToolCalls('{"not_tool_calls":true}')).toBeNull();
    expect(parseToolCalls("{broken json")).toBeNull();
  });

  it("does not treat an unrelated JSON object as a tool call", () => {
    // Important: json_object response_format answers must NOT be misread as calls.
    expect(parseToolCalls('{"answer":"42","confidence":0.9}')).toBeNull();
  });

  it("recovers the call when stray braces surround it (prose, thinking block, trailing note)", () => {
    expect(parseToolCalls('Using {placeholder}.\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')![0].arguments).toEqual({ city: "Paris" });
    expect(parseToolCalls('{"thinking":"let me check"}\n{"tool_calls":[{"name":"f","arguments":{"x":1}}]}')![0].name).toBe("f");
    expect(parseToolCalls('{"tool_calls":[{"name":"f","arguments":{}}]}\nNote: {done:true}')![0].name).toBe("f");
  });

  it("ignores braces inside string values when scanning", () => {
    const calls = parseToolCalls('{"tool_calls":[{"name":"echo","arguments":{"text":"a } b { c"}}]}');
    expect(calls![0].arguments).toEqual({ text: "a } b { c" });
  });
});

describe("looksLikeToolCallEnvelope", () => {
  it("is true when the reply begins as a tool-call envelope", () => {
    expect(looksLikeToolCallEnvelope('{"tool_calls": [{"name":"a","arguments":{}}]}')).toBe(true);
    expect(looksLikeToolCallEnvelope('```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n```')).toBe(true);
  });

  it("is false for prose, including prose that discusses tool calls", () => {
    expect(looksLikeToolCallEnvelope("The weather in Paris is sunny.")).toBe(false);
    expect(looksLikeToolCallEnvelope('Here is the bug: {"tool_calls":[{"name":"a","arguments":{}}]} — see it?')).toBe(false);
    expect(looksLikeToolCallEnvelope("")).toBe(false);
  });
});

describe("repairToolCalls", () => {
  it("repairs a missing outermost closing brace", () => {
    // Correct form ends }}]} ; the model emitted }}]
    const calls = repairToolCalls('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]');
    expect(calls).not.toBeNull();
    expect(calls!.calls).toHaveLength(1);
    expect(calls!.calls[0].name).toBe("get_weather");
    expect(calls!.calls[0].arguments).toEqual({ city: "Paris" });
    expect(calls!.charsAltered).toBe(1);
  });

  it("repairs a missing arguments-object closing brace", () => {
    // Correct form ends }}]} ; the model emitted }]}
    const calls = repairToolCalls('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}]}');
    expect(calls).not.toBeNull();
    expect(calls!.calls[0].name).toBe("get_weather");
    expect(calls!.calls[0].arguments).toEqual({ city: "Paris" });
  });

  it("preserves a long multi-line string argument byte-for-byte", () => {
    const prompt = "## Task\n\nRun this:\n\n```bash\nssh host 'echo \"hi\"'\n```\n\nDone.";
    const good = JSON.stringify({ tool_calls: [{ name: "subagents---run_task", arguments: { subagentId: "code-runner", prompt } }] });
    expect(good.endsWith("}}]}")).toBe(true);
    const broken = good.slice(0, -1); // drop the final }
    const repaired = repairToolCalls(broken);
    expect(repaired).not.toBeNull();
    expect(repaired!.calls[0].arguments.prompt).toBe(prompt);
  });

  it("refuses output truncated inside a string value", () => {
    // A command cut short mid-value must never be 'completed' into a shorter one.
    expect(repairToolCalls('{"tool_calls":[{"name":"bash","arguments":{"command":"rm -rf ./build/cache}')).toBeNull();
    expect(repairToolCalls('{"tool_calls":[{"name":"bash","arguments":{"command":"rm -rf ./build')).toBeNull();
  });

  it("refuses when more than one closer is missing", () => {
    expect(repairToolCalls('{"tool_calls":[{"name":"a","arguments":{"x":1}')).toBeNull();
  });

  it("refuses when anything follows the envelope", () => {
    expect(repairToolCalls('{"tool_calls":[{"name":"a","arguments":{}}]\n</function_calls>\n\nDONE')).toBeNull();
    expect(repairToolCalls('Sure:\n{"tool_calls":[{"name":"a","arguments":{}}]')).toBeNull();
  });

  it("refuses an unexpected top-level key", () => {
    expect(repairToolCalls('{"tool_calls":[{"name":"a","arguments":{}}],"extra":{"k":1}')).toBeNull();
  });

  it("refuses an unexpected key inside a call", () => {
    expect(repairToolCalls('{"tool_calls":[{"name":"a","arguments":{},"cwd":"/tmp"}]')).toBeNull();
  });

  it("refuses a missing or empty tool name", () => {
    expect(repairToolCalls('{"tool_calls":[{"name":"","arguments":{}}]')).toBeNull();
    expect(repairToolCalls('{"tool_calls":[{"arguments":{}}]')).toBeNull();
  });

  it("refuses an empty tool_calls array", () => {
    expect(repairToolCalls('{"tool_calls":[]')).toBeNull();
  });

  it("returns null for ordinary prose", () => {
    expect(repairToolCalls("The weather in Paris is sunny.")).toBeNull();
    expect(repairToolCalls("")).toBeNull();
  });

  it("returns null for an envelope that is already valid", () => {
    // Well-formed input is handled by parseToolCalls; the repair path adds nothing.
    expect(repairToolCalls('{"tool_calls":[{"name":"a","arguments":{"x":1}}]}')).toBeNull();
  });
});

describe("claudeResultToOpenai with a repair notice", () => {
  it("returns the notice as content alongside the tool calls", () => {
    const calls = toOpenAIToolCalls([{ name: "get_weather", arguments: { city: "Paris" } }]);
    const res = claudeResultToOpenai("", "m", { input_tokens: 1, output_tokens: 2 }, calls, "repaired");
    expect(res.choices[0].finish_reason).toBe("tool_calls");
    expect(res.choices[0].message.content).toBe("repaired");
    expect(res.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("still returns null content when there is no notice", () => {
    const calls = toOpenAIToolCalls([{ name: "get_weather", arguments: { city: "Paris" } }]);
    const res = claudeResultToOpenai("", "m", undefined, calls);
    expect(res.choices[0].message.content).toBeNull();
  });
});

describe("toOpenAIToolCalls", () => {
  it("produces OpenAI-shaped tool calls with stringified arguments", () => {
    const out = toOpenAIToolCalls([{ name: "get_weather", arguments: { city: "Paris" } }]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("function");
    expect(out[0].id).toMatch(/^call_/);
    expect(out[0].function.name).toBe("get_weather");
    // arguments must be a JSON string, per the OpenAI spec
    expect(typeof out[0].function.arguments).toBe("string");
    expect(JSON.parse(out[0].function.arguments)).toEqual({ city: "Paris" });
  });

  it("gives distinct ids to distinct calls", () => {
    const out = toOpenAIToolCalls([{ name: "a", arguments: {} }, { name: "b", arguments: {} }]);
    expect(out[0].id).not.toBe(out[1].id);
  });
});

describe("buildToolInstruction", () => {
  it("lists the function names and the required JSON shape", () => {
    const text = buildToolInstruction([WEATHER_TOOL]);
    expect(text).toContain("get_weather");
    expect(text).toContain('"tool_calls"');
    expect(text).toMatch(/call the following functions/i);
  });

  it("forces a specific function when tool_choice names one", () => {
    const text = buildToolInstruction([WEATHER_TOOL], { type: "function", function: { name: "get_weather" } });
    expect(text).toMatch(/MUST call the function "get_weather"/i);
  });

  it("requires some call when tool_choice is 'required'", () => {
    const text = buildToolInstruction([WEATHER_TOOL], "required");
    expect(text).toMatch(/at least one of the listed functions/i);
  });
});

describe("claudeResultToOpenai with tool calls", () => {
  it("emits tool_calls with null content and finish_reason tool_calls", () => {
    const calls = toOpenAIToolCalls([{ name: "get_weather", arguments: { city: "Paris" } }]);
    const res = claudeResultToOpenai("", "m", { input_tokens: 1, output_tokens: 2 }, calls);
    expect(res.choices[0].finish_reason).toBe("tool_calls");
    expect(res.choices[0].message.content).toBeNull();
    expect(res.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("falls back to a normal text turn when no tool calls", () => {
    const res = claudeResultToOpenai("hello", "m");
    expect(res.choices[0].finish_reason).toBe("stop");
    expect(res.choices[0].message.content).toBe("hello");
    expect(res.choices[0].message.tool_calls).toBeUndefined();
  });
});

describe("buildModelsList", () => {
  it("returns an OpenAI model list covering the catalog", () => {
    const list = buildModelsList();
    expect(list.object).toBe("list");
    expect(list.data).toHaveLength(MODELS.length);
    expect(list.data.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
    expect(list.data[0].object).toBe("model");
    expect(list.data[0].owned_by).toBe("anthropic");
  });
});

describe("openaiToClaudeInput with function-call history", () => {
  it("renders prior tool calls and tool results into the prompt", () => {
    const { prompt } = openaiToClaudeInput({
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":"20C"}' },
        { role: "user", content: "thanks" },
      ],
    });
    expect(prompt).toContain("get_weather");
    expect(prompt).toContain("Result of function get_weather");
    expect(prompt).toContain('{"temp":"20C"}');
  });
});
