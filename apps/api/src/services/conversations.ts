import type { ConversationAuthorType, ConversationView } from "@trato/shared";
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
