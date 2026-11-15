import { DEFAULT_LLM_TIMEOUT_MS, type AssistantStatus, type LlmProvider } from "@trato/shared";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { StubLlmProvider } from "./stub-provider";

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
  if (id === "mock") {
    // TODO(merge feat/llm): reemplazar por createLlmProvider de @trato/llm
    return new StubLlmProvider(env.LLM_MODEL?.trim() || undefined, llmTimeoutMs(env));
  }
  // TODO(merge feat/llm): "anthropic" | "openai-compatible" las construye createLlmProvider de @trato/llm.
  logger.warn("llm_provider_unsupported", { provider: id });
  return null;
}

/** Health / view status. Never includes keys. */
export function assistantStatus(env: LlmEnv): AssistantStatus {
  const p = getLlmProvider(env);
  return p ? { enabled: true, provider: p.id, model: p.model } : { enabled: false, provider: null, model: null };
}
