import { and, eq, lt } from "drizzle-orm";
import { onPaymentRequestExpiredOrFailed } from "@trato/shared";
import { createDb, rawStmt } from "../db/client";
import { milestones, paymentRequests } from "../db/schema";
import type { AppEnv } from "../env";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import {
  GUARD_SQL,
  claimStmt,
  paymentEventPayload,
  type MilestoneRow,
  type PaymentRequestRow,
} from "./common";

/**
 * AWAITING_PAYMENT -> EXPIRED_LOCAL, milestone back to its charge-eligible state, event, version++,
 * all in one batch. Returns false when someone else changed the request first (nothing applied).
 */
export async function expirePaymentRequest(
  env: AppEnv,
  pr: PaymentRequestRow,
  milestone: MilestoneRow,
  now: number,
): Promise<boolean> {
  const agreementId = milestone.agreementId;
  const back = onPaymentRequestExpiredOrFailed({
    kind: milestone.kind,
    status: milestone.status,
    deliveryRound: milestone.deliveryRound,
  }).milestoneStatus;
  const writeId = crypto.randomUUID();
  const results = await batchWithSeqRetry(() =>
    env.DB.batch([
      claimStmt(
        env.DB,
        agreementId,
        writeId,
        now,
        "EXISTS (SELECT 1 FROM payment_requests WHERE id = ? AND status = 'AWAITING_PAYMENT')",
        pr.id,
      ),
      rawStmt(
        env.DB,
        `UPDATE payment_requests SET status = 'EXPIRED_LOCAL' WHERE id = ? AND status = 'AWAITING_PAYMENT' AND ${GUARD_SQL}`,
        pr.id,
        agreementId,
        writeId,
      ),
      rawStmt(
        env.DB,
        `UPDATE milestones SET status = ? WHERE id = ? AND status = 'AWAITING_PAYMENT' AND ${GUARD_SQL}`,
        back,
        milestone.id,
        agreementId,
        writeId,
      ),
      ...appendEventStatements(env.DB, {
        agreementId,
        type: "PAYMENT_REQUEST_EXPIRED",
        actorType: "SYSTEM",
        payload: paymentEventPayload(pr, milestone.kind),
        now,
        guardWriteId: writeId,
      }),
    ]),
  );
  return results[0]?.meta.changes === 1;
}

/** Lazily expires every overdue AWAITING_PAYMENT request of an agreement (no provider calls). */
export async function expireStalePaymentRequests(env: AppEnv, agreementId: string, now: number): Promise<number> {
  const db = createDb(env.DB);
  const rows = await db
    .select({ pr: paymentRequests, milestone: milestones })
    .from(paymentRequests)
    .innerJoin(milestones, eq(milestones.id, paymentRequests.milestoneId))
    .where(
      and(
        eq(milestones.agreementId, agreementId),
        eq(paymentRequests.status, "AWAITING_PAYMENT"),
        lt(paymentRequests.expiresAt, now),
      ),
    );
  let expired = 0;
  for (const r of rows) if (await expirePaymentRequest(env, r.pr, r.milestone, now)) expired++;
  return expired;
}
