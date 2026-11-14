// Picks real models when a key exists, stubs otherwise, so `npm run dev` always works.
import type { ModelAdapter } from "../types.js";
import { createAnthropicModel } from "./anthropic.js";
import { createOpenAIModel } from "./openai.js";
import { createStubModel } from "./stub.js";

export type ModelProvider = "anthropic" | "openai";
export interface ModelConfig { provider: ModelProvider; apiKey: string; fastModel?: string; mainModel?: string }

/** Request config wins; environment variables remain a convenient local fallback. */
export function createModels(config?: ModelConfig): { fast: ModelAdapter; main: ModelAdapter; live: boolean; provider: ModelProvider | "stub" } {
  const envProvider = process.env.MODEL_PROVIDER === "openai" || process.env.MODEL_PROVIDER === "anthropic"
    ? process.env.MODEL_PROVIDER : undefined;
  const provider = config?.provider ?? envProvider ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai");
  const apiKey = config?.apiKey ?? (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
  if (apiKey && provider === "openai") {
    return {
      fast: createOpenAIModel(config?.fastModel || process.env.FAST_MODEL || "gpt-6-luna", apiKey),
      main: createOpenAIModel(config?.mainModel || process.env.MAIN_MODEL || "gpt-6.1-sol", apiKey),
      live: true,
      provider,
    };
  }
  if (apiKey) {
    return {
      fast: createAnthropicModel(config?.fastModel || process.env.FAST_MODEL || "claude-haiku-5-5", apiKey),
      main: createAnthropicModel(config?.mainModel || process.env.MAIN_MODEL || "claude-sonnet-5-5", apiKey),
      live: true,
      provider,
    };
  }
  return { fast: createStubModel("stub-fast"), main: createStubModel("stub-main"), live: false, provider: "stub" };
}
