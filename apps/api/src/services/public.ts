import { and, eq, sql } from "drizzle-orm";
import {
  type ActionVia,
  onAccepted,
  onAcceptedCleaning,
  type AcceptAgreementRequest,
  type BuyerAgreementView,
} from "@trato/shared";
import { rawStmt, stmt, type Db } from "../db/client";
import { agreements, milestones } from "../db/schema";
import { GUARD_SQL } from "../payments/common";
import type { AppEnv } from "../env";
import { AppError, invalidState, notFound } from "../lib/errors";
import { findAccessByHash, loadBundle } from "../repos/agreements";
import { expireStalePaymentRequests } from "../payments/expire";
import { sha256Hex } from "../lib/crypto";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { evidenceWindow } from "../lib/url-window";
import { buildBuyerView } from "./views";

export async function agreementVersion(db: Db, agreementId: string): Promise<number | null> {
  const rows = await db.select({ v: agreements.version }).from(agreements).where(eq(agreements.id, agreementId)).limit(1);
  return rows[0]?.v ?? null;
}

/** The window index keeps a 304 from ever revalidating expired signed evidence URLs. */
export const etagFor = (version: number, window: number): string => `"v${version}-w${window}"`;

export async function getBuyerView(db: Db, env: AppEnv, agreementId: string, now: number): Promise<BuyerAgreementView> {
  const b = await loadBundle(db, agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  return buildBuyerView(env, b, now);
}

export async function acceptAgreement(
  db: Db,
  env: AppEnv,
  agreementId: string,
  input: AcceptAgreementRequest,
  now: number,
  opts: { via?: ActionVia | undefined } = {},
): Promise<BuyerAgreementView> {
  const b = await loadBundle(db, agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  const cleaning = b.agreement.serviceType === "CLEANING";
  const transition = cleaning ? onAcceptedCleaning(b.agreement) : onAccepted(b.agreement);
  if (!transition.ok) throw new AppError(transition.code, transition.message);
  if (!b.agreement.termsSha256 || input.termsSha256 !== b.agreement.termsSha256) {
    throw new AppError("TERMS_MISMATCH", "Las condiciones cambiaron o no coinciden con las que viste. Recarga la página para revisarlas.");
  }

  const v = b.agreement.version;
  const writeId = crypto.randomUUID();
  const guard = sql`EXISTS (SELECT 1 FROM agreements WHERE id = ${agreementId} AND write_id = ${writeId})`;
  const results = await batchWithSeqRetry(() =>
    env.DB.batch([
      stmt(
        env.DB,
        db
          .update(agreements)
          .set({
            status: transition.agreementStatus,
            buyerAcceptedAt: now,
            buyerAcceptedName: input.buyerName,
            version: sql`${agreements.version} + 1`,
            writeId,
            updatedAt: now,
          })
          .where(and(eq(agreements.id, agreementId), eq(agreements.version, v), eq(agreements.status, "SHARED"))),
      ),
      // CLEANING has no advance milestone: BALANCE just stays WAITING_DELIVERY (no-op statement).
      stmt(
        env.DB,
        db
          .update(milestones)
          .set({ status: "advanceStatus" in transition ? transition.advanceStatus : "WAITING_DELIVERY" })
          .where(
            and(
              eq(milestones.agreementId, agreementId),
              eq(milestones.kind, cleaning ? "BALANCE" : "ADVANCE"),
              eq(milestones.status, cleaning ? "WAITING_DELIVERY" : "PENDING_ACCEPTANCE"),
              guard,
            ),
          ),
      ),
      // The confirmed proposal of this room is now ACCEPTED; anything still OPEN is moot.
      rawStmt(
        env.DB,
        `UPDATE proposals SET status = 'ACCEPTED'
         WHERE status = 'SELLER_CONFIRMED' AND terms_sha256 = ?
           AND conversation_id IN (SELECT id FROM conversations WHERE agreement_id = ?) AND ${GUARD_SQL}`,
        b.agreement.termsSha256,
        agreementId,
        agreementId,
        writeId,
      ),
      rawStmt(
        env.DB,
        `UPDATE proposals SET status = 'SUPERSEDED'
         WHERE status = 'OPEN' AND conversation_id IN (SELECT id FROM conversations WHERE agreement_id = ?) AND ${GUARD_SQL}`,
        agreementId,
        agreementId,
        writeId,
      ),
      ...appendEventStatements(env.DB, {
        agreementId,
        type: "TERMS_ACCEPTED",
        actorType: "BUYER",
        actorRef: input.buyerName,
        payload: { termsVersion: b.agreement.termsVersion, termsSha256: b.agreement.termsSha256, buyerName: input.buyerName, ...(opts.via ? { via: opts.via } : {}) },
        now,
        guardWriteId: writeId,
      }),
    ]),
  );
  if (results[0]?.meta.changes !== 1) {
    throw invalidState("Este acuerdo ya fue aceptado.");
  }
  return getBuyerView(db, env, agreementId, now);
}

/** Resolves the token of a buyer link to its agreement id; unknown or revoked -> 404 (same message). */
export async function resolveBuyerToken(db: Db, token: string): Promise<{ agreementId: string; tokenHash: string }> {
  const miss = () => notFound("Este enlace no existe o ya no está vigente.");
  if (!token || token.length > 128) throw miss();
  const tokenHash = await sha256Hex(token);
  const access = await findAccessByHash(db, tokenHash);
  if (!access || access.revokedAt !== null) throw miss();
  return { agreementId: access.agreementId, tokenHash };
}

/** Invariant 3: true when `sellerId` owns the agreement (and so can never act as its buyer). */
export async function isAgreementOwner(db: Db, sellerId: string, agreementId: string): Promise<boolean> {
  const rows = await db.select({ sellerId: agreements.sellerId }).from(agreements).where(eq(agreements.id, agreementId)).limit(1);
  return rows[0]?.sellerId === sellerId;
}

export const OWNER_CANNOT_BUY_MESSAGE =
  "No puedes realizar esta acción en tu propio trato. Debe hacerla el comprador desde su enlace.";

/** Buyer view after lazily expiring stale payment requests (no provider call). */
export async function getFreshBuyerView(db: Db, env: AppEnv, agreementId: string, now: number): Promise<BuyerAgreementView> {
  await expireStalePaymentRequests(env, agreementId, now);
  return getBuyerView(db, env, agreementId, now);
}
