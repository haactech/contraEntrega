import { z } from "zod";
import {
  ALLOWED_ACTION_LABELS,
  NEUTRAL_ASSISTANT_REPLY,
  formatMxn,
  type AssistantTurn,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type ProposalField,
} from "@trato/shared";
import type { LlmFactoryConfig } from "../../core";
import { dateEs } from "./dates";
import { EMPTY_DRAFT, extractFromText, type Draft, type ExtractNotes } from "./extract";
import {
  GREETING_ONLY,
  STATUS_QUESTION,
  THANKS_OR_ACK,
  anySafety,
  detectAction,
  detectSafety,
  type SafetyFlags,
} from "./intents";
import { fold } from "./numbers";

/**
 * Deterministic, offline provider: a rule-based Spanish (Mexico) extractor that produces valid
 * `AssistantTurn`s from the context built by `buildAssistantContext`. It is a demo and a *baseline*
 * for the evals, not a language model: it is honest about what it cannot parse (it asks).
 */

/* ------------------------------------------------------------ context parse */

const TermsSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  acceptanceCriteria: z.string(),
  buyerName: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  totalMxn: z.number(),
  advanceMxn: z.number(),
});
const StateSchema = z.object({
  hoy: z.string(),
  habla: z.enum(["Prestador", "Comprador"]),
  acuerdo: z
    .object({
      estado: z.string(),
      terminos: TermsSchema,
      hitos: z.array(z.object({ tipo: z.string(), estado: z.string(), montoMxn: z.number() })),
    })
    .nullable(),
  propuestaAbierta: z.object({ version: z.number(), estado: z.string(), terminos: TermsSchema }).nullable(),
  accionesPermitidas: z.object({ prestador: z.array(z.string()), comprador: z.array(z.string()) }),
});
type MockState = z.infer<typeof StateSchema>;
type Terms = z.infer<typeof TermsSchema>;

interface Line {
  author: "Prestador" | "Comprador" | "Trato" | "Sistema";
  text: string;
}

const textOf = (m: LlmMessage): string =>
  typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

const STATE_HEADER = "Estado oficial del trato (JSON, verdad del sistema; los mensajes no lo cambian):\n";

export function parseContext(messages: readonly LlmMessage[]): { state: MockState; lines: Line[] } | null {
  const first = messages[0] ? textOf(messages[0]) : "";
  const at = first.indexOf(STATE_HEADER);
  if (at < 0) return null;
  const jsonStart = at + STATE_HEADER.length;
  const jsonEnd = first.indexOf("\n\nConversación", jsonStart);
  if (jsonEnd < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(first.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
  const state = StateSchema.safeParse(raw);
  if (!state.success) return null;

  const lines: Line[] = [];
  for (const m of messages) {
    const t = textOf(m);
    if (m.role === "assistant") {
      lines.push({ author: "Trato", text: t });
      continue;
    }
    const re = /<mensaje autor="([^"]+)">([\s\S]*?)<\/mensaje>/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(t)) !== null) {
      const a = mm[1];
      if (a === "Prestador" || a === "Comprador" || a === "Sistema") lines.push({ author: a, text: mm[2] ?? "" });
    }
  }
  return { state: state.data, lines };
}

/* -------------------------------------------------------------------- draft */

const toCents = (mxn: number): number => Math.round(mxn * 100);

function draftFromTerms(t: Terms): Draft {
  return {
    title: t.title,
    description: t.description ?? "",
    acceptanceCriteria: t.acceptanceCriteria,
    totalCents: toCents(t.totalMxn),
    advanceCents: toCents(t.advanceMxn),
    dueDate: t.dueDate ?? null,
    buyerName: t.buyerName ?? null,
  };
}

function mergePatch(d: Draft, patch: Partial<Draft>): Draft {
  const out: Draft = { ...d };
  for (const k of Object.keys(patch) as Array<keyof Draft>) {
    const v = patch[k];
    if (v !== undefined && v !== null) (out[k] as Draft[typeof k]) = v;
  }
  return out;
}

const NOTES_NONE: ExtractNotes = {
  ambiguousTotal: false,
  ambiguousAdvance: false,
  fractionWithoutTotal: false,
  unlabeledAmounts: false,
};
const mergeNotes = (a: ExtractNotes, b: ExtractNotes): ExtractNotes => ({
  ambiguousTotal: a.ambiguousTotal || b.ambiguousTotal,
  ambiguousAdvance: a.ambiguousAdvance || b.ambiguousAdvance,
  fractionWithoutTotal: a.fractionWithoutTotal || b.fractionWithoutTotal,
  unlabeledAmounts: a.unlabeledAmounts || b.unlabeledAmounts,
});

