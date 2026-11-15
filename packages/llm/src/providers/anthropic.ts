import Anthropic from "@anthropic-ai/sdk";
import { toJsonSchema } from "@trato/shared";
import type { LlmContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResult } from "@trato/shared";
import {
  PROVIDER_DEFAULT_MAX_TOKENS,
  PROVIDER_DEFAULT_TIMEOUT_MS,
  generateWithRepair,
  strictifySchema,
  truncate,
  type Attempt,
  type LlmFactoryConfig,
  type RawAttempt,
} from "../core";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/**
 * Models that understand `fallbacks: "default"`. Older models would reject (or ignore) it, so the
 * server-side fallback is switched off for them automatically.
 */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5(-|$)/.test(model);
}

export function parseEffort(effort: string | undefined): AnthropicEffort | undefined {
  const e = effort?.trim().toLowerCase();
  if (!e) return undefined;
  if ((ANTHROPIC_EFFORTS as readonly string[]).includes(e)) return e as AnthropicEffort;
  throw new Error(`LLM_EFFORT inválido: usa ${ANTHROPIC_EFFORTS.join(", ")}`);
}

export interface AnthropicDeps {
  /** Injected into the SDK client (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } };

function toBlocks(content: string | LlmContentPart[]): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((p): ContentBlock =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } },
  );
}

/** Structural subset of `Message` / `BetaMessage` that the parser needs. */
interface ResponseLike {
  model: string;
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

/** Maps an SDK response to text or a typed failure. `stop_reason` is checked before the content. */
export function readResponse(msg: ResponseLike): RawAttempt {
  switch (msg.stop_reason) {
    case "refusal":
      return { ok: false, kind: "refusal", message: "El modelo rechazó la solicitud." };
    case "max_tokens":
      return { ok: false, kind: "invalid_output", message: "La respuesta se cortó por max_tokens." };
    case "model_context_window_exceeded":
      return { ok: false, kind: "invalid_output", message: "La conversación excede la ventana de contexto." };
    default:
      break;
  }
  // With server-side fallback, text before the last `fallback` block belongs to the model that declined.
  let from = 0;
  msg.content.forEach((b, i) => {
    if (b.type === "fallback") from = i + 1;
  });
  const text = msg.content
    .slice(from)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const u = msg.usage;
  return {
    ok: true,
    text,
    model: msg.model,
    usage: {
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    },
  };
}

/** Typed-class classification, most specific first. Never inspects message strings. */
export function classifyAnthropicError(e: unknown): Extract<RawAttempt, { ok: false }> {
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError) {
    return { ok: false, kind: "timeout", message: "Se agotó el tiempo de espera del proveedor." };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { ok: false, kind: "rate_limited", message: "El proveedor limitó las solicitudes (429)." };
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { ok: false, kind: "auth", message: `Credenciales rechazadas por el proveedor (${e.status}).` };
  }
  if (e instanceof Anthropic.RequestTimeoutError) {
    return { ok: false, kind: "timeout", message: "El proveedor devolvió 408." };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { ok: false, kind: "provider_error", message: "No se pudo conectar con el proveedor." };
  }
  if (e instanceof Anthropic.APIError) {
    return { ok: false, kind: "provider_error", message: truncate(`Error del proveedor (${e.status ?? "?"}).`) };
  }
  return { ok: false, kind: "provider_error", message: "Error inesperado al llamar al proveedor." };
}

export function createAnthropicProvider(config: LlmFactoryConfig, deps: AnthropicDeps = {}): LlmProvider {
  const model = config.model || ANTHROPIC_DEFAULT_MODEL;
  const effort = parseEffort(config.effort);
  const useFallback = config.serverFallback !== false && supportsServerFallback(model);
  const defaultTimeout = config.timeoutMs ?? PROVIDER_DEFAULT_TIMEOUT_MS;

  const client = config.apiKey
    ? new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        maxRetries: 1,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    : null;

  return {
    id: "anthropic",
    model,
    capabilities: { vision: true, structuredOutput: "native" },

    async generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      if (!client) {
        return { ok: false, kind: "auth", message: "Falta la API key del proveedor.", latencyMs: 0 };
      }
      const outputConfig = {
        format: {
          type: "json_schema" as const,
          schema: strictifySchema(toJsonSchema(req.schema)) as Record<string, unknown>,
        },
        ...(effort ? { effort } : {}),
      };
      const system = [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }];
      const maxTokens = req.maxTokens ?? PROVIDER_DEFAULT_MAX_TOKENS;

      const attempt: Attempt = async (messages: LlmMessage[], signal: AbortSignal) => {
        const wire = messages.map((m) => ({ role: m.role, content: toBlocks(m.content) }));
        try {
          const msg = useFallback
            ? await client.beta.messages.create(
                {
                  model,
                  max_tokens: maxTokens,
                  system,
                  messages: wire,
                  output_config: outputConfig,
                  betas: [SERVER_FALLBACK_BETA],
                  fallbacks: "default",
                },
                { signal },
              )
            : await client.messages.create(
                { model, max_tokens: maxTokens, system, messages: wire, output_config: outputConfig },
                { signal },
              );
          return readResponse(msg);
        } catch (e) {
          return classifyAnthropicError(e);
        }
      };

      return generateWithRepair(req, { model, timeoutMs: defaultTimeout, attempt });
    },
  };
}
