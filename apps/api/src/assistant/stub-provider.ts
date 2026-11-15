import {
  DEFAULT_LLM_TIMEOUT_MS,
  missingFieldsMessage,
  type AssistantTurn,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type ProposalField,
} from "@trato/shared";

/**
 * Minimal deterministic provider so the app works in demo mode and in tests without keys.
 * It is a rules-based extractor (Spanish amounts: «20 mil», «$20,000», «20k», «30 %», «la mitad»).
 *
 * TODO(merge feat/llm): replace by `createLlmProvider` from `@trato/llm` (its `mock` provider).
 */

interface MoneyMatch {
  value: number;
  start: number;
  end: number;
}

const ADVANCE_WORDS = /\b(anticipo|adelanto|empezar|entrada|enganche|arrancar|de inicio)\b/g;
const TOTAL_WORDS = /\b(total|cuesta|cobro|cobrar|precio|en total)\b/g;
const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const strip = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function parseNumber(raw: string): number {
  // «20,000» / «20.000» thousands separators vs «1.5» decimals.
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ""));
  return Number(raw.replace(",", "."));
}

function findAmounts(text: string): MoneyMatch[] {
  const out: MoneyMatch[] = [];
  const re = /(\$)?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(mil\b|k\b|pesos\b|mxn\b)?/gi;
  for (const m of text.matchAll(re)) {
    const [whole, dollar, num, unit] = m;
    if (num === undefined || m.index === undefined) continue;
    if (text.slice(m.index + whole.length, m.index + whole.length + 1) === "%") continue;
    let value = parseNumber(num);
    const u = (unit ?? "").toLowerCase();
    if (u === "mil" || u === "k") value *= 1000;
    const looksLikeMoney = Boolean(dollar) || u !== "" || value >= 100;
    if (!looksLikeMoney || !Number.isFinite(value) || value <= 0) continue;
    out.push({ value, start: m.index, end: m.index + whole.length });
  }
  return out;
}

function nearestAmount(amounts: MoneyMatch[], pos: number): number {
  let best = -1;
  let bestDist = Infinity;
  amounts.forEach((a, i) => {
    const d = pos < a.start ? a.start - pos : pos > a.end ? pos - a.end : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function classify(text: string, amounts: MoneyMatch[]): { total: number | null; advance: number | null } {
  const folded = strip(text);
  const adv = new Set<number>();
  const tot = new Set<number>();
  for (const m of folded.matchAll(ADVANCE_WORDS)) {
    const i = nearestAmount(amounts, m.index ?? 0);
    if (i >= 0) adv.add(i);
  }
  for (const m of folded.matchAll(TOTAL_WORDS)) {
    const i = nearestAmount(amounts, m.index ?? 0);
    if (i >= 0 && !adv.has(i)) tot.add(i);
  }
  let total = tot.size > 0 ? amounts[[...tot][0] as number]?.value ?? null : null;
  const advance = adv.size > 0 ? amounts[[...adv][0] as number]?.value ?? null : null;
  if (total === null) {
    const free = amounts.filter((_, i) => !adv.has(i));
    if (free.length > 0) total = Math.max(...free.map((a) => a.value));
  }
  return { total, advance };
}

function resolveDate(text: string, today: string | null): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso?.[1]) return iso[1];
  if (!today) return null;
  const folded = strip(text);
  const idx = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(folded));
  if (idx < 0) return null;
  const base = new Date(`${today}T12:00:00Z`);
  const delta = ((idx - base.getUTCDay() + 7) % 7) || 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

interface ParsedState {
  today: string | null;
  speaker: "SELLER" | "BUYER";
  agreementStatus: string | null;
  base: {
    title: string;
    description: string;
    acceptanceCriteria: string;
    buyerName: string;
    dueDate: string | null;
    totalMxn: number;
    advanceMxn: number;
  } | null;
  allowed: string[];
}

function readState(req: LlmRequest<unknown>): ParsedState {
  const first = req.messages[0];
  const head = typeof first?.content === "string" ? first.content : "";
  const jsonText = /Estado oficial[^\n]*\n(\{.*\})\n/s.exec(head)?.[1];
  const empty: ParsedState = { today: null, speaker: "SELLER", agreementStatus: null, base: null, allowed: [] };
  if (!jsonText) return empty;
  try {
    const s = JSON.parse(jsonText) as {
      hoy?: string;
      habla?: string;
      acuerdo?: { estado?: string; terminos?: ParsedState["base"] } | null;
      propuestaAbierta?: { terminos?: ParsedState["base"] } | null;
      accionesPermitidas?: { prestador?: string[]; comprador?: string[] };
    };
    const speaker = s.habla === "Comprador" ? "BUYER" : "SELLER";
    return {
      today: s.hoy ?? null,
      speaker,
      agreementStatus: s.acuerdo?.estado ?? null,
      base: s.propuestaAbierta?.terminos ?? s.acuerdo?.terminos ?? null,
      allowed: (speaker === "BUYER" ? s.accionesPermitidas?.comprador : s.accionesPermitidas?.prestador) ?? [],
    };
  } catch {
    return empty;
  }
}

function lastHumanText(req: LlmRequest<unknown>): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    const all = [...m.content.matchAll(/<mensaje autor="(Prestador|Comprador)">(.*?)<\/mensaje>/gs)];
    const last = all[all.length - 1];
    if (last?.[2] !== undefined) return last[2].trim();
  }
  return "";
}

