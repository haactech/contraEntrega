import { eq } from "drizzle-orm";
import type { ConversationAuthorType, MessageKind } from "@trato/shared";
import { rawStmt, type Db } from "../db/client";
import { conversations, messages, proposals } from "../db/schema";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;

/** Author name of deterministic server messages (stored as author_type ASSISTANT, without llm_call_id). */
export const SYSTEM_AUTHOR = "Sistema";

export async function findConversation(db: Db, id: string): Promise<ConversationRow | null> {
  const rows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findConversationByAgreement(db: Db, agreementId: string): Promise<ConversationRow | null> {
  const rows = await db.select().from(conversations).where(eq(conversations.agreementId, agreementId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Every agreement has a conversation. Agreements created before v0.3 get theirs lazily on first
 * access (INSERT OR IGNORE + UNIQUE(agreement_id) make concurrent callers converge).
 */
export async function ensureConversationForAgreement(
  db: Db,
  d1: D1Database,
  agreement: { id: string; sellerId: string; createdAt: number },
  now: number,
): Promise<ConversationRow> {
  const existing = await findConversationByAgreement(db, agreement.id);
  if (existing) return existing;
  await d1
    .prepare(
      "INSERT OR IGNORE INTO conversations (id, seller_id, agreement_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)",
    )
    .bind(crypto.randomUUID(), agreement.sellerId, agreement.id, agreement.createdAt, now)
    .run();
  const row = await findConversationByAgreement(db, agreement.id);
  if (!row) throw new Error("No se pudo crear la conversación del trato.");
  return row;
}

export interface NewMessage {
  conversationId: string;
  authorType: ConversationAuthorType;
  authorName: string;
  kind: MessageKind;
  text: string;
  proposalId?: string | null;
  llmCallId?: string | null;
  now: number;
}

/**
 * Append-only insert with a stable per-conversation `seq` (MAX+1 inside the INSERT ... SELECT, so
 * it is atomic; concurrent writers collide on UNIQUE(conversation_id, seq): use `batchWithRetry`)
 * and a conversation version bump (ETag). Returns the message id too.
 */
export function insertMessageStatements(d1: D1Database, m: NewMessage): { id: string; statements: D1PreparedStatement[] } {
  const id = crypto.randomUUID();
  return {
    id,
    statements: [
      rawStmt(
        d1,
        `INSERT INTO messages (id, conversation_id, seq, author_type, author_name, kind, body_text, proposal_id, llm_call_id, created_at)
         SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?), ?, ?, ?, ?, ?, ?, ?`,
        id,
        m.conversationId,
        m.conversationId,
        m.authorType,
        m.authorName,
        m.kind,
        m.text,
        m.proposalId ?? null,
        m.llmCallId ?? null,
        m.now,
      ),
      rawStmt(d1, "UPDATE conversations SET version = version + 1, updated_at = ? WHERE id = ?", m.now, m.conversationId),
    ],
  };
}

const isConflict = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /(messages|proposals)/i.test(msg);
};

/** Runs `run()` (building fresh statements each time); retries on seq / version collisions. */
export async function batchWithRetry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (err) {
      if (!isConflict(err)) throw err;
      last = err;
    }
  }
  throw last;
}

export async function messageSeq(d1: D1Database, id: string): Promise<number> {
  const row = await d1.prepare("SELECT seq FROM messages WHERE id = ?").bind(id).first<{ seq: number }>();
  if (!row) throw new Error("Mensaje no encontrado tras insertarlo.");
  return row.seq;
}
