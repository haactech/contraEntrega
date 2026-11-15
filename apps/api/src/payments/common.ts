import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { rawStmt } from "../db/client";
import { milestones, paymentRequests } from "../db/schema";

export type PaymentRequestRow = typeof paymentRequests.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;

export const ACTIVE_STATUSES_SQL = "('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN')";
export const CONFIRMABLE_STATUSES_SQL = "('AWAITING_PAYMENT','EXPIRED_LOCAL','CREATION_UNKNOWN')";

/** Statement-level guard: true only while `agreements.write_id` equals this write's nonce. */
export const GUARD_SQL = "EXISTS (SELECT 1 FROM agreements WHERE id = ? AND write_id = ?)";

/**
 * First statement of a guarded write: bumps the agreement version and stamps `write_id` only
 * when `conditionSql` holds. Dependent statements carry GUARD_SQL, so they apply atomically
 * with it (or not at all). Check `meta.changes === 1` on this statement.
 */
export function claimStmt(
  d1: D1Database,
  agreementId: string,
  writeId: string,
  now: number,
  conditionSql: string,
  ...conditionParams: unknown[]
): D1PreparedStatement {
  return rawStmt(
    d1,
    `UPDATE agreements SET version = version + 1, write_id = ?, updated_at = ? WHERE id = ? AND (${conditionSql})`,
    writeId,
    now,
    agreementId,
    ...conditionParams,
  );
}

/** Event payload convention shared with the frontend (no banking data, ever). */
export function paymentEventPayload(
  pr: Pick<PaymentRequestRow, "amountCents" | "method" | "numRef">,
  milestoneKind: MilestoneRow["kind"],
): Record<string, unknown> {
  return { milestoneKind, amountCents: pr.amountCents, method: pr.method, numRef: pr.numRef };
}

export async function findPaymentRequest(db: Db, id: string): Promise<PaymentRequestRow | null> {
  const rows = await db.select().from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findMilestone(db: Db, id: string): Promise<MilestoneRow | null> {
  const rows = await db.select().from(milestones).where(eq(milestones.id, id)).limit(1);
  return rows[0] ?? null;
}
