import { and, desc, eq, inArray } from "drizzle-orm";
import {
  allowedActions,
  computeCleaningSellerNextAction,
  computeSellerNextAction,
  noAgreementActionState,
  type ActionRole,
  type ActionState,
  type ConversationSummary,
  type ConversationView,
  type FeedItem,
  type ProposalTerms,
  type ProposalView,
  compareFeedItems,
} from "@trato/shared";
import type { Db } from "../db/client";
import { agreementTasks, agreements, conversations, llmCalls, messages, milestones, proposals } from "../db/schema";
import { assistantStatus } from "../assistant/provider";
import type { AppEnv } from "../env";
import { expireStalePaymentRequests } from "../payments/expire";
import { loadBundle, type AgreementBundle } from "../repos/agreements";
import { SYSTEM_AUTHOR, type ConversationRow, type ProposalRow } from "../repos/conversations";
import { evidenceWindow } from "../lib/url-window";
import { buildBuyerView, buildSellerView, eventViews } from "./views";

/** The feed only carries the most recent items (the full history is in the export). */
export const FEED_LIMIT = 200;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Terms exactly as stored in `proposals.terms_json` (canonical, cents). */
export interface StoredTerms {
  title: string;
  description: string;
  acceptanceCriteria: string;
  buyerName: string;
  dueDate: string | null;
  totalCents: number;
  advanceCents: number;
}

export function parseTerms(row: Pick<ProposalRow, "termsJson">): StoredTerms {
  const t = JSON.parse(row.termsJson) as StoredTerms;
  return { ...t, dueDate: t.dueDate ?? null, description: t.description ?? "" };
}

export function proposalView(row: ProposalRow): ProposalView {
  const t = parseTerms(row);
  const terms: ProposalTerms = { ...t, balanceCents: t.totalCents - t.advanceCents };
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    terms,
    termsSha256: row.termsSha256,
    createdAt: iso(row.createdAt),
    confirmedAt: row.confirmedAt === null ? null : iso(row.confirmedAt),
  };
}

/** Latest proposal still in play (OPEN or SELLER_CONFIRMED). */
export const activeProposalOf = (rows: readonly ProposalRow[]): ProposalRow | null =>
  [...rows].reverse().find((p) => p.status === "OPEN" || p.status === "SELLER_CONFIRMED") ?? null;

const ACTIVE_PR = ["CREATING", "AWAITING_PAYMENT", "CREATION_UNKNOWN"] as const;

/** Snapshot the guards in `allowedActions` need, from DB rows. */
export function actionStateOf(b: AgreementBundle | null, hasOpenProposal: boolean, nowMs: number): ActionState {
  if (!b) return noAgreementActionState(hasOpenProposal, nowMs);
  const snap = (kind: "ADVANCE" | "BALANCE") => {
    const m = b.milestones.find((x) => x.kind === kind);
    return m ? { kind: m.kind, status: m.status, deliveryRound: m.deliveryRound } : null;
  };
  const balance = b.milestones.find((m) => m.kind === "BALANCE");
  const activeFor = (kind: "ADVANCE" | "BALANCE") => {
    const m = b.milestones.find((x) => x.kind === kind);
    const pr = m ? [...b.paymentRequests].reverse().find((p) => p.milestoneId === m.id && (ACTIVE_PR as readonly string[]).includes(p.status)) : undefined;
    return pr ? { id: pr.id, status: pr.status, expiresAtMs: pr.expiresAt } : null;
  };
  return {
    agreement: { status: b.agreement.status },
    advance: snap("ADVANCE"),
    balance: snap("BALANCE"),
    activePaymentRequests: { advance: activeFor("ADVANCE"), balance: activeFor("BALANCE") },
    unsubmittedEvidenceCount: balance ? b.evidence.filter((e) => e.milestoneId === balance.id && !e.submitted).length : 0,
    hasOpenProposal,
    nowMs,
    account: { codiStatus: b.account.codiStatus, enabled: b.account.enabled },
    ...(b.agreement.serviceType === "CLEANING"
      ? { serviceType: "CLEANING" as const, tasks: b.tasks.map((t) => ({ id: t.id, status: t.status, revision: t.revision })) }
      : {}),
  };
}

export const isBusy = (lockUntil: number | null, now: number): boolean => lockUntil !== null && lockUntil > now;

