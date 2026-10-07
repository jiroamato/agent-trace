import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeRequestBody, renderMarkdown } from "./render.js";

const BASE = {
  timestamp: "2026-08-06T10:00:00.000Z",
  method: "POST",
  statusCode: 200,
  headers: {} as Record<string, string | string[] | undefined>,
};

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

describe("decodeRequestBody", () => {
  it("leaves an uncompressed body alone", () => {
    expect(decodeRequestBody(Buffer.from("hello"), undefined)).toBe("hello");
  });

  it("leaves a body alone when the encoding is identity", () => {
    expect(decodeRequestBody(Buffer.from("hello"), "identity")).toBe("hello");
  });

  it("decodes a zstd body", () => {
    const compressed = zlib.zstdCompressSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "zstd")).toBe("hello");
  });

  it("decodes a gzip body", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "gzip")).toBe("hello");
  });

  it("ignores the case of the encoding", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "GZIP")).toBe("hello");
  });

  it("fails loudly, instead of silently showing raw bytes as text, when the body will not decode", () => {
    const out = decodeRequestBody(Buffer.from("not compressed"), "zstd");
    expect(out).toContain("COULD NOT DECODE");
    expect(out).toContain("not compressed");
  });

  it("fails loudly, naming the encoding, for content-encodings it does not know", () => {
    const out = decodeRequestBody(Buffer.from("hello"), "compress");
    expect(out).toContain("COULD NOT DECODE");
    expect(out).toContain("compress");
  });

  it("fails loudly, naming the Node version, when the runtime has no zstd support", () => {
    const original = (zlib as any).zstdDecompressSync;
    delete (zlib as any).zstdDecompressSync;
    try {
      const compressed = zlib.zstdCompressSync(Buffer.from("hello"));
      const out = decodeRequestBody(compressed, "zstd");
      expect(out).toContain("COULD NOT DECODE");
      expect(out).toContain("zstd");
      expect(out).toContain(process.version);
    } finally {
      (zlib as any).zstdDecompressSync = original;
    }
  });
});

describe("renderMarkdown with a compressed body", () => {
  it("shows the decoded request", () => {
    const request = {
      model: "gpt-5.1",
      instructions: "You are a careful assistant.",
      input: "hello",
    };
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(body(request)),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("You are a careful assistant.");
  });

  it("finds the model in a compressed body", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(
        body({ model: "gpt-5.1", input: "hi" })
      ),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("**model**: gpt-5.1");
  });
});

// ---------------------------------------------------------------------------
// Anthropic - the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for Anthropic", () => {
  const request = {
    model: "claude-sonnet-4-5",
    system: "You are Claude Code.",
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
  };

  const out = renderMarkdown({
    ...BASE,
    agent: "Claude Code",
    renderer: "anthropic",
    path: "/v1/messages",
    requestBody: body(request),
    responseRaw:
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Claude Code.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### Read");
  });

  it("shows the message", () => {
    expect(out).toContain('<message index="1" role="user">');
  });

  it("names the agent in the meta block", () => {
    expect(out).toContain("**agent**: Claude Code");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// OpenAI - the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for OpenAI", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Codex",
    renderer: "openai",
    path: "/v1/responses",
    requestBody: body({
      model: "gpt-5.1",
      instructions: "You are Codex.",
      tools: [
        { type: "function", name: "shell", parameters: { type: "object" } },
      ],
      input: [{ type: "message", role: "user", content: "hello" }],
    }),
    responseRaw:
      'data: {"type":"response.output_text.delta","delta":"hi"}\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Codex.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### shell");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// "raw" - the explicit fallback for a custom target with no known wire format
// ---------------------------------------------------------------------------

describe('renderMarkdown for the "raw" renderer', () => {
  // Deliberately shaped like an OpenAI /responses request, so a test failure
  // here would show the bug this renderer exists to prevent: "raw" quietly
  // falling through to the OpenAI parser instead of the generic JSON dump.
  const request = {
    model: "some-local-model",
    instructions: "You are a careful assistant.",
    input: [{ type: "message", role: "user", content: "hello" }],
  };

  const out = renderMarkdown({
    ...BASE,
    agent: "OMP",
    renderer: "raw",
    path: "/v1/chat/completions",
    requestBody: body(request),
    responseRaw: JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
  });

  it("dumps the request as plain JSON, not through the OpenAI parser", () => {
    expect(out).not.toContain("<system-prompt>");
    expect(out).not.toContain("<messages>");
  });

  it("still shows the request content somewhere in the JSON dump", () => {
    expect(out).toContain("You are a careful assistant.");
  });

  it("dumps a non-streaming response as plain JSON, not through the OpenAI parser", () => {
    expect(out).not.toContain("<assistant-text>");
    expect(out).toContain('"content": "hi"');
  });

  it("still finds the model name, because that reading does not depend on the renderer", () => {
    expect(out).toContain("**model**: some-local-model");
  });

  it("dumps each SSE event as its own JSON block instead of reconstructing assistant text", () => {
    const streamed = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/v1/chat/completions",
      requestBody: body(request),
      responseRaw:
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
        'data: {"choices":[{"delta":{"content":" there"}}]}\n',
    });
    expect(streamed).not.toContain("<assistant-text>");
    expect(streamed).toContain('"content": "hi"');
    expect(streamed).toContain('"content": " there"');
  });

  it("falls back to the untouched raw text for a stream it cannot parse at all", () => {
    // Stands in for Ollama's NDJSON: bare JSON objects, one per line, with no
    // `data:` prefix - genuinely different from SSE, and out of scope here.
    // The one promise this renderer makes for that shape is "not broken".
    const ndjson =
      '{"model":"llama3","message":{"content":"hi"}}\n' +
      '{"model":"llama3","message":{"content":" there"},"done":true}\n';
    const out = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/api/chat",
      requestBody: body(request),
      responseRaw: ndjson,
    });
    expect(out).toContain('"content":"hi"');
  });

  it("does not treat an unparseable body as raw JSON, and falls back to raw text", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/v1/chat/completions",
      requestBody: Buffer.from("not json at all"),
      responseRaw: "",
    });
    expect(out).toContain("not json at all");
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_REQUEST = {
  systemInstruction: {
    role: "user",
    parts: [{ text: "You are the Gemini CLI." }],
  },
  contents: [
    { role: "user", parts: [{ text: "list my files" }] },
    {
      role: "model",
      parts: [
        { functionCall: { name: "list_directory", args: { path: "." } } },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "list_directory",
            response: { output: "one.ts" },
          },
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "list_directory",
          description: "List the files in a directory",
          parametersJsonSchema: { type: "object", properties: {} },
        },
      ],
    },
  ],
  generationConfig: {
    temperature: 0,
    thinkingConfig: { includeThoughts: true },
  },
};

