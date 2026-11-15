import { eq } from "drizzle-orm";
import {
  canConfirmPayment,
  mxnToCents,
  onPaymentConfirmed,
  type PaymentRequestStatus,
} from "@trato/shared";
import { createDb, rawStmt } from "../db/client";
import { paymentRequests } from "../db/schema";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { loadBundle } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import {
  CONFIRMABLE_STATUSES_SQL,
  GUARD_SQL,
  claimStmt,
  findMilestone,
  findPaymentRequest,
  paymentEventPayload,
  type PaymentRequestRow,
} from "./common";
import type { PeyGateway } from "./gateway";

export type ConfirmSource = "WEBHOOK" | "REFRESH" | "SIMULATE";

/** Provider payment data, normalized by the caller (webhook / refresh / simulate). */
export interface ConfirmInput {
  source: ConfirmSource;
  transactionId: string;
  codiQrId?: string | undefined;
  /** Required for webhooks; refresh queries by the request's own ids so it may omit it. */
  bankAccountId?: string | undefined;
  /** Amount reported by the provider, in cents (may include fee/tip). */
  amountCents: number;
  /** amountBreakdown.base in cents, when the caller already knows it. */
  baseAmountCents?: number | undefined;
  paymentRequestId?: string | undefined;
  /** Epoch ms. */
  datePaid: number;
}

export interface ConfirmResult {
  status: "PROCESSED" | "DUPLICATE" | "UNMATCHED" | "NOT_FOUND";
  reason?: string;
  paymentRequestId?: string;
}

const MAX_ATTEMPTS = 4;

/** Epoch seconds/ms number or ISO-like string -> epoch ms (falls back to `fallback`). */
export function parseDatePaid(v: number | string | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n)) return parseDatePaid(n, fallback);
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return fallback;
}

async function findCorrelated(env: AppEnv, input: ConfirmInput): Promise<PaymentRequestRow | null> {
  const db = createDb(env.DB);
  if (input.paymentRequestId) return findPaymentRequest(db, input.paymentRequestId);
  if (input.codiQrId) {
    const rows = await db.select().from(paymentRequests).where(eq(paymentRequests.providerQrId, input.codiQrId)).limit(1);
    if (rows[0]) return rows[0];
  }
  const rows = await db.select().from(paymentRequests).where(eq(paymentRequests.providerTransactionId, input.transactionId)).limit(1);
  return rows[0] ?? null;
}

const hasEventForTx = (
  events: { eventType: string; payloadJson: string }[],
  type: string,
  transactionId: string,
): boolean => events.some((e) => e.eventType === type && e.payloadJson.includes(JSON.stringify(transactionId)));

/**
 * The single place where a provider-confirmed payment is applied (webhook, refresh, simulate).
 * Idempotent: the PR/milestone updates are conditional and all writes land in one D1 batch.
 */
