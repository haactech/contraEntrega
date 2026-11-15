import { desc, eq } from "drizzle-orm";
import {
  ASSISTANT_SYSTEM_PROMPT,
  AssistantTurnSchema,
  allowedActionsByRole,
  assistantFactsFromStatuses,
  buildAssistantContext,
  canonicalJson,
  mexicoCityToday,
  sanitizeAssistantTurn,
  sha256Hex,
  type AssistantContextMessage,
  type AssistantContextTerms,
  type AssistantTurn,
  type LlmProvider,
  type LlmResult,
} from "@trato/shared";
import { createDb, rawStmt, type Db } from "../db/client";
import { messages, proposals } from "../db/schema";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { loadBundle, type AgreementBundle } from "../repos/agreements";
import {
  SYSTEM_AUTHOR,
  batchWithRetry,
  findConversation,
  insertMessageStatements,
  type NewMessage,
} from "../repos/conversations";
import { actionStateOf, activeProposalOf, parseTerms } from "../services/conversation-view";
import { getLlmProvider, llmTimeoutMs } from "./provider";

export const ASSISTANT_FAILURE_TEXT = "No pude procesar tu mensaje; intenta de nuevo o usa el formulario.";
export const ASSISTANT_PROPOSAL_CLOSED_TEXT =
  "Las condiciones ya fueron aceptadas y no se pueden cambiar desde la conversación.";
const ASSISTANT_NAME = "Trato";
const LOCK_MARGIN_MS = 5_000;
/** Safety net: coalesced follow-up runs per background task. */
const MAX_RUNS = 5;
const EVENTS_IN_CONTEXT = 15;

const lockUntil = (env: AppEnv, now: number): number => now + llmTimeoutMs(env) + LOCK_MARGIN_MS;

export interface AssistantRequest {
  /** True when this request took the lock (the caller must run `run()` in the background). */
  acquired: boolean;
  run: () => Promise<void>;
}

/**
 * Entry point after a human message that asks for an assistant turn (policy already checked).
 *
 * Concurrency (the "debounce" of the spec, as coalescing): `assistant_pending_seq` records the
 * newest message that wants an answer; a conditional UPDATE takes the per-conversation lock
 * (`assistant_lock_until` in the future = a call is in flight; an expired lock = crashed run, can
 * be retaken). If the lock is taken the message is only stored: the running task re-checks
 * `pending > snapshot` atomically when it releases and runs once more for everything that
 * arrived meanwhile.
 */
export async function requestAssistantTurn(env: AppEnv, conversationId: string, seq: number, now: number): Promise<AssistantRequest> {
  const provider = getLlmProvider(env);
  const none: AssistantRequest = { acquired: false, run: async () => {} };
  if (!provider) return none;
  // 1) publish the demand first, so a runner releasing right now cannot miss it.
  await env.DB.prepare("UPDATE conversations SET assistant_pending_seq = MAX(assistant_pending_seq, ?) WHERE id = ?")
    .bind(seq, conversationId)
    .run();
  // 2) try to take the lock.
  const until = lockUntil(env, now);
  const res = await env.DB.prepare(
    `UPDATE conversations SET assistant_lock_until = ?, assistant_snapshot_seq = assistant_pending_seq, version = version + 1
     WHERE id = ? AND (assistant_lock_until IS NULL OR assistant_lock_until <= ?) AND assistant_pending_seq > assistant_snapshot_seq`,
  )
    .bind(until, conversationId, now)
    .run();
  if (res.meta.changes !== 1) return none;
  return { acquired: true, run: () => runLocked(env, provider, conversationId, until) };
}

async function runLocked(env: AppEnv, provider: LlmProvider, conversationId: string, initialLock: number): Promise<void> {
  const db = createDb(env.DB);
  let token = initialLock;
  try {
    for (let i = 0; i < MAX_RUNS; i++) {
      try {
        await runOnce(env, db, provider, conversationId, token);
      } catch (err) {
        logger.error("assistant_run_failed", { conversationId, error: err });
        await appendSystemFailure(env, conversationId, null).catch(() => undefined);
      }
      // Release atomically only if nothing new arrived after what we took into account.
      const rel = await env.DB.prepare(
        `UPDATE conversations SET assistant_lock_until = NULL, version = version + 1
         WHERE id = ? AND assistant_lock_until = ? AND assistant_pending_seq <= assistant_snapshot_seq`,
      )
        .bind(conversationId, token)
        .run();
      if (rel.meta.changes === 1) return;
      // New messages arrived while we were working: take them in one more run (still holding the lock).
      const next = lockUntil(env, Date.now());
      const cont = await env.DB.prepare(
        `UPDATE conversations SET assistant_lock_until = ?, assistant_snapshot_seq = assistant_pending_seq, version = version + 1
         WHERE id = ? AND assistant_lock_until = ? AND assistant_pending_seq > assistant_snapshot_seq`,
      )
        .bind(next, conversationId, token)
        .run();
      if (cont.meta.changes !== 1) return; // lock lost (expired and retaken) or released elsewhere
      token = next;
    }
  } finally {
    // Never leave the room "typing" if we are bailing out (MAX_RUNS or an unexpected error).
    await env.DB.prepare("UPDATE conversations SET assistant_lock_until = NULL, version = version + 1 WHERE id = ? AND assistant_lock_until = ?")
      .bind(conversationId, token)
      .run()
      .catch(() => undefined);
  }
}