describe("renderMarkdown for Gemini with an API key", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: "",
  });

  it("shows the system prompt, which sits beside the messages", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("puts the system prompt in its own section", () => {
    expect(out).toContain("<system-prompt>");
  });

  it("shows the tool name from inside the double nesting", () => {
    expect(out).toContain("### list_directory");
  });

  it("shows the tool description", () => {
    expect(out).toContain("List the files in a directory");
  });

  it("shows the user message", () => {
    expect(out).toContain("list my files");
  });

  it("uses the model role, not assistant", () => {
    expect(out).toContain('role="model"');
    expect(out).not.toContain('role="assistant"');
  });

  it("shows a tool call", () => {
    expect(out).toContain('<tool-use name="list_directory"');
  });

  it("shows a tool result", () => {
    expect(out).toContain('<tool-result name="list_directory"');
  });

  it("shows the sampling settings from the nested config", () => {
    expect(out).toContain("**temperature**: 0");
  });

  it("takes the model name from the URL, because the body has none", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for Gemini with a Google login", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1internal:streamGenerateContent",
    requestBody: body({
      model: "gemini-2.5-pro",
      project: "some-project",
      request: GEMINI_REQUEST,
    }),
    responseRaw: "",
  });

  it("unwraps the outer envelope and shows the system prompt", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("unwraps the outer envelope and shows the tools", () => {
    expect(out).toContain("### list_directory");
  });

  it("unwraps the outer envelope and shows the messages", () => {
    expect(out).toContain("list my files");
  });

  it("takes the model name from the body on this route", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for a Gemini response", () => {
  const stream =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":12}}\n';

  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: stream,
  });

  it("joins the reply text across events", () => {
    expect(out).toContain("Hello there");
  });

  it("shows the finish reason", () => {
    expect(out).toContain("**finish reason**: STOP");
  });

  it("shows the usage", () => {
    expect(out).toContain("totalTokenCount");
  });

  it("unwraps the response envelope used by the Google login route", () => {
    const wrapped = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1internal:streamGenerateContent",
      requestBody: body({ request: GEMINI_REQUEST }),
      responseRaw:
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Wrapped"}]},"finishReason":"STOP"}]}}\n',
    });
    expect(wrapped).toContain("Wrapped");
  });

  it("separates thinking from the reply", () => {
    const thought = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw:
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"pondering","thought":true},{"text":"answer"}]}}]}\n',
    });
    expect(thought).toContain("<thinking>");
    expect(thought).toContain("pondering");
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("renderMarkdown header redaction", () => {
  it("hides the authorization header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { authorization: "Bearer secret-token" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-token");
    expect(out).toContain("[REDACTED]");
  });

  it("hides the x-goog-api-key header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { "x-goog-api-key": "secret-goog-key" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-goog-key");
    expect(out).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Claude Code 2.1.x - tool search, context management, server-side tools
// ---------------------------------------------------------------------------

