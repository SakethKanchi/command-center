import { AppError } from "@server/infra/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLlmClient,
  type LlmJsonSchema,
  resetLlmResponseModes,
} from "./index";

// ---------------------------------------------------------------------------
// fetch stub. Every test drives the client through this, so nothing here can
// reach the network and `calls` is the record of what was actually sent.
// ---------------------------------------------------------------------------

/**
 * The request shape the client is contracted to send. Parsing rather than
 * casting means a malformed body fails the test at the stub, not three
 * assertions later.
 */
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  response_format: z
    .object({
      type: z.string(),
      json_schema: z
        .object({
          name: z.string(),
          strict: z.boolean(),
          schema: z.record(z.unknown()),
        })
        .optional(),
    })
    .optional(),
});

type LlmRequest = z.infer<typeof requestSchema>;

type StubCall = {
  url: string;
  method: string;
  headers: Headers;
  body: LlmRequest;
};

type Reply = { status?: number; body: string };

function createStub(replies: Reply[]) {
  const calls: StubCall[] = [];
  const queue = [...replies];

  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: requestSchema.parse(JSON.parse(String(init?.body ?? "{}"))),
    });

    const reply = queue.shift();
    if (!reply)
      throw new Error(`stub ran out of replies at call ${calls.length}`);
    return new Response(reply.body, { status: reply.status ?? 200 });
  };

  return { fetchImpl, calls };
}

function requestAt(calls: StubCall[], index: number): LlmRequest {
  const call = calls[index];
  if (!call) throw new Error(`no request was made at index ${index}`);
  return call.body;
}