/** Cheap fingerprint for ETag / 304: conversation + agreement versions, the signed-URL window and "typing". */
export async function conversationEtag(env: AppEnv, db: Db, conversationId: string, now: number): Promise<string | null> {
  const read = () =>
    db
      .select({ cv: conversations.version, lock: conversations.assistantLockUntil, av: agreements.version, agreementId: conversations.agreementId })
      .from(conversations)
      .leftJoin(agreements, eq(agreements.id, conversations.agreementId))
      .where(eq(conversations.id, conversationId))
      .limit(1);
  let r = (await read())[0];
  // Lazy local expiry bumps the agreement version: do it first so a 304 is never served for stale state.
  if (r?.agreementId && (await expireStalePaymentRequests(env, r.agreementId, now)) > 0) r = (await read())[0];
  if (!r) return null;
  return makeEtag(r.cv, r.av ?? 0, evidenceWindow(now), isBusy(r.lock, now));
}

export const makeEtag = (conversationVersion: number, agreementVersion: number, window: number, busy: boolean): string =>
  `"c${conversationVersion}-a${agreementVersion}-w${window}${busy ? "-b" : ""}"`;

/**
 * The room as seen by `role`. Visibility decision: every message of the room is visible to both
 * parties, including the seller's negotiation with Trato before the link was shared (proposals and
 * replies explain the deal and carry no sensitive data). Events follow the buyer's existing view:
 * `BUYER_HIDDEN_EVENT_TYPES` never reach the buyer.
 * Queries: conversation, last messages (+llm_calls), proposals and the agreement bundle in parallel.
 */
export async function buildConversationView(
  env: AppEnv,
  db: Db,
  conversationId: string,
  role: ActionRole,
  now: number,
  opts: { forceBusy?: boolean } = {},
): Promise<ConversationView> {
  const head = await db
    .select({ agreementId: conversations.agreementId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const agreementId = head[0]?.agreementId ?? null;
  if (agreementId) await expireStalePaymentRequests(env, agreementId, now);

  const [convRows, msgRows, propRows, bundle] = await Promise.all([
    db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1),
    db
      .select({ m: messages, provider: llmCalls.provider, model: llmCalls.model })
      .from(messages)
      .leftJoin(llmCalls, eq(llmCalls.id, messages.llmCallId))
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.seq))
      .limit(FEED_LIMIT),
    db.select().from(proposals).where(eq(proposals.conversationId, conversationId)).orderBy(proposals.version),
    agreementId ? loadBundle(db, agreementId) : Promise.resolve(null),
  ]);
  const conv: ConversationRow | undefined = convRows[0];
  if (!conv) throw new Error("Conversación no encontrada.");

  const proposalById = new Map(propRows.map((p) => [p.id, p]));
  const items: FeedItem[] = [];
  for (const { m, provider, model } of msgRows) {
    const p = m.proposalId ? proposalById.get(m.proposalId) : undefined;
    items.push({
      type: "message",
      id: m.id,
      seq: m.seq,
      occurredAt: iso(m.createdAt),
      authorType: m.authorType,
      authorName: m.authorName,
      kind: m.kind,
      text: m.bodyText,
      system: m.authorType === "ASSISTANT" && m.authorName === SYSTEM_AUTHOR,
      proposal: p ? proposalView(p) : null,
      assistant: m.authorType === "ASSISTANT" && m.authorName !== SYSTEM_AUTHOR && provider && model ? { provider, model } : null,
    });
  }
  if (bundle) {
    for (const e of eventViews(bundle.events, role === "BUYER")) {
      items.push({ type: "event", id: e.id, seq: e.seq, occurredAt: e.occurredAt, eventType: e.type, actorType: e.actorType, payload: e.payload });
    }
  }
  items.sort(compareFeedItems);
  const feed = items.slice(-FEED_LIMIT);

  const active = activeProposalOf(propRows);
  const hasOpen = propRows.some((p) => p.status === "OPEN");
  const state = actionStateOf(bundle, hasOpen, now);
  const status = assistantStatus(env);

  return {
    role,
    conversation: {
      id: conv.id,
      agreementId: conv.agreementId,
      createdAt: iso(conv.createdAt),
      updatedAt: iso(conv.updatedAt),
      version: conv.version,
    },
    feed,
    activeProposal: active ? proposalView(active) : null,
    agreement: bundle ? (role === "SELLER" ? await buildSellerView(env, bundle, now) : await buildBuyerView(env, bundle, now)) : null,
    allowedActions: allowedActions(state, role),
    assistantBusy: status.enabled && (opts.forceBusy === true || isBusy(conv.assistantLockUntil, now)),
    assistant: status,
  };
}

