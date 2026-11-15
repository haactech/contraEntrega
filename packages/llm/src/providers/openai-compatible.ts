import { toJsonSchema } from "@trato/shared";
import type { LlmContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResult } from "@trato/shared";
import {
  PROVIDER_DEFAULT_TIMEOUT_MS,
  generateWithRepair,
  isAbortLike,
  strictifySchema,
  truncate,
  type Attempt,
  type LlmFactoryConfig,
  type RawAttempt,
} from "../core";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiCompatibleDeps {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

type WirePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
interface WireMessage {
  role: "system" | "user" | "assistant";
  content: string | WirePart[];
}

function toWire(m: LlmMessage): WireMessage {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map(
      (p: LlmContentPart): WirePart =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } },
    ),
  };
}

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "output";

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function contentText(c: string | Array<{ type?: string; text?: string }> | null | undefined): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? "").join("");
  return "";
}

/** Parses a 2xx chat-completions body into text or a typed failure. */
export function readChatCompletion(body: ChatCompletion, fallbackModel: string): RawAttempt {
  const choice = body.choices?.[0];
  if (!choice) return { ok: false, kind: "provider_error", message: "La respuesta del proveedor no trae choices." };
  const refusal = choice.message?.refusal;
  if (typeof refusal === "string" && refusal.trim() !== "") {
    return { ok: false, kind: "refusal", message: "El modelo rechazó la solicitud." };
  }
  if (choice.finish_reason === "content_filter") {
    return { ok: false, kind: "refusal", message: "El proveedor filtró el contenido." };
  }
  if (choice.finish_reason === "length") {
    return { ok: false, kind: "invalid_output", message: "La respuesta se cortó por límite de tokens." };
  }
  return {
    ok: true,
    text: contentText(choice.message?.content),
    model: body.model ?? fallbackModel,
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
  };
}

export function classifyHttpStatus(status: number): Extract<RawAttempt, { ok: false }> {
  if (status === 401 || status === 403) {
    return { ok: false, kind: "auth", message: `Credenciales rechazadas por el proveedor (${status}).` };
  }
  if (status === 429) return { ok: false, kind: "rate_limited", message: "El proveedor limitó las solicitudes (429)." };
  if (status === 408) return { ok: false, kind: "timeout", message: "El proveedor devolvió 408." };
  return { ok: false, kind: "provider_error", message: `Error del proveedor (HTTP ${status}).` };
}

export function createOpenAiCompatibleProvider(
  config: LlmFactoryConfig,
  deps: OpenAiCompatibleDeps = {},
): LlmProvider {
  const baseUrl = (config.baseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const structured = config.structured ?? "native";
  const defaultTimeout = config.timeoutMs ?? PROVIDER_DEFAULT_TIMEOUT_MS;
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  return {
    id: "openai-compatible",
    model: config.model,
    capabilities: { vision: config.vision === true, structuredOutput: structured },

    async generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const schema = strictifySchema(toJsonSchema(req.schema)) as Record<string, unknown>;
      const system =
        structured === "prompted"
          ? `${req.system}\n\nResponde ÚNICAMENTE con un objeto JSON (sin texto adicional ni bloques de código) que cumpla este JSON Schema:\n${JSON.stringify(schema)}`
          : req.system;
      const responseFormat =
        structured === "native"
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: { name: safeName(req.schemaName), schema, strict: true },
              },
            }
          : {};

      const attempt: Attempt = async (messages: LlmMessage[], signal: AbortSignal) => {
        const body = {
          model: config.model,
          messages: [{ role: "system" as const, content: system }, ...messages.map(toWire)],
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          ...responseFormat,
        };
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          if (isAbortLike(e) || signal.aborted) {
            return { ok: false, kind: "timeout", message: "Se agotó el tiempo de espera del proveedor." };
          }
          return { ok: false, kind: "provider_error", message: "No se pudo conectar con el proveedor." };
        }
        if (!res.ok) {
          const failure = classifyHttpStatus(res.status);
          // Surface the provider's own error text (never our request) to help diagnose config issues.
          const detail = await res
            .json()
            .then((j) => (j as ChatCompletion).error?.message)
            .catch(() => undefined);
          return detail ? { ...failure, message: truncate(`${failure.message} ${detail}`, 300) } : failure;
        }
        let json: ChatCompletion;
        try {
          json = (await res.json()) as ChatCompletion;
        } catch (e) {
          if (isAbortLike(e) || signal.aborted) {
            return { ok: false, kind: "timeout", message: "Se agotó el tiempo de espera del proveedor." };
          }
          return { ok: false, kind: "provider_error", message: "Respuesta del proveedor no es JSON." };
        }
        return readChatCompletion(json, config.model);
      };

      return generateWithRepair(req, { model: config.model, timeoutMs: defaultTimeout, attempt });
    },
  };
}
