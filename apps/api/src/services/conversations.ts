import {
  CreateAgreementInputSchema,
  type ActionVia,
  type ConfirmProposalResponse,
  type ConversationAuthorType,
  type ConversationView,
} from "@trato/shared";
import { and, eq } from "drizzle-orm";
import { requestAssistantTurn } from "../assistant/orchestrator";
import { shouldAssistantRespond } from "../assistant/policy";
import { agreements, proposals } from "../db/schema";
import { invalidState } from "../lib/errors";
import { findSeller } from "../repos/agreements";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import { notFound } from "../lib/errors";
import {
  batchWithRetry,
  ensureConversationForAgreement,
  findConversation,
  insertMessageStatements,
  messageSeq,
  type ConversationRow,
} from "../repos/conversations";
import { loadBundle } from "../repos/agreements";
import { buildConversationView, parseTerms } from "./conversation-view";
import { createAgreement, reviseTerms, shareAgreement } from "./agreements";
import { rawStmt } from "../db/client";

/** Seller's own conversation; 404 (not 403) for someone else's. */
export async function loadOwnedConversation(db: Db, sellerId: string, id: string): Promise<ConversationRow> {
  const c = await findConversation(db, id);
  if (!c || c.sellerId !== sellerId) throw notFound("No encontramos esta conversación.");
  return c;
}

export async function createConversation(env: AppEnv, db: Db, sellerId: string, now: number): Promise<ConversationView> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO conversations (id, seller_id, agreement_id, created_at, updated_at, version) VALUES (?, ?, NULL, ?, ?, 1)",
  )
    .bind(id, sellerId, now, now)
    .run();
  return buildConversationView(env, db, id, "SELLER", now);
}