function turn(partial: Partial<AssistantTurn> & Pick<AssistantTurn, "intent" | "reply">): AssistantTurn {
  return { proposal: null, missingFields: [], suggestedAction: null, ...partial };
}

function respond(req: LlmRequest<unknown>): AssistantTurn {
  const text = lastHumanText(req);
  const st = readState(req);
  const folded = strip(text);

  // After acceptance the proposal flow is closed; only light help.
  if (st.agreementStatus !== null && st.agreementStatus !== "DRAFT" && st.agreementStatus !== "SHARED") {
    const payAction = (["PAY_ADVANCE", "PAY_BALANCE"] as const).find((a) => st.allowed.includes(a));
    if (/\bpag/.test(folded) && payAction) {
      return turn({ intent: "SUGGEST_ACTION", reply: "Puedes pagar desde la tarjeta de pago de esta conversación.", suggestedAction: payAction });
    }
    return turn({ intent: "ANSWER", reply: "Aquí estoy. Los estados oficiales del trato están en las tarjetas de la conversación." });
  }

  const amounts = findAmounts(text);
  const { total: totalFound, advance: advanceFound } = classify(text, amounts);
  const pct = /(\d{1,2}(?:[.,]\d+)?)\s*%/.exec(text);
  const half = /\bla mitad\b/.test(folded);
  const dueDate = resolveDate(text, st.today);
  const base = st.base;

  const total = totalFound ?? base?.totalMxn ?? null;
  let advance = advanceFound;
  if (advance === null && total !== null) {
    if (pct?.[1]) advance = Math.round(total * Number(pct[1].replace(",", ".")) * 100) / 10000;
    else if (half) advance = total / 2;
  }
  advance ??= base?.advanceMxn ?? null;

  if (base) {
    const changed =
      (totalFound !== null && totalFound !== base.totalMxn) ||
      (advance !== null && advance !== base.advanceMxn) ||
      (dueDate !== null && dueDate !== base.dueDate);
    if (!changed || total === null || advance === null) {
      return turn({ intent: "ANSWER", reply: "Entendido. Si quieres cambiar el anticipo, el total o la fecha, dímelo y preparo una nueva propuesta." });
    }
    return turn({
      intent: "REVISE_TERMS",
      reply: "Listo, preparé una nueva versión de la propuesta con ese cambio. El prestador debe confirmarla.",
      proposal: { ...base, totalMxn: total, advanceMxn: advance, dueDate: dueDate ?? base.dueDate },
    });
  }

  const title = (text.split(/\s+para\s+|[,.;\n]|\$|\d/i)[0] ?? "").trim().slice(0, 80);
  const named = /\bpara\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/.exec(text)?.[1] ?? null;
  const missing: ProposalField[] = [];
  if (title.length < 3) missing.push("title");
  if (total === null) missing.push("total");
  if (advance === null) missing.push("advance");
  if (missing.length > 0) {
    return turn({
      intent: "ASK_CLARIFICATION",
      reply: amounts.length === 0 && title.length < 3
        ? "Cuéntame qué vas a hacer, para quién y cuánto cobras."
        : missingFieldsMessage(missing),
      missingFields: missing,
    });
  }
  return turn({
    intent: "PROPOSE_TERMS",
    reply: "Esto es lo que entendí. Revisa la tarjeta y, si está bien, confírmala para compartirla.",
    proposal: {
      title: title.charAt(0).toUpperCase() + title.slice(1),
      description: "",
      acceptanceCriteria: `Trabajo entregado conforme a lo acordado: ${title}.`,
      totalMxn: total as number,
      advanceMxn: advance as number,
      dueDate,
      buyerName: named,
    },
  });
}

export class StubLlmProvider implements LlmProvider {
  readonly id = "mock";
  readonly model: string;
  readonly capabilities = { vision: false, structuredOutput: "prompted" } as const;
  readonly timeoutMs: number;

  constructor(model = "mock-rules", timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    const parsed = req.schema.safeParse(respond(req));
    const latencyMs = Date.now() - started;
    if (!parsed.success) return { ok: false, kind: "invalid_output", message: "invalid_output", latencyMs };
    const inChars = req.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
    return {
      ok: true,
      value: parsed.data,
      usage: { inputTokens: Math.ceil(inChars / 4), outputTokens: Math.ceil(JSON.stringify(parsed.data).length / 4) },
      latencyMs,
      model: this.model,
    };
  }
}