function userPromptOf(request: LlmRequest): string {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

/** Wraps content in the chat-completions envelope the client reads. */
function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const SCHEMA: LlmJsonSchema = {
  name: "demo",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

const FORMAT_REJECTION = JSON.stringify({
  error: { message: "response_format json_schema is not supported by model" },
});

function makeClient(fetchImpl: typeof fetch) {
  return createLlmClient({
    fetchImpl,
    apiKey: "k-123",
    baseUrl: "https://llm.test/v1/",
    model: "test/model",
  });
}

beforeEach(() => {
  resetLlmResponseModes();
  // The developer's own provider credentials must never leak into a run.
  vi.stubEnv("LLM_API_KEY", "env-key");
  vi.stubEnv("LLM_BASE_URL", "https://env.test/v1");
  vi.stubEnv("LLM_MODEL", "env/model");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("completeJson", () => {
  it("posts the json_schema response format, model and bearer token", async () => {
    const { fetchImpl, calls } = createStub([
      { body: completion('{"ok":true}') },
    ]);
    const client = makeClient(fetchImpl);

    const result = await client.completeJson<{ ok: boolean }>({
      prompt: "say ok",
      schema: SCHEMA,
    });

    expect(result).toEqual({ ok: true });
    expect(client.model).toBe("test/model");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer k-123");

    const request = requestAt(calls, 0);
    expect(request.model).toBe("test/model");
    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "demo", strict: true, schema: SCHEMA.schema },
    });
    expect(userPromptOf(request)).toContain("say ok");
  });

  it("falls back to env configuration when no options are passed", async () => {
    const { fetchImpl, calls } = createStub([
      { body: completion('{"ok":true}') },
    ]);
    const client = createLlmClient({ fetchImpl });

    await client.completeJson({ prompt: "say ok", schema: SCHEMA });

    expect(client.model).toBe("env/model");
    expect(calls[0]?.url).toBe("https://env.test/v1/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer env-key");
  });

  it("parses a markdown-fenced response body", async () => {
    const { fetchImpl } = createStub([
      {
        body: completion(
          'Here you go:\n```json\n{"ok": true, "n": 2}\n```\nHope that helps.',
        ),
      },
    ]);

    const result = await makeClient(fetchImpl).completeJson<{
      ok: boolean;
      n: number;
    }>({ prompt: "say ok", schema: SCHEMA });

    expect(result).toEqual({ ok: true, n: 2 });
  });
});

describe("response-mode negotiation", () => {
  it("downgrades to json_object, then to a prompt instruction, and remembers", async () => {
    const { fetchImpl, calls } = createStub([
      { status: 400, body: FORMAT_REJECTION },
      { status: 400, body: FORMAT_REJECTION },
      { body: completion('{"ok":true}') },
      { body: completion('{"ok":false}') },
      { body: completion('{"ok":true}') },
    ]);

    const client = makeClient(fetchImpl);
    expect(
      await client.completeJson({ prompt: "say ok", schema: SCHEMA }),
    ).toEqual({ ok: true });

    expect(calls).toHaveLength(3);
    expect(requestAt(calls, 0).response_format?.type).toBe("json_schema");
    expect(requestAt(calls, 1).response_format?.type).toBe("json_object");
    expect(requestAt(calls, 1).response_format?.json_schema).toBeUndefined();
    expect(requestAt(calls, 2).response_format).toBeUndefined();
    expect(userPromptOf(requestAt(calls, 2))).toContain(
      "Reply with ONLY one JSON object",
    );

    // The surviving mode is reused: one request, no re-probe.
    expect(
      await client.completeJson({ prompt: "again", schema: SCHEMA }),
    ).toEqual({ ok: false });
    expect(calls).toHaveLength(4);
    expect(requestAt(calls, 3).response_format).toBeUndefined();

    // And it is remembered for the process, not just for this client.
    await makeClient(fetchImpl).completeJson({
      prompt: "third",
      schema: SCHEMA,
    });
    expect(calls).toHaveLength(5);
    expect(requestAt(calls, 4).response_format).toBeUndefined();
  });

  it("does not downgrade on a 400 that is not about the response format", async () => {
    const { fetchImpl, calls } = createStub([
      {
        status: 400,
        body: JSON.stringify({ error: { message: "context length exceeded" } }),
      },
    ]);

    const error = await rejectionOf(
      makeClient(fetchImpl).completeJson({ prompt: "x", schema: SCHEMA }),
    );

    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("context length exceeded");
    expect(calls).toHaveLength(1);
  });
});

describe("failure mapping", () => {
  it("retries unparseable content, then reports what came back", async () => {
    const junk = "sorry, I cannot comply with that request";
    const { fetchImpl, calls } = createStub([
      { body: completion(junk) },
      { body: completion(junk) },
    ]);

    const error = await rejectionOf(
      makeClient(fetchImpl).completeJson({ prompt: "x", schema: SCHEMA }),
    );

    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("after 2 attempts");
    expect(error.message).toContain("sorry, I cannot comply");
    expect(calls).toHaveLength(2);
  });

  it("honours an explicit maxAttempts", async () => {
    const { fetchImpl, calls } = createStub([
      { body: completion("nope") },
      { body: completion("nope") },
      { body: completion("nope") },
    ]);

    await rejectionOf(
      makeClient(fetchImpl).completeJson({
        prompt: "x",
        schema: SCHEMA,
        maxAttempts: 3,
      }),
    );

    expect(calls).toHaveLength(3);
  });

  it("maps 401 to unauthorized without retrying", async () => {
    const { fetchImpl, calls } = createStub([
      { status: 401, body: JSON.stringify({ error: "invalid api key" }) },
    ]);

    const error = await rejectionOf(
      makeClient(fetchImpl).completeJson({ prompt: "x", schema: SCHEMA }),
    );

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("maps an exhausted 429 retry budget to rate limited", async () => {
    const { fetchImpl, calls } = createStub([
      { status: 429, body: "slow down" },
      { status: 429, body: "slow down" },
      { status: 429, body: "slow down" },
    ]);

    const error = await rejectionOf(
      makeClient(fetchImpl).completeJson({ prompt: "x", schema: SCHEMA }),
    );

    expect(error.code).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(3);
  });

  it("refuses to call without a key and names the variable", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const { fetchImpl, calls } = createStub([]);

    const error = await rejectionOf(
      createLlmClient({ fetchImpl }).completeJson({
        prompt: "x",
        schema: SCHEMA,
      }),
    );

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("LLM_API_KEY");
    expect(calls).toHaveLength(0);
  });
});
