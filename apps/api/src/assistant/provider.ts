import { DEFAULT_LLM_TIMEOUT_MS, type AssistantStatus, type LlmProvider } from "@trato/shared";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { createLlmProvider } from "@trato/llm";

export type LlmEnv = Pick<
  AppEnv,
  "LLM_PROVIDER" | "LLM_MODEL" | "LLM_API_KEY" | "LLM_BASE_URL" | "LLM_EFFORT" | "LLM_TIMEOUT_MS" | "LLM_STRUCTURED"
>;

/** `undefined` = use env; `null` = force "assistant disabled"; provider = inject (tests). */
let override: LlmProvider | null | undefined;

export function setLlmProviderForTests(provider: LlmProvider | null | undefined): void {
  override = provider;
}

export function llmTimeoutMs(env: LlmEnv): number {
  const n = Number(env.LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_LLM_TIMEOUT_MS;
}

/**
 * Provider for the assistant, or null when it is disabled (`LLM_PROVIDER=none`).
 * No config at all -> the deterministic `mock` provider (demo mode).
 */
export function getLlmProvider(env: LlmEnv): LlmProvider | null {
  if (override !== undefined) return override;
  const id = (env.LLM_PROVIDER ?? "").trim().toLowerCase() || "mock";
  if (id === "none") return null;
  const model = env.LLM_MODEL?.trim() || DEFAULT_MODELS[id];
  if (!model) {
    logger.warn("llm_provider_unsupported", { provider: id });
    return null;
  }
  if (id !== "mock" && !env.LLM_API_KEY) {
    logger.warn("llm_provider_missing_key", { provider: id });
    return null;
  }
  const structured = env.LLM_STRUCTURED === "prompted" ? "prompted" : env.LLM_STRUCTURED === "native" ? "native" : undefined;
  return createLlmProvider({
    provider: id as "anthropic" | "openai-compatible" | "mock",
    model,
    apiKey: env.LLM_API_KEY || undefined,
    baseUrl: env.LLM_BASE_URL?.trim() || undefined,
    effort: env.LLM_EFFORT?.trim() || undefined,
    timeoutMs: llmTimeoutMs(env),
    structured,
  });
}

/** Defaults when LLM_MODEL is unset. openai-compatible always needs an explicit model. */
const DEFAULT_MODELS: Record<string, string | undefined> = {
  mock: "mock-rules-v1",
  anthropic: "claude-opus-5-5",
};

/** Health / view status. Never includes keys. */
export function assistantStatus(env: LlmEnv): AssistantStatus {
  const p = getLlmProvider(env);
  return p ? { enabled: true, provider: p.id, model: p.model } : { enabled: false, provider: null, model: null };
}