export async function confirmPayment(
  env: AppEnv,
  gateway: PeyGateway,
  input: ConfirmInput,
  now: number,
): Promise<ConfirmResult> {
  const db = createDb(env.DB);
  // Resolved lazily (at most once): provider breakdown for amount = base + fee.
  let resolvedBase: number | undefined = input.baseAmountCents;
  let baseLookupDone = input.baseAmountCents !== undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pr = await findCorrelated(env, input);
    if (!pr) return { status: "NOT_FOUND", reason: "payment_request_not_found" };
    const milestone = await findMilestone(db, pr.milestoneId);
    if (!milestone) return { status: "NOT_FOUND", reason: "milestone_not_found" };
    const bundle = await loadBundle(db, milestone.agreementId);
    if (!bundle) return { status: "NOT_FOUND", reason: "agreement_not_found" };
    const agreementId = bundle.agreement.id;

    const unmatched = async (reason: string): Promise<ConfirmResult> => {
      if (!hasEventForTx(bundle.events, "PAYMENT_UNMATCHED", input.transactionId)) {
        await batchWithSeqRetry(() =>
          env.DB.batch(
            appendEventStatements(env.DB, {
              agreementId,
              type: "PAYMENT_UNMATCHED",
              actorType: "PROVIDER",
              actorRef: input.source,
              payload: {
                reason,
                transactionId: input.transactionId,
                amountCents: input.amountCents,
                paymentRequestId: pr.id,
                milestoneKind: milestone.kind,
              },
              now,
            }),
          ),
        );
      }
      logger.warn("payment_unmatched", { reason, paymentRequestId: pr.id, source: input.source });
      return { status: "UNMATCHED", reason, paymentRequestId: pr.id };
    };

    // ---- Spec §G step 5: account, qr id, transaction id, amount.
    if (input.bankAccountId === undefined) {
      if (input.source !== "REFRESH") return unmatched("missing_bank_account");
    } else if (input.bankAccountId !== pr.providerBankAccountId) {
      return unmatched("bank_account_mismatch");
    }
    if (pr.method === "CODI_QR") {
      if (!input.codiQrId) return unmatched("missing_qr_id");
      if (pr.providerQrId !== null && input.codiQrId !== pr.providerQrId) return unmatched("qr_id_mismatch");
    } else if (pr.providerTransactionId !== null && input.transactionId !== pr.providerTransactionId) {
      return unmatched("transaction_id_mismatch");
    }
    if (pr.providerTransactionId === null) {
      const other = await db
        .select({ id: paymentRequests.id })
        .from(paymentRequests)
        .where(eq(paymentRequests.providerTransactionId, input.transactionId))
        .limit(1);
      if (other[0] && other[0].id !== pr.id) return unmatched("transaction_already_applied");
    }

    // Amount rule (§A.2): exact, or amountBreakdown.base equals the expected amount.
    const expected = pr.amountCents;
    let amountOk = input.amountCents === expected || resolvedBase === expected;
    if (!amountOk && input.amountCents > expected && !baseLookupDone) {
      baseLookupDone = true;
      const tx = await gateway.getTransaction(input.transactionId);
      if (tx.kind === "ambiguous") throw new Error(`provider lookup failed: ${tx.reason}`);
      if (tx.kind === "ok" && tx.data.amountBreakdown?.base !== undefined) {
        resolvedBase = mxnToCents(tx.data.amountBreakdown.base);
      }
      amountOk = resolvedBase === expected;
    }
    if (!amountOk) return unmatched("amount_mismatch");

    // ---- Already applied?
    if (pr.status === "PAID" && pr.providerTransactionId === input.transactionId) {
      return { status: "DUPLICATE", reason: "already_confirmed", paymentRequestId: pr.id };
    }
    const msSnap = { kind: milestone.kind, status: milestone.status, deliveryRound: milestone.deliveryRound };
    const prSnap = { id: pr.id, status: pr.status as PaymentRequestStatus, expiresAtMs: pr.expiresAt };
    const transition = onPaymentConfirmed(msSnap, bundle.agreement);
    const can = canConfirmPayment(prSnap, msSnap);
    if (!transition.ok || !can.ok) return unmatched("invalid_state");

    if (transition.duplicate || pr.status === "PAID") {
      // The money arrived but the milestone is already paid: flag it for manual review.
      if (!hasEventForTx(bundle.events, "DUPLICATE_PAYMENT_DETECTED", input.transactionId)) {
        await batchWithSeqRetry(() =>
          env.DB.batch(
            appendEventStatements(env.DB, {
              agreementId,
              type: "DUPLICATE_PAYMENT_DETECTED",
              actorType: "PROVIDER",
              actorRef: input.source,
              payload: { ...paymentEventPayload(pr, milestone.kind), transactionId: input.transactionId },
              now,
            }),
          ),
        );
      }
      return { status: "DUPLICATE", reason: "milestone_already_paid", paymentRequestId: pr.id };
    }

    // ---- Apply: one batch, guarded by the agreement write nonce.
    const writeId = crypto.randomUUID();
    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(
          env.DB,
          agreementId,
          writeId,
          now,
          `EXISTS (SELECT 1 FROM payment_requests WHERE id = ? AND status IN ${CONFIRMABLE_STATUSES_SQL})
           AND EXISTS (SELECT 1 FROM milestones WHERE id = ? AND status <> 'PAID')`,
          pr.id,
          milestone.id,
        ),
        rawStmt(
          env.DB,
          `UPDATE payment_requests SET status = 'PAID', provider_transaction_id = ?, provider_qr_id = COALESCE(provider_qr_id, ?), paid_at = ?
           WHERE id = ? AND status IN ${CONFIRMABLE_STATUSES_SQL} AND ${GUARD_SQL}`,
          input.transactionId,
          input.codiQrId ?? null,
          input.datePaid,
          pr.id,
          agreementId,
          writeId,
        ),
        rawStmt(
          env.DB,
          `UPDATE payment_requests SET status = 'ABANDONED'
           WHERE milestone_id = ? AND id <> ? AND status IN ('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN') AND ${GUARD_SQL}`,
          milestone.id,
          pr.id,
          agreementId,
          writeId,
        ),
        rawStmt(
          env.DB,
          `UPDATE milestones SET status = 'PAID', paid_at = ? WHERE id = ? AND status <> 'PAID' AND ${GUARD_SQL}`,
          input.datePaid,
          milestone.id,
          agreementId,
          writeId,
        ),
        rawStmt(
          env.DB,
          `UPDATE agreements SET status = ?, completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END WHERE id = ? AND write_id = ?`,
          transition.agreementStatus,
          transition.agreementCompleted ? 1 : 0,
          now,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: "PAYMENT_CONFIRMED",
          actorType: "PROVIDER",
          actorRef: input.source,
          payload: paymentEventPayload(pr, milestone.kind),
          now,
          guardWriteId: writeId,
        }),
        ...(transition.agreementCompleted
          ? appendEventStatements(env.DB, {
              agreementId,
              type: "AGREEMENT_COMPLETED",
              actorType: "SYSTEM",
              payload: {},
              now,
              guardWriteId: writeId,
            })
          : []),
      ]),
    );
    if (results[0]?.meta.changes === 1) {
      return { status: "PROCESSED", paymentRequestId: pr.id };
    }
    // Lost a race (another confirmation or an expiry): re-read and re-evaluate.
  }
  throw new Error("confirmPayment: demasiados intentos por conflicto de escritura");
}