/* ----------------------------------------------------------------- context */

const EVENT_TEXT: Partial<Record<string, (p: Record<string, unknown>) => string>> = {
  AGREEMENT_SHARED: () => "El prestador compartió el enlace del trato con el comprador.",
  TERMS_REVISED: (p) => `Las condiciones se revisaron (versión ${String(p.termsVersion ?? "")}).`,
  TERMS_ACCEPTED: () => "El comprador aceptó las condiciones con el botón de la tarjeta.",
  PAYMENT_CONFIRMED: (p) => `Pago confirmado por el proveedor (${p.milestoneKind === "BALANCE" ? "saldo" : "anticipo"}).`,
  EVIDENCE_ADDED: () => "El prestador subió una foto de evidencia.",
  REVIEW_REQUESTED: () => "El prestador marcó el trabajo como terminado y pidió revisión.",
  DELIVERY_APPROVED: () => "El comprador aprobó la entrega con el botón.",
  DELIVERY_DISPUTED: () => "El comprador reportó un problema con la entrega.",
  AGREEMENT_COMPLETED: () => "El trato quedó completado.",
};

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function contextTerms(b: AgreementBundle): AssistantContextTerms {
  const advance = b.milestones.find((m) => m.kind === "ADVANCE")?.amountCents ?? 0;
  return {
    title: b.agreement.title,
    description: b.agreement.description,
    acceptanceCriteria: b.agreement.acceptanceCriteria,
    buyerName: b.agreement.buyerName,
    dueDate: b.agreement.dueDate,
    totalCents: b.agreement.totalCents,
    advanceCents: advance,
  };
}

async function runOnce(env: AppEnv, db: Db, provider: LlmProvider, conversationId: string, token: number): Promise<void> {
  const conv = await findConversation(db, conversationId);
  if (!conv) return;
  const now = Date.now();
  const [recentDesc, proposalRows, bundle] = await Promise.all([
    db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.seq)).limit(30),
    db.select().from(proposals).where(eq(proposals.conversationId, conversationId)).orderBy(proposals.version),
    conv.agreementId ? loadBundle(db, conv.agreementId) : Promise.resolve(null),
  ]);
  const recent = [...recentDesc].reverse();
  const lastHuman = [...recent].reverse().find((m) => m.authorType === "SELLER" || m.authorType === "BUYER");
  const newest = recent[recent.length - 1];
  if (!lastHuman || !newest) return;
  // Everything up to `newest` is in this call's context: later arrivals trigger one more run.
  await env.DB.prepare("UPDATE conversations SET assistant_snapshot_seq = MAX(assistant_snapshot_seq, ?) WHERE id = ? AND assistant_lock_until = ?")
    .bind(newest.seq, conversationId, token)
    .run();

  const speaker = lastHuman.authorType === "BUYER" ? "BUYER" : "SELLER";
  const active = activeProposalOf(proposalRows);
  const actionState = actionStateOf(bundle, proposalRows.some((p) => p.status === "OPEN"), now);
  const byRole = allowedActionsByRole(actionState);
  const advance = bundle?.milestones.find((m) => m.kind === "ADVANCE");
  const balance = bundle?.milestones.find((m) => m.kind === "BALANCE");

  // Messages + the relevant official events (as «Sistema» lines), chronologically.
  const timeline: { t: number; order: number; msg: AssistantContextMessage }[] = recent.map((m) => ({
    t: m.createdAt,
    order: 0,
    msg: { authorType: m.authorName === SYSTEM_AUTHOR ? "SYSTEM" : m.authorType, text: m.bodyText },
  }));
  const oldest = recent[0]?.createdAt ?? 0;
  for (const e of (bundle?.events ?? []).slice(-EVENTS_IN_CONTEXT)) {
    const text = EVENT_TEXT[e.eventType]?.(parsePayload(e.payloadJson));
    if (text && (recent.length < 30 || e.occurredAt >= oldest)) timeline.push({ t: e.occurredAt, order: 1, msg: { authorType: "SYSTEM", text } });
  }
  timeline.sort((a, b) => a.t - b.t || a.order - b.order);

  const ctx = buildAssistantContext({
    nowMs: now,
    speaker,
    agreement: bundle
      ? {
          status: bundle.agreement.status,
          terms: contextTerms(bundle),
          milestones: bundle.milestones.map((m) => ({ kind: m.kind, status: m.status, amountCents: m.amountCents })),
        }
      : null,
    openProposal: active ? { version: active.version, status: active.status, terms: parseTerms(active) } : null,
    allowedActions: byRole,
    messages: timeline.map((x) => x.msg),
  });

  const started = Date.now();
  const timeoutMs = llmTimeoutMs(env);
  let result: LlmResult<AssistantTurn>;
  let outcome: string;
  try {
    result = await withTimeout(
      provider.generateStructured({
        system: ASSISTANT_SYSTEM_PROMPT,
        messages: ctx.messages,
        schema: AssistantTurnSchema,
        schemaName: "assistant_turn",
        timeoutMs,
      }),
      timeoutMs + 1_000,
      Date.now() - started,
    );
    outcome = result.ok ? "ok" : result.kind;
  } catch (err) {
    logger.error("assistant_provider_threw", { conversationId, error: err });
    result = { ok: false, kind: "provider_error", message: "provider threw", latencyMs: Date.now() - started };
    outcome = "exception";
  }

  // Observability without content: provider, model, outcome, latency, tokens.
  const llmCallId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO llm_calls (id, conversation_id, provider, model, outcome, latency_ms, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      llmCallId,
      conversationId,
      provider.id,
      result.ok ? result.model : provider.model,
      outcome,
      Math.max(0, Math.round(result.latencyMs)),
      result.ok ? result.usage.inputTokens : null,
      result.ok ? result.usage.outputTokens : null,
      Date.now(),
    )
    .run();

  if (!result.ok) {
    await appendSystemFailure(env, conversationId, llmCallId);
    return;
  }

  const san = sanitizeAssistantTurn(result.value, {
    allowed: speaker === "BUYER" ? byRole.buyer : byRole.seller,
    state: assistantFactsFromStatuses(advance?.status, balance?.status),
    normalize: {
      defaultBuyerName: bundle?.agreement.buyerName ?? (active ? parseTerms(active).buyerName : null),
      today: mexicoCityToday(now).date,
    },
  });
  if (san.flags.length > 0) logger.info("assistant_sanitized", { conversationId, flags: san.flags });

  const { turn, normalized } = san;
  if (turn.intent === "NONE") return;
  const revisable = !bundle || bundle.agreement.status === "DRAFT" || bundle.agreement.status === "SHARED";
  const wantsProposal = turn.intent === "PROPOSE_TERMS" || turn.intent === "REVISE_TERMS";
  if (normalized && wantsProposal && revisable) {
    const i = normalized.input;
    const terms = {
      title: i.title,
      description: i.description ?? "",
      acceptanceCriteria: i.acceptanceCriteria,
      buyerName: i.buyerName,
      dueDate: i.dueDate ?? null,
      totalCents: i.totalCents,
      advanceCents: i.advanceCents,
    };
    const termsJson = canonicalJson(terms);
    await appendProposal(env, conversationId, termsJson, await sha256Hex(termsJson), turn.reply, llmCallId);
    return;
  }
  await appendAssistantMessage(env, {
    conversationId,
    authorType: "ASSISTANT",
    authorName: ASSISTANT_NAME,
    kind: "TEXT",
    text: normalized && wantsProposal ? ASSISTANT_PROPOSAL_CLOSED_TEXT : turn.reply,
    llmCallId,
    now: Date.now(),
  });
}