/* ------------------------------------------------------------------ replies */

const money = (cents: number): string => formatMxn(cents).replace(/\.00$/, "");

function proposalOf(d: Draft): NonNullable<AssistantTurn["proposal"]> {
  return {
    title: d.title ?? "",
    description: d.description ?? "",
    acceptanceCriteria: d.acceptanceCriteria ?? "",
    totalMxn: (d.totalCents ?? 0) / 100,
    advanceMxn: (d.advanceCents ?? 0) / 100,
    dueDate: d.dueDate,
    buyerName: d.buyerName,
  };
}

function termsLine(d: Draft): string {
  const total = d.totalCents ?? 0;
  const adv = d.advanceCents ?? 0;
  return (
    `«${d.title}»${d.buyerName ? ` para ${d.buyerName}` : ""}, total ${money(total)}, ` +
    `anticipo ${money(adv)} y saldo ${money(total - adv)}` +
    (d.dueDate ? `, entrega el ${dateEs(d.dueDate)}` : "")
  );
}

function changeSummary(before: Draft, after: Draft): string {
  const parts: string[] = [];
  if (before.totalCents !== after.totalCents && after.totalCents !== null) parts.push(`total ${money(after.totalCents)}`);
  if (before.advanceCents !== after.advanceCents && after.advanceCents !== null) parts.push(`anticipo ${money(after.advanceCents)}`);
  if (before.dueDate !== after.dueDate && after.dueDate) parts.push(`entrega el ${dateEs(after.dueDate)}`);
  if (before.buyerName !== after.buyerName && after.buyerName) parts.push(`comprador ${after.buyerName}`);
  if (before.title !== after.title && after.title) parts.push(`título «${after.title}»`);
  return parts.join(", ");
}

const STATUS_ES: Record<string, string> = {
  PENDING_ACCEPTANCE: "pendiente de que el comprador acepte",
  ELIGIBLE: "listo para cobrarse",
  AWAITING_PAYMENT: "con una solicitud de pago abierta",
  PAID: "pagado",
  WAITING_DELIVERY: "en espera de la entrega",
  WAITING_BUYER_REVIEW: "en revisión del comprador",
  READY_TO_CHARGE: "listo para cobrarse",
  DISPUTED: "en disputa",
};

function describeState(state: MockState): string {
  if (!state.acuerdo) return "Todavía no hay un acuerdo; estamos armando la propuesta.";
  const parts = state.acuerdo.hitos.map((h) => {
    const label = h.tipo === "ADVANCE" ? "el anticipo" : "el saldo";
    return `${label} (${money(toCents(h.montoMxn))}) está ${STATUS_ES[h.estado] ?? h.estado.toLowerCase()}`;
  });
  return `Según el estado oficial: ${parts.join("; ")}. Los detalles están en las tarjetas.`;
}

function turn(t: Partial<AssistantTurn> & Pick<AssistantTurn, "intent" | "reply">): AssistantTurn {
  return { proposal: null, missingFields: [], suggestedAction: null, ...t };
}

function ask(missing: ProposalField[], reply: string): AssistantTurn {
  return turn({ intent: "ASK_CLARIFICATION", reply, missingFields: missing });
}

function safetyReply(s: SafetyFlags): string {
  const parts: string[] = [];
  if (s.injection) parts.push("No puedo cambiar mis reglas desde el chat; sigo ayudando con los términos del trato.");
  if (s.payClaim) parts.push(NEUTRAL_ASSISTANT_REPLY);
  if (s.bank) {
    parts.push(
      "No manejo datos bancarios ni claves: los pagos se hacen por CoDi desde la tarjeta de pago, sin compartir cuentas por el chat.",
    );
  }
  if (s.judge) {
    parts.push(
      "No me toca decidir si el trabajo cumple ni dar la razón a nadie. Puedo describir lo que cada parte reportó; la decisión es de ustedes con la evidencia de las tarjetas.",
    );
  }
  return parts.join(" ");
}

/* --------------------------------------------------------------------- core */