describe("renderMarkdown for Anthropic with tool search on", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Claude Code",
    renderer: "anthropic",
    path: "/v1/messages?beta=true",
    requestBody: body({
      model: "claude-haiku-4-5",
      system: [{ type: "text", text: "You are Claude Code." }],
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      tools: [
        { name: "Read", description: "Read a file", input_schema: {} },
        {
          name: "NotebookEdit",
          description: "Edit a notebook",
          input_schema: {},
          defer_loading: true,
        },
        { type: "tool_search_tool_regex_20251119", name: "tool_search" },
      ],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "tool_search",
              input: { query: "notebook" },
            },
            {
              type: "tool_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [{ type: "tool_reference", tool_name: "NotebookEdit" }],
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_reference", tool_name: "NotebookEdit" }],
        },
      ],
    }),
    responseRaw: "",
  });

  it("shows the context management edits next to the other settings", () => {
    expect(out).toContain("**context_management**");
    expect(out).toContain("clear_thinking_20251015");
  });

  it("marks a deferred tool, since the model sees only its name until it searches", () => {
    expect(out).toContain("### NotebookEdit (deferred)");
    expect(out).toContain("### Read\n");
    expect(out).not.toContain("### Read (deferred)");
  });

  it("shows a built-in tool's versioned type, which is all that identifies it", () => {
    expect(out).toContain("### tool_search");
    expect(out).toContain("**type**: tool_search_tool_regex_20251119");
  });

  it("renders a tool reference as a tag rather than a JSON dump", () => {
    expect(out).toContain('<tool-reference name="NotebookEdit" />');
  });

  it("renders a server-side tool call and its result under their own tags", () => {
    expect(out).toContain(
      '<server-tool-use name="tool_search" id="srvtoolu_1">'
    );
    expect(out).toContain(
      '<server-tool-result type="tool_search_tool_result" tool-use-id="srvtoolu_1">'
    );
  });
});

// ---------------------------------------------------------------------------
// Codex 0.160.0 - no instructions, tools inside an additional_tools item,
// custom (free-text) tool calls
// ---------------------------------------------------------------------------

describe("renderMarkdown for a Codex 0.160 request", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Codex",
    renderer: "openai",
    path: "/backend-api/codex/responses",
    requestBody: body({
      model: "gpt-6-astra",
      input: [
        {
          type: "additional_tools",
          id: "at_1",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [
                {
                  type: "custom",
                  name: "exec",
                  description: "Run JavaScript code",
                  format: { type: "grammar", syntax: "lark" },
                },
                {
                  type: "function",
                  name: "shell",
                  description: "Run a shell command",
                  parameters: { type: "object" },
                },
              ],
            },
          ],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are Codex." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "pong please" }],
        },
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "exec",
          input: "await t.shell('ls')",
        },
        { type: "custom_tool_call_output", call_id: "call_1", output: "a b" },
      ],
    }),
    responseRaw:
      'data: {"type":"response.output_item.added","item":{"type":"custom_tool_call","id":"ct_1","name":"exec"}}\n' +
      'data: {"type":"response.custom_tool_call_input.delta","item_id":"ct_1","delta":"await t.sh"}\n' +
      'data: {"type":"response.custom_tool_call_input.delta","item_id":"ct_1","delta":"ell(\'pwd\')"}\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n',
  });

  it("lists the tools carried inside the additional_tools item under <tools>", () => {
    expect(out).toContain("<tools>");
    expect(out).toContain("### exec");
    expect(out).toContain("### shell");
    expect(out).toContain("**namespace**: functions");
  });

  it("marks a custom tool's type and shows its format, since it has no JSON schema", () => {
    expect(out).toContain("**type**: custom");
    expect(out).toContain('"syntax": "lark"');
  });

  it("does not repeat the additional_tools item as a message", () => {
    expect(out).not.toContain('"type": "additional_tools"');
    expect(out).toContain(
      '<message index="1" role="developer">\n\nYou are Codex.'
    );
  });

  it("still shows the developer messages, roles and all, since that is where the system prompt lives now", () => {
    expect(out).toContain("You are Codex.");
    expect(out).toContain('role="developer"');
  });

  it("renders a custom tool call's free-text input as plain text, not JSON", () => {
    expect(out).toContain(
      '<tool-use name="exec" id="call_1">\n\n```\nawait t.shell(\'ls\')\n```'
    );
  });

  it("renders the custom tool call's output as a tool result", () => {
    expect(out).toContain('<tool-result call-id="call_1">\n\na b');
  });

  it("reassembles a streamed custom tool call from its input deltas", () => {
    expect(out).toContain(
      '<tool-use name="exec" id="ct_1">\n\n```\nawait t.shell(\'pwd\')\n```'
    );
  });
});

describe("renderMarkdown header redaction for Copilot", () => {
  it("hides the copilot-session-token header, which is a signed session credential", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "GitHub Copilot CLI",
      renderer: "openai",
      headers: { "copilot-session-token": "eyJ.secret.jwt" },
      path: "/responses",
      requestBody: body({ model: "x", input: "hi" }),
      responseRaw: "",
    });
    expect(out).not.toContain("eyJ.secret.jwt");
    expect(out).toContain("copilot-session-token: [REDACTED]");
  });
});
