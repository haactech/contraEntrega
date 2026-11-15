import type { ZodTypeDef, ZodType } from "zod";

/** Provider-agnostic LLM interface (types only; implementations live in `@trato/llm`). */

export const LLM_PROVIDER_IDS = ["anthropic", "openai-compatible", "mock"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: LlmImageMediaType; dataBase64: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmRequest<T> {
  system: string;
  messages: LlmMessage[];
  /** Validates the model output. Input type is unknown on purpose (defaults/transforms allowed). */
  schema: ZodType<T, ZodTypeDef, unknown>;
  schemaName: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export type LlmErrorKind =
  | "refusal"
  | "invalid_output"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "provider_error";

export type LlmResult<T> =
  | {
      ok: true;
      value: T;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      model: string;
    }
  | { ok: false; kind: LlmErrorKind; message: string; latencyMs: number };

export interface LlmProvider {
  /** "anthropic" | "openai-compatible" | "mock" */
  readonly id: string;
  readonly model: string;
  readonly capabilities: { vision: boolean; structuredOutput: "native" | "prompted" };
  generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export interface LlmProviderConfig {
  provider: LlmProviderId;
  model: string;
  /** Secret; never logged or returned by the API. */
  apiKey?: string;
  baseUrl?: string;
  effort?: string;
  /** Default 15000. */
  timeoutMs?: number;
  structured?: "native" | "prompted";
}

export const DEFAULT_LLM_TIMEOUT_MS = 15_000;
