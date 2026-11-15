/** Structured logger that redacts anything sensitive (spec §I). */
const SENSITIVE_KEY = /clabe|phone|token|authorization|signature|secret|pin|cookie|password|qrstring|taxid/i;
const SENSITIVE_VALUE: ReadonlyArray<[RegExp, string]> = [
  [/\b\d{18}\b/g, "[clabe]"],
  [/\/t\/[A-Za-z0-9_-]{20,}/g, "/t/[token]"],
  [/\/tratos\/[A-Za-z0-9_-]{20,}/g, "/tratos/[token]"],
  [/Bearer\s+\S+/gi, "Bearer [redacted]"],
];

function redactString(s: string): string {
  return SENSITIVE_VALUE.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

type Level = "info" | "warn" | "error";
function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...(data ? (redact(data) as Record<string, unknown>) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