/** ETag of a built view (so the header always matches the body that was actually sent). */
export const etagOfView = (v: ConversationView, now: number): string =>
  makeEtag(v.conversation.version, v.agreement?.agreement.version ?? 0, evidenceWindow(now), v.assistantBusy);

/** Seller's room list, with the agreement's state when there is one. */
export async function listConversationSummaries(db: Db, d1: D1Database, sellerId: string): Promise<ConversationSummary[]> {
  // Lazy backfill for agreements that predate conversations (one statement; idempotent).
  await d1
    .prepare(
      `INSERT OR IGNORE INTO conversations (id, seller_id, agreement_id, created_at, updated_at, version)
       SELECT lower(hex(randomblob(16))), a.seller_id, a.id, a.created_at, a.updated_at, 1
       FROM agreements a WHERE a.seller_id = ? AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.agreement_id = a.id)`,
    )
    .bind(sellerId)
    .run();
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.sellerId, sellerId))
    .orderBy(desc(conversations.updatedAt))
    .limit(80);
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const agreementIds = convs.flatMap((c) => (c.agreementId ? [c.agreementId] : []));
  const [agrRows, msRows, propRows, last, taskRows] = await Promise.all([
    agreementIds.length ? db.select().from(agreements).where(inArray(agreements.id, agreementIds)) : Promise.resolve([]),
    agreementIds.length ? db.select().from(milestones).where(inArray(milestones.agreementId, agreementIds)) : Promise.resolve([]),
    db
      .select()
      .from(proposals)
      .where(and(inArray(proposals.conversationId, ids), inArray(proposals.status, ["OPEN", "SELLER_CONFIRMED"])))
      .orderBy(proposals.version),
    d1
      .prepare(
        `SELECT m.conversation_id AS cid, m.body_text AS text FROM messages m
         WHERE m.conversation_id IN (${ids.map(() => "?").join(",")})
           AND m.seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = m.conversation_id)`,
      )
      .bind(...ids)
      .all<{ cid: string; text: string }>(),
    agreementIds.length ? db.select().from(agreementTasks).where(inArray(agreementTasks.agreementId, agreementIds)) : Promise.resolve([]),
  ]);
  const lastBy = new Map(last.results.map((r) => [r.cid, r.text]));
  const agrById = new Map(agrRows.map((a) => [a.id, a]));
  const propBy = new Map<string, ProposalRow>();
  for (const p of propRows) propBy.set(p.conversationId, p); // ascending version: the last one wins
  const status = (agreementId: string, kind: "ADVANCE" | "BALANCE") =>
    msRows.find((m) => m.agreementId === agreementId && m.kind === kind)?.status;

  const summaries = convs.map((c): ConversationSummary => {
    const a = c.agreementId ? agrById.get(c.agreementId) : undefined;
    const p = propBy.get(c.id);
    const terms = p ? parseTerms(p) : null;
    const preview = lastBy.get(c.id);
    return {
      id: c.id,
      agreementId: c.agreementId,
      agreementCode: a?.code ?? null,
      title: a?.title ?? terms?.title ?? null,
      buyerName: a?.buyerName ?? terms?.buyerName ?? null,
      totalCents: a?.totalCents ?? terms?.totalCents ?? null,
      agreementStatus: a?.status ?? null,
      nextAction: a
        ? a.serviceType === "CLEANING"
          ? computeCleaningSellerNextAction({
              agreementStatus: a.status,
              balanceStatus: status(a.id, "BALANCE") ?? "WAITING_DELIVERY",
              tasks: taskRows.filter((t) => t.agreementId === a.id),
            })
          : computeSellerNextAction({
              agreementStatus: a.status,
              advanceStatus: status(a.id, "ADVANCE") ?? "PENDING_ACCEPTANCE",
              balanceStatus: status(a.id, "BALANCE") ?? "WAITING_DELIVERY",
            })
        : null,
      hasOpenProposal: p?.status === "OPEN",
      lastMessagePreview: preview === undefined ? null : preview.slice(0, 120),
      createdAt: iso(c.createdAt),
      updatedAt: iso(Math.max(c.updatedAt, a?.updatedAt ?? 0)),
    };
  });
  return summaries.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
}