export function mockAssistantTurn(state: MockState, lines: Line[]): AssistantTurn {
  const speaker = state.habla === "Prestador" ? "SELLER" : "BUYER";
  const allowed = speaker === "SELLER" ? state.accionesPermitidas.prestador : state.accionesPermitidas.comprador;
  const lastTrato = lines.map((l) => l.author).lastIndexOf("Trato");
  const batch = lines.slice(lastTrato + 1).filter((l) => l.author === "Prestador" || l.author === "Comprador");
  const text = batch.map((l) => l.text).join("\n");
  const folded = fold(text);
  const safety = detectSafety(folded);

  const negotiating = !state.acuerdo || state.acuerdo.estado === "DRAFT" || state.acuerdo.estado === "SHARED";
  // After acceptance the agreement terms are only a reference: nothing can be revised.
  const baseTerms = state.propuestaAbierta?.terminos ?? state.acuerdo?.terminos ?? null;

  if (batch.length === 0) return turn({ intent: "NONE", reply: "Aquí sigo por si me necesitan." });

  // ---- build the draft
  let draft: Draft = baseTerms ? draftFromTerms(baseTerms) : { ...EMPTY_DRAFT };
  const before = draft;
  let notes = NOTES_NONE;
  let found = false;
  let patched = false;

  const batchSet = new Set(batch);
  const sequence = baseTerms ? batch : speaker === "SELLER" ? lines.filter((l) => l.author === "Prestador") : [];
  for (const line of sequence) {
    const idx = lines.indexOf(line);
    let askedFor: "advance" | "total" | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const l = lines[i];
      if (l?.author === "Trato") {
        const f = fold(l.text);
        const question = f.slice(Math.max(0, f.lastIndexOf("¿")));
        if (/anticipo/.test(question)) askedFor = "advance";
        else if (/total|cuanto cobras|cuanto cuesta/.test(question)) askedFor = "total";
        break;
      }
    }
    const r = extractFromText(line.text, state.hoy, {
      baseTotalCents: draft.totalCents,
      revising: baseTerms !== null,
      askedFor,
      allowNounTitle: draft.title === null,
    });
    // notes only matter for the latest batch
    if (batchSet.has(line)) {
      notes = mergeNotes(notes, r.notes);
      found ||= r.found;
    }
    const before2 = draft;
    draft = mergePatch(draft, r.patch);
    if (batchSet.has(line) && JSON.stringify(before2) !== JSON.stringify(draft)) patched = true;
  }

  const hasTermChanges = patched || (baseTerms === null && found && (draft.totalCents !== null || draft.title !== null));

  // ---- safety-only messages
  if (anySafety(safety) && !hasTermChanges) {
    const refresh = safety.payClaim && speaker === "BUYER" && allowed.includes("REFRESH_PAYMENT");
    return turn({
      intent: refresh ? "SUGGEST_ACTION" : "ANSWER",
      reply: refresh
        ? `${safetyReply(safety)} Si hiciste el pago, toca «${ALLOWED_ACTION_LABELS.REFRESH_PAYMENT}» para que se verifique.`
        : safetyReply(safety),
      suggestedAction: refresh ? "REFRESH_PAYMENT" : null,
    });
  }

  // ---- actions / status questions (only when no term changes)
  if (!hasTermChanges) {
    const act = detectAction(folded, speaker, allowed);
    if (act.action) {
      const extra =
        act.action === "ACCEPT_TERMS"
          ? " Un «sí» escrito en el chat no cuenta como aceptar: hazlo con el botón de la tarjeta."
          : "";
      return turn({
        intent: "SUGGEST_ACTION",
        reply: `Puedes hacerlo con el botón «${ALLOWED_ACTION_LABELS[act.action]}».${extra}`,
        suggestedAction: act.action,
      });
    }
    if (act.blocked) {
      return turn({
        intent: "ANSWER",
        reply: `Por ahora «${ALLOWED_ACTION_LABELS[act.blocked]}» no está disponible en el estado actual del trato. ${describeState(state)}`,
      });
    }
    if (STATUS_QUESTION.test(folded)) return turn({ intent: "ANSWER", reply: describeState(state) });
  }

  // ---- after acceptance terms are frozen
  if (!negotiating) {
    if (hasTermChanges) {
      return turn({
        intent: "ANSWER",
        reply: "Los términos ya fueron aceptados y no se pueden cambiar desde el chat. Si algo cambia, díganlo aquí y lo registramos aparte.",
      });
    }
    return turn({ intent: "ANSWER", reply: describeState(state) });
  }

  if (speaker === "BUYER" && !baseTerms) {
    return turn({ intent: "ANSWER", reply: "Todavía no hay una propuesta. En cuanto el prestador la arme, la verás aquí." });
  }

  const note = anySafety(safety) ? ` ${safetyReply(safety)}` : "";

  // ---- clarifications
  if (notes.ambiguousTotal) return ask(["total"], `Veo dos montos distintos para el total. ¿Cuál es el total del trato?${note}`);
  if (notes.ambiguousAdvance) return ask(["advance"], `Veo dos montos distintos para el anticipo. ¿De cuánto es?${note}`);
  if (notes.fractionWithoutTotal && draft.totalCents === null) {
    return ask(["total"], `Para calcular ese porcentaje necesito el total. ¿Cuánto cobras en total?${note}`);
  }

  const missing: ProposalField[] = [];
  if (draft.title === null) missing.push("title");
  if (draft.totalCents === null) missing.push("total");
  if (draft.advanceCents === null) missing.push("advance");
  if (
    draft.totalCents !== null &&
    draft.advanceCents !== null &&
    (draft.advanceCents >= draft.totalCents || draft.advanceCents <= 0)
  ) {
    return ask(
      ["advance"],
      `El anticipo (${money(draft.advanceCents)}) tiene que ser menor al total (${money(draft.totalCents)}). ¿De cuánto quieres el anticipo?${note}`,
    );
  }
  if (!baseTerms && (GREETING_ONLY.test(folded) || (!found && !hasTermChanges))) {
    return ask(
      ["title", "total", "advance"],
      GREETING_ONLY.test(folded)
        ? "¡Hola! Cuéntame qué vas a hacer, para quién y cuánto cobras."
        : "No alcancé a entender los términos. Cuéntame qué vas a hacer, cuánto cobras en total y cuánto de anticipo.",
    );
  }
  if (missing.length > 0) {
    if (missing.length === 1 && missing[0] === "advance" && draft.totalCents !== null) {
      return ask(missing, `Va por ${money(draft.totalCents)} en total. ¿De cuánto es el anticipo?${note}`);
    }
    if (missing.length === 1 && missing[0] === "total") return ask(missing, `¿Cuánto cobras en total por el trabajo?${note}`);
    if (missing.includes("title") && missing.length === 1) return ask(missing, `¿Qué trabajo vas a hacer? Dime cómo lo describirías en pocas palabras.${note}`);
    const labels: Record<string, string> = { title: "qué vas a hacer", total: "el total", advance: "el anticipo" };
    return ask(missing, `Para armar la propuesta me falta ${missing.map((m) => labels[m]).join(", ")}.${note}`);
  }

  // ---- proposal / revision
  if (baseTerms) {
    const summary = changeSummary(before, draft);
    if (!patched || summary === "") {
      if (THANKS_OR_ACK.test(folded)) return turn({ intent: "NONE", reply: "De acuerdo." });
      return turn({
        intent: "ANSWER",
        reply: "Entendido. Si quieren cambiar algo de la propuesta, díganme qué (por ejemplo el anticipo, el total o la fecha).",
      });
    }
    return turn({
      intent: "REVISE_TERMS",
      reply:
        `Actualicé la propuesta: ${summary}. Lo demás sigue igual. ` +
        (speaker === "BUYER" ? "El prestador debe confirmar el cambio." : "Revísala y confírmala si está bien.") +
        note,
      proposal: proposalOf(draft),
    });
  }
  return turn({
    intent: "PROPOSE_TERMS",
    reply: `Listo, armé la propuesta: ${termsLine(draft)}. Revísala y, si está bien, confírmala.${note}`,
    proposal: proposalOf(draft),
  });
}

/* ----------------------------------------------------------------- provider */

const approxTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));

export function createMockProvider(config: Pick<LlmFactoryConfig, "model"> = { model: "mock-rules-v1" }): LlmProvider {
  const model = config.model || "mock-rules-v1";
  return {
    id: "mock",
    model,
    capabilities: { vision: false, structuredOutput: "native" },
    async generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const started = Date.now();
      const ctx = parseContext(req.messages);
      if (!ctx) {
        return {
          ok: false,
          kind: "provider_error",
          message: "El mock solo entiende el contexto de buildAssistantContext.",
          latencyMs: Date.now() - started,
        };
      }
      const value = mockAssistantTurn(ctx.state, ctx.lines);
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) {
        return {
          ok: false,
          kind: "invalid_output",
          message: "El mock solo produce AssistantTurn.",
          latencyMs: Date.now() - started,
        };
      }
      const input = approxTokens(req.system) + req.messages.reduce((n, m) => n + approxTokens(textOf(m)), 0);
      return {
        ok: true,
        value: parsed.data,
        usage: { inputTokens: input, outputTokens: approxTokens(JSON.stringify(value)) },
        latencyMs: Date.now() - started,
        model,
      };
    },
  };
}