/** New proposal version; the previous OPEN ones become SUPERSEDED; plus the PROPOSAL message. One batch. */
async function appendProposal(
  env: AppEnv,
  conversationId: string,
  termsJson: string,
  termsSha256: string,
  reply: string,
  llmCallId: string,
): Promise<void> {
  await batchWithRetry(async () => {
    const now = Date.now();
    const proposalId = crypto.randomUUID();
    const msg = insertMessageStatements(env.DB, {
      conversationId,
      authorType: "ASSISTANT",
      authorName: ASSISTANT_NAME,
      kind: "PROPOSAL",
      text: reply,
      proposalId,
      llmCallId,
      now,
    });
    await env.DB.batch([
      rawStmt(env.DB, "UPDATE proposals SET status = 'SUPERSEDED' WHERE conversation_id = ? AND status = 'OPEN'", conversationId),
      rawStmt(
        env.DB,
        `INSERT INTO proposals (id, conversation_id, version, terms_json, terms_sha256, status, created_at)
         SELECT ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM proposals WHERE conversation_id = ?), ?, ?, 'OPEN', ?`,
        proposalId,
        conversationId,
        conversationId,
        termsJson,
        termsSha256,
        now,
      ),
      ...msg.statements,
    ]);
  });
}

async function appendAssistantMessage(env: AppEnv, m: NewMessage): Promise<void> {
  await batchWithRetry(async () => {
    await env.DB.batch(insertMessageStatements(env.DB, { ...m, now: Date.now() }).statements);
  });
}

/** Deterministic notice; the human message stays saved and the assistant is not called again. */
async function appendSystemFailure(env: AppEnv, conversationId: string, llmCallId: string | null): Promise<void> {
  await appendAssistantMessage(env, {
    conversationId,
    authorType: "ASSISTANT",
    authorName: SYSTEM_AUTHOR,
    kind: "TEXT",
    text: ASSISTANT_FAILURE_TEXT,
    llmCallId,
    now: Date.now(),
  });
}

function withTimeout<T>(p: Promise<LlmResult<T>>, ms: number, elapsedMs: number): Promise<LlmResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false, kind: "timeout", message: "timeout", latencyMs: ms + elapsedMs }), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
