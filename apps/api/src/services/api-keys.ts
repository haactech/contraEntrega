import { and, desc, eq, isNull } from "drizzle-orm";
import { API_KEY_PREFIX, API_KEY_VISIBLE_PREFIX_CHARS, type ApiKeyView, type CreateApiKeyResponse } from "@trato/shared";
import { rawStmt, type Db } from "../db/client";
import { apiKeys } from "../db/schema";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { AppError, notFound } from "../lib/errors";

export const MAX_ACTIVE_API_KEYS = 5;
/** `last_used_at` is refreshed at most once per minute per key. */
export const LAST_USED_THROTTLE_MS = 60_000;

type ApiKeyRow = typeof apiKeys.$inferSelect;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The table has no prefix column, so the visible prefix lives in the (non secret) key id:
 * `<first 8 chars of the secret>.<random suffix>`. 4 random characters never authenticate anything.
 */
const prefixOf = (id: string): string => `${id.split(".")[0] ?? ""}…`;

export const apiKeyView = (r: ApiKeyRow): ApiKeyView => ({
  id: r.id,
  label: r.label,
  prefix: prefixOf(r.id),
  createdAt: iso(r.createdAt),
  lastUsedAt: r.lastUsedAt === null ? null : iso(r.lastUsedAt),
  revokedAt: r.revokedAt === null ? null : iso(r.revokedAt),
});

/** Creates a key; the plaintext secret is returned only here and only its sha-256 is stored. */
export async function createApiKey(env: AppEnv, sellerId: string, label: string, now: number): Promise<CreateApiKeyResponse> {
  const secret = `${API_KEY_PREFIX}${randomToken()}`;
  const id = `${secret.slice(0, API_KEY_VISIBLE_PREFIX_CHARS)}.${crypto.randomUUID().slice(0, 8)}`;
  const keyHash = await sha256Hex(secret);
  // Conditional insert: the limit check and the write are one atomic statement.
  const res = await rawStmt(
    env.DB,
    `INSERT INTO api_keys (id, seller_id, label, key_hash, created_at)
     SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys WHERE seller_id = ? AND revoked_at IS NULL) < ?`,
    id,
    sellerId,
    label,
    keyHash,
    now,
    sellerId,
    MAX_ACTIVE_API_KEYS,
  ).run();
  if (res.meta.changes !== 1) {
    throw new AppError("INVALID_STATE", `Ya tienes ${MAX_ACTIVE_API_KEYS} llaves activas. Revoca una para crear otra.`);
  }
  return { key: apiKeyView({ id, sellerId, label, keyHash, createdAt: now, lastUsedAt: null, revokedAt: null }), secret };
}

export async function listApiKeys(db: Db, sellerId: string): Promise<ApiKeyView[]> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.sellerId, sellerId)).orderBy(desc(apiKeys.createdAt));
  return rows.map(apiKeyView);
}

/** Idempotent revoke; 404 when the key is not the seller's. */
export async function revokeApiKey(db: Db, sellerId: string, id: string, now: number): Promise<void> {
  const rows = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.sellerId, sellerId))).limit(1);
  if (rows.length === 0) throw notFound("No encontramos esa llave.");
  await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.sellerId, sellerId), isNull(apiKeys.revokedAt)));
}

export interface ApiKeyIdentity {
  apiKeyId: string;
  sellerId: string;
}

/** Resolves a bearer secret to its seller. Unknown, malformed or revoked keys -> null. */
export async function authenticateApiKey(db: Db, secret: string, now: number): Promise<ApiKeyIdentity | null> {
  if (!secret.startsWith(API_KEY_PREFIX) || secret.length > 128) return null;
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, await sha256Hex(secret))).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt !== null) return null;
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_THROTTLE_MS) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  }
  return { apiKeyId: row.id, sellerId: row.sellerId };
}
