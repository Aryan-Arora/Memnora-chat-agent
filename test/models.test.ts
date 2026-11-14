import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "../src/models/index.js";

const request = {
  system: "System instructions",
  context: "Question context",
  messages: [{ role: "user" as const, content: "Hello" }],
};

test("OpenAI BYOK config uses the Responses API without storing provider state", async () => {
  const originalFetch = globalThis.fetch;
  let sentUrl = "";
  let sentAuthorization = "";
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    sentUrl = String(input);
    sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ output_text: "OpenAI works", usage: { input_tokens: 7, output_tokens: 3 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const models = createModels({ provider: "openai", apiKey: "test-key", fastModel: "fast-test", mainModel: "main-test" });
    const result = await models.main.complete(request);
    assert.equal(models.provider, "openai");
    assert.equal(models.fast.name, "fast-test");
    assert.equal(models.main.name, "main-test");
    assert.equal(result, "OpenAI works");
    assert.equal(sentUrl, "https://api.openai.com/v1/responses");
    assert.equal(sentAuthorization, "Bearer test-key");
    assert.equal(sentBody.model, "main-test");
    assert.equal(sentBody.store, false);
    assert.equal(sentBody.stream, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("OpenAI adapter yields typed SSE text deltas", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"type":"response.output_text.delta","delta":"Hello "}',
    'data: {"type":"response.output_text.delta","delta":"there"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
    "",
  ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const { main } = createModels({ provider: "openai", apiKey: "test-key", mainModel: "main-test" });
    let output = "";
    for await (const chunk of main.stream(request)) output += chunk;
    assert.equal(output, "Hello there");
  } finally { globalThis.fetch = originalFetch; }
});

test("OpenAI authentication errors never echo a user key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Bad key test-secret-key" } }), {
    status: 401, headers: { "content-type": "application/json" },
  });
  try {
    const { main } = createModels({ provider: "openai", apiKey: "test-secret-key" });
    await assert.rejects(main.complete(request), (error: Error) => {
      assert.match(error.message, /rejected the API key/);
      assert.doesNotMatch(error.message, /test-secret-key/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("MODEL_PROVIDER switches startup from Anthropic to OpenAI using only environment config", () => {
  const previous = {
    provider: process.env.MODEL_PROVIDER,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    fast: process.env.FAST_MODEL,
    main: process.env.MAIN_MODEL,
  };
  try {
    process.env.MODEL_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-env-key";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.FAST_MODEL = "env-fast";
    process.env.MAIN_MODEL = "env-main";
    const models = createModels();
    assert.equal(models.provider, "openai");
    assert.equal(models.fast.name, "env-fast");
    assert.equal(models.main.name, "env-main");
  } finally {
    for (const [key, value] of Object.entries({
      MODEL_PROVIDER: previous.provider, OPENAI_API_KEY: previous.openai,
      ANTHROPIC_API_KEY: previous.anthropic, FAST_MODEL: previous.fast, MAIN_MODEL: previous.main,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
