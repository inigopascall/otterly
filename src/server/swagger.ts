// OpenAPI 3.0 spec for the otterly local API server.

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Otterly API",
    version: "0.3.6",
    description:
      "Local inference server with OpenAI-compatible and native endpoints. " +
      "WebSocket available at ws://localhost:{port}/ws for interactive sessions.",
  },
  paths: {
    "/api/status": {
      get: {
        summary: "Health check",
        operationId: "getStatus",
        responses: {
          "200": {
            description: "Server status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    version: { type: "string", example: "0.3.6" },
                    activeSessions: { type: "integer" },
                    queue: {
                      type: "object",
                      properties: {
                        active: { type: "integer" },
                        queued: { type: "integer" },
                        maxConcurrent: { type: "integer" },
                        maxQueueSize: { type: "integer" },
                      },
                    },
                    circuitBreaker: { type: "string", enum: ["closed", "open", "half-open"] },
                  },
                  required: ["status", "version", "activeSessions"],
                },
              },
            },
          },
        },
      },
    },
    "/swagger.json": {
      get: {
        summary: "OpenAPI spec",
        operationId: "getSwagger",
        responses: {
          "200": {
            description: "This OpenAPI specification",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/": {
      get: {
        summary: "Server info",
        operationId: "getRoot",
        responses: {
          "200": {
            description: "Server name, version, and playground link",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", example: "otterly" },
                    version: { type: "string", example: "0.3.6" },
                    playground: { type: "string", example: "/playground" },
                  },
                  required: ["name", "version", "playground"],
                },
              },
            },
          },
        },
      },
    },
    "/playground": {
      get: {
        summary: "Interactive API playground",
        operationId: "getPlayground",
        responses: {
          "200": {
            description: "HTML page with interactive API explorer",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/v1/models": {
      get: {
        summary: "List available models (OpenAI format)",
        operationId: "listModels",
        description: "Returned to OpenAI clients that probe for models on startup.",
        responses: {
          "200": {
            description: "Model list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string", example: "list" },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          object: { type: "string", example: "model" },
                          created: { type: "integer" },
                          owned_by: { type: "string", example: "anthropic" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/tags": {
      get: {
        summary: "List models (Ollama format)",
        operationId: "ollamaTags",
        description: "Ollama-native discovery endpoint. Ollama-only tools poll this to auto-detect otterly and build their model picker.",
        responses: {
          "200": { description: "Ollama model list", content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
    "/api/chat": {
      post: {
        summary: "Ollama-compatible chat",
        operationId: "ollamaChat",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["messages"],
                properties: {
                  model: { type: "string", default: "claude-sonnet-4-20250514" },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                        content: { type: "string" },
                        images: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                  stream: { type: "boolean", default: true, description: "Ollama defaults to true; NDJSON stream when set" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Ollama chat response (NDJSON stream when stream=true)" },
          "400": { description: "Invalid request" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/api/generate": {
      post: {
        summary: "Ollama-compatible completion",
        operationId: "ollamaGenerate",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  model: { type: "string", default: "claude-sonnet-4-20250514" },
                  prompt: { type: "string" },
                  system: { type: "string" },
                  stream: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Ollama generate response (NDJSON stream when stream=true)" },
          "400": { description: "Missing prompt" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/api/show": {
      post: {
        summary: "Model metadata (Ollama format)",
        operationId: "ollamaShow",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { model: { type: "string" } } } } },
        },
        responses: { "200": { description: "Model details incl. context length and capabilities" } },
      },
    },
    "/v1/chat/completions": {
      post: {
        summary: "OpenAI-compatible chat completions",
        operationId: "chatCompletions",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "X-Session-Id", in: "header", schema: { type: "string" }, description: "Reuse an existing session" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["messages"],
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["role", "content"],
                      properties: {
                        role: { type: "string", enum: ["system", "user", "assistant"] },
                        content: { type: "string" },
                      },
                    },
                  },
                  model: { type: "string", default: "claude-sonnet-4-20250514" },
                  stream: { type: "boolean", default: false, description: "If true, response is SSE (text/event-stream)" },
                  tools: { type: "array", items: { type: "object" }, description: "OpenAI-format tool definitions" },
                  response_format: {
                    type: "object",
                    properties: { type: { type: "string", enum: ["text", "json_object"] } },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Chat completion (or SSE stream when stream=true)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatCompletionResponse" },
              },
              "text/event-stream": {
                schema: { type: "string", description: "SSE stream of chat completion chunks" },
              },
            },
          },
          "400": { description: "Invalid request" },
          "401": { description: "Unauthorized" },
          "429": { description: "Rate limited or queue full" },
          "503": { description: "Circuit breaker open" },
        },
      },
    },
    "/api/run": {
      post: {
        summary: "One-shot execution (native format)",
        operationId: "apiRun",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "X-Session-Id", in: "header", schema: { type: "string" }, description: "Reuse an existing session" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  session_id: { type: "string" },
                  options: {
                    type: "object",
                    properties: {
                      cwd: { type: "string" },
                      permissionMode: { type: "string" },
                      systemPrompt: { type: "string" },
                      resume: { type: "string" },
                      model: { type: "string" },
                      maxTurns: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Execution result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NativeRunResponse" },
              },
            },
          },
          "400": { description: "Missing or invalid prompt" },
          "401": { description: "Unauthorized" },
          "429": { description: "Rate limited or queue full" },
          "503": { description: "Circuit breaker open" },
        },
      },
    },
    "/api/stream": {
      post: {
        summary: "Streaming execution (NDJSON)",
        operationId: "apiStream",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "X-Session-Id", in: "header", schema: { type: "string" }, description: "Reuse an existing session" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  session_id: { type: "string" },
                  options: {
                    type: "object",
                    properties: {
                      cwd: { type: "string" },
                      permissionMode: { type: "string" },
                      systemPrompt: { type: "string" },
                      resume: { type: "string" },
                      model: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "NDJSON stream of events",
            content: {
              "application/x-ndjson": {
                schema: { $ref: "#/components/schemas/StreamEvent" },
              },
            },
          },
          "400": { description: "Missing or invalid prompt" },
          "401": { description: "Unauthorized" },
          "429": { description: "Rate limited or queue full" },
          "503": { description: "Circuit breaker open" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Set OTTERLY_API_KEY env var to enable. Pass as Bearer token.",
      },
    },
    schemas: {
      ChatCompletionResponse: {
        type: "object",
        properties: {
          id: { type: "string" },
          object: { type: "string", example: "chat.completion" },
          created: { type: "integer" },
          model: { type: "string" },
          choices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                message: {
                  type: "object",
                  properties: {
                    role: { type: "string" },
                    content: { type: "string", nullable: true },
                    tool_calls: {
                      type: "array",
                      description: "Present when the model requests caller-executed functions",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          type: { type: "string", example: "function" },
                          function: {
                            type: "object",
                            properties: {
                              name: { type: "string" },
                              arguments: { type: "string", description: "JSON-encoded arguments" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                finish_reason: { type: "string", enum: ["stop", "tool_calls", "length"] },
              },
            },
          },
          usage: {
            type: "object",
            properties: {
              prompt_tokens: { type: "integer" },
              completion_tokens: { type: "integer" },
              total_tokens: { type: "integer" },
            },
          },
        },
      },
      NativeRunResponse: {
        type: "object",
        properties: {
          text: { type: "string" },
          sessionId: { type: "string" },
          cost: { type: "number" },
          duration: { type: "number" },
          usage: {
            type: "object",
            properties: {
              inputTokens: { type: "integer" },
              outputTokens: { type: "integer" },
            },
          },
        },
      },
      StreamEvent: {
        type: "object",
        description: "One of: session_init, text_delta, tool_use, tool_result, result, error",
        properties: {
          type: { type: "string", enum: ["session_init", "text_delta", "tool_use", "tool_result", "result", "error"] },
        },
        required: ["type"],
      },
    },
  },
};
