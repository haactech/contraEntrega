import type { ZodTypeDef, ZodType } from "zod";
import type { LlmErrorKind, LlmMessage, LlmProviderConfig, LlmRequest, LlmResult } from "@trato/shared";

/**
 * Pieces shared by every provider: config, JSON extraction, the single repair retry, timeouts and
 * result bookkeeping. No Node APIs here (this runs in Cloudflare Workers).
 */

/** Local extension of the shared config (kept here so `@trato/shared` stays untouched). */
export interface LlmFactoryConfig extends LlmProviderConfig {
  /** Anthropic only: server-side refusal fallback (default true). */
  serverFallback?: boolean;
  /** openai-compatible only: whether the model accepts images (default false). */
  vision?: boolean;
}

/** Default per-call budget when neither the request nor the config say otherwise. */
export const PROVIDER_DEFAULT_TIMEOUT_MS = 30_000;
export const PROVIDER_DEFAULT_MAX_TOKENS = 16_000;

/** `LlmResult` plus how many repair retries were used (0 or 1). Assignable to `LlmResult<T>`. */
export type LlmResultMeta<T> = LlmResult<T> & { repairs?: number };

export function repairsOf(result: LlmResult<unknown>): number {
  const r = (result as LlmResultMeta<unknown>).repairs;
  return typeof r === "number" ? r : 0;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RawAttempt =
  | { ok: true; text: string; usage: TokenUsage; model: string }
  | { ok: false; kind: LlmErrorKind; message: string };

/** One provider round-trip. Must never throw; classify errors into `RawAttempt`. */
export type Attempt = (messages: LlmMessage[], signal: AbortSignal) => Promise<RawAttempt>;

/* ------------------------------------------------------------------ JSON */

/** Parses `text` as JSON, tolerating code fences and prose around the first top-level object. */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct.ok) return direct;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (unfenced !== trimmed) {
    const r = tryParse(unfenced);
    if (r.ok) return r;
  }
  const slice = firstJsonObject(unfenced);
  return slice === null ? { ok: false } : tryParse(slice);
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** First balanced `{...}` in `text` (string-aware), or null. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; summary: string };

function parseAndValidate<T>(text: string, schema: ZodType<T, ZodTypeDef, unknown>): ParseOutcome<T> {
  const json = parseJsonLoose(text);
  if (!json.ok) return { ok: false, summary: "La respuesta no es un objeto JSON válido." };
  const r = schema.safeParse(json.value);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join(".") : "(raíz)"}: ${i.message}`)
    .join("; ");
  return { ok: false, summary: issues.slice(0, 600) };
}

/* ---------------------------------------------------------------- repair */

const MAX_ECHOED_OUTPUT_CHARS = 8_000;

export function repairMessages(original: LlmMessage[], badOutput: string, summary: string): LlmMessage[] {
  const echoed = badOutput.trim() === "" ? "(sin contenido)" : badOutput.slice(0, MAX_ECHOED_OUTPUT_CHARS);
  return [
    ...original,
    { role: "assistant", content: echoed },
    {
      role: "user",
      content:
        `Tu respuesta anterior no cumple el esquema: ${summary}\n` +
        "Responde únicamente con el objeto JSON corregido, sin texto adicional.",
    },
  ];
}

export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Runs `attempt` and validates with the request schema. If the output does not validate it retries
 * ONCE with the validation error appended; then gives up with `invalid_output`. The timeout is a
 * single budget for the whole call (both attempts). Tokens are summed over attempts.
 */
export async function generateWithRepair<T>(
  req: LlmRequest<T>,
  opts: { model: string; timeoutMs: number; attempt: Attempt },
): Promise<LlmResultMeta<T>> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const signal = timeoutSignal(req.timeoutMs ?? opts.timeoutMs);
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let messages = req.messages;
  let model = opts.model;
  let repairs = 0;

  for (;;) {
    const raw = await opts.attempt(messages, signal);
    if (!raw.ok) return { ok: false, kind: raw.kind, message: raw.message, latencyMs: elapsed(), repairs };
    usage.inputTokens += raw.usage.inputTokens;
    usage.outputTokens += raw.usage.outputTokens;
    model = raw.model;

    const parsed = parseAndValidate(raw.text, req.schema);
    if (parsed.ok) return { ok: true, value: parsed.value, usage, latencyMs: elapsed(), model, repairs };
    if (repairs >= 1) {
      return {
        ok: false,
        kind: "invalid_output",
        message: `La salida no cumple el esquema tras una reparación: ${parsed.summary}`,
        latencyMs: elapsed(),
        repairs,
      };
    }
    repairs++;
    messages = repairMessages(req.messages, raw.text, parsed.summary);
  }
}

/* ----------------------------------------------------------- JSON schema */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rewrites `type: [X, "null"]` into `anyOf: [{type: X}, {type: "null"}]`, the nullable form every
 * strict structured-output implementation accepts. Pure; returns a new tree.
 */
export function strictifySchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictifySchema);
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) out[k] = strictifySchema(v);
  const t = out["type"];
  if (Array.isArray(t) && t.length > 1 && !("anyOf" in out)) {
    const { type: _t, ...rest } = out;
    return { ...rest, anyOf: t.map((x) => ({ type: x })) };
  }
  return out;
}

/* ---------------------------------------------------------------- errors */

export function isAbortLike(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