/** Buyer side: the conversation of the token's agreement (created lazily for pre-v0.3 agreements). */
export async function conversationForAgreement(env: AppEnv, db: Db, agreementId: string, now: number): Promise<ConversationRow> {
  const b = await loadBundle(db, agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  return ensureConversationForAgreement(db, env.DB, b.agreement, now);
}

export interface StoredMessage {
  id: string;
  seq: number;
}

/** Appends a human message (append-only, stable seq) and bumps the conversation version. */
export async function appendHumanMessage(
  env: AppEnv,
  conversationId: string,
  authorType: Exclude<ConversationAuthorType, "ASSISTANT">,
  authorName: string,
  text: string,
  now: number,
): Promise<StoredMessage> {
  const id = await batchWithRetry(async () => {
    const m = insertMessageStatements(env.DB, { conversationId, authorType, authorName, kind: "TEXT", text, now });
    await env.DB.batch(m.statements);
    return m.id;
  });
  return { id, seq: await messageSeq(env.DB, id) };
}

export interface PostMessageResult {
  view: ConversationView;
  /** Assistant work to run in the background (after the response is built); null when none. */
  background: (() => Promise<void>) | null;
}

async function storeAndRequest(
  env: AppEnv,
  db: Db,
  conv: ConversationRow,
  role: "SELLER" | "BUYER",
  authorName: string,
  text: string,
  now: number,
): Promise<PostMessageResult> {
  const status = conv.agreementId
    ? ((await db.select({ s: agreements.status }).from(agreements).where(eq(agreements.id, conv.agreementId)).limit(1))[0]?.s ?? null)
    : null;
  const msg = await appendHumanMessage(env, conv.id, role, authorName, text, now);
  const req = shouldAssistantRespond(status, text) ? await requestAssistantTurn(env, conv.id, msg.seq, now) : null;
  // Respond right away: `assistantBusy` tells the UI to show "escribiendo" while the task runs.
  const view = await buildConversationView(env, db, conv.id, role, now, { forceBusy: req?.acquired === true });
  return { view, background: req?.acquired ? req.run : null };
}

/** Seller writes in their room. The assistant runs asynchronously (see `requestAssistantTurn`). */
export async function postSellerMessage(env: AppEnv, db: Db, sellerId: string, conversationId: string, text: string, now: number): Promise<PostMessageResult> {
  const conv = await loadOwnedConversation(db, sellerId, conversationId);
  const seller = await findSeller(db, sellerId);
  return storeAndRequest(env, db, conv, "SELLER", seller?.seller.displayName ?? "Prestador", text, now);
}

/** Buyer writes through the link. The route has already rejected the owner seller (invariant 3). */
export async function postBuyerMessage(env: AppEnv, db: Db, agreementId: string, text: string, now: number): Promise<PostMessageResult> {
  const b = await loadBundle(db, agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  const conv = await ensureConversationForAgreement(db, env.DB, b.agreement, now);
  return storeAndRequest(env, db, conv, "BUYER", b.agreement.buyerAcceptedName ?? b.agreement.buyerName, text, now);
}

/**
 * The seller confirms the current OPEN proposal: no agreement yet -> create it (linking this
 * room) and share; agreement DRAFT | SHARED -> `reviseTerms` (new hash, `TERMS_REVISED`) keeping the
 * same link. Always through the existing services, so every guard applies; the assistant only
 * proposed.
 *
 * Idempotency / races: the OPEN -> SELLER_CONFIRMED claim is a conditional UPDATE, so a double
 * click (or two tabs) has exactly one winner and a stale proposal gets 409. If the agreement step
 * fails the proposal goes back to OPEN so the seller can retry.
 * The proposal's hash is then replaced by the agreement's sealed `terms_sha256`: that is the value
 * the buyer must send to accept.
 */
export async function confirmProposal(
  env: AppEnv,
  db: Db,
  sellerId: string,
  conversationId: string,
  proposalId: string,
  now: number,
  via: ActionVia = "chat",
): Promise<ConfirmProposalResponse> {
  const conv = await loadOwnedConversation(db, sellerId, conversationId);
  const row = (await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.conversationId, conv.id))).limit(1))[0];
  if (!row) throw notFound("No encontramos esta propuesta.");
  if (row.status !== "OPEN") throw invalidState("Esta propuesta ya no está vigente. Revisa la más reciente.");
  if (conv.agreementId) {
    const status = (await db.select({ s: agreements.status }).from(agreements).where(eq(agreements.id, conv.agreementId)).limit(1))[0]?.s;
    if (status !== "DRAFT" && status !== "SHARED") {
      throw invalidState("Las condiciones ya fueron aceptadas y no se pueden cambiar.");
    }
  }

  const claim = await env.DB.prepare("UPDATE proposals SET status = 'SELLER_CONFIRMED', confirmed_at = ? WHERE id = ? AND status = 'OPEN'")
    .bind(now, row.id)
    .run();
  if (claim.meta.changes !== 1) throw invalidState("Esta propuesta ya no está vigente. Revisa la más reciente.");

  try {
    const t = parseTerms(row);
    const input = CreateAgreementInputSchema.parse({
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      buyerName: t.buyerName,
      ...(t.dueDate ? { dueDate: t.dueDate } : {}),
      totalCents: t.totalCents,
      advanceCents: t.advanceCents,
    });
    let agreementId = conv.agreementId;
    if (agreementId) await reviseTerms(db, env, sellerId, agreementId, input, now, { via });
    else agreementId = (await createAgreement(db, env, sellerId, input, now, { conversationId: conv.id, via })).agreement.id;
    const shared = await shareAgreement(db, env, sellerId, agreementId, false, now, { via });

    await env.DB.batch([
      rawStmt(env.DB, "UPDATE proposals SET terms_sha256 = ? WHERE id = ?", shared.agreement.agreement.termsSha256, row.id),
      rawStmt(env.DB, "UPDATE proposals SET status = 'SUPERSEDED' WHERE conversation_id = ? AND id <> ? AND status = 'SELLER_CONFIRMED'", conv.id, row.id),
      rawStmt(env.DB, "UPDATE conversations SET version = version + 1, updated_at = ? WHERE id = ?", now, conv.id),
    ]);
    return {
      conversation: await buildConversationView(env, db, conv.id, "SELLER", now),
      shareUrl: shared.shareUrl,
      whatsappUrl: shared.whatsappUrl,
    };
  } catch (err) {
    await env.DB.prepare("UPDATE proposals SET status = 'OPEN', confirmed_at = NULL WHERE id = ? AND status = 'SELLER_CONFIRMED'")
      .bind(row.id)
      .run()
      .catch(() => undefined);
    throw err;
  }
}
