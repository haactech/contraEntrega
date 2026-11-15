import type { ConversationAuthorType, ConversationView } from "@trato/shared";
import { eq } from "drizzle-orm";
import { requestAssistantTurn } from "../assistant/orchestrator";
import { shouldAssistantRespond } from "../assistant/policy";
import { agreements } from "../db/schema";
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
import { buildConversationView } from "./conversation-view";

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
