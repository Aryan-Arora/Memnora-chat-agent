// OpenAI adapter over the Responses API. Plain fetch keeps the provider boundary
// visible and avoids making the whole agent depend on a provider SDK.
import type { CompletionRequest, ModelAdapter, Usage } from "../types.js";

type ResponseBody = {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export function createOpenAIModel(model: string, apiKey: string): ModelAdapter {
  if (!apiKey) throw new Error("An OpenAI API key is required");

  const usage = (value?: ResponseBody["usage"]): Usage => ({
    inputTokens: value?.input_tokens ?? 0,
    outputTokens: value?.output_tokens ?? 0,
    cacheReadTokens: 0,
  });

  async function call(req: CompletionRequest, stream: boolean): Promise<Response> {
    const instructions = req.context ? `${req.system}\n\n${req.context}` : req.system;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions,
        input: req.messages.filter((message) => message.role !== "tool"),
        max_output_tokens: req.maxTokens ?? 1024,
        stream,
        // Memory belongs to Memnora's SQLite store, not the provider's response store.
        store: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ResponseBody;
      if (response.status === 401 || response.status === 403) {
        throw new Error("OpenAI rejected the API key. Check the selected provider and key, then try again.");
      }
      throw new Error(`OpenAI ${response.status}: ${body.error?.message ?? response.statusText}`);
    }
    return response;
  }

  return {
    name: model,
    async complete(req) {
      const body = await (await call(req, false)).json() as ResponseBody;
      req.onUsage?.(usage(body.usage));
      return body.output_text ?? body.output?.flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("") ?? "";
    },
    async *stream(req) {
      const response = await call(req, true);
      const decoder = new TextDecoder();
      let buffer = "";
      let finalUsage: Usage | undefined;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((value) => value.startsWith("data: "));
          if (!line || line === "data: [DONE]") continue;
          const event = JSON.parse(line.slice(6)) as {
            type?: string; delta?: string; response?: ResponseBody; error?: { message?: string };
          };
          if (event.type === "response.output_text.delta" && event.delta) yield event.delta;
          if (event.type === "response.completed") finalUsage = usage(event.response?.usage);
          if (event.type === "error" || event.type === "response.failed") {
            throw new Error(event.error?.message ?? event.response?.error?.message ?? "OpenAI stream failed");
          }
        }
      }
      if (finalUsage) req.onUsage?.(finalUsage);
    },
  };
}
