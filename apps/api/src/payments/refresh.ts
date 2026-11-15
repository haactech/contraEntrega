import { mxnToCents, type PeyTransaction } from "@trato/shared";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { confirmPayment, parseDatePaid } from "./confirm";
import { findMilestone, findPaymentRequest } from "./common";
import { expirePaymentRequest } from "./expire";
import type { PeyGateway } from "./gateway";
import { reprocessPendingReceipts } from "./webhook";

export const REFRESH_THROTTLE_MS = 10_000;

export interface ReconcileOptions {
  /** Skip the per-request throttle (used when creating a replacement request). */
  force?: boolean;
  /** Expire an overdue AWAITING_PAYMENT request when no payment was found. */
  expireIfOverdue?: boolean;
}

async function confirmItem(
  env: AppEnv,
  gateway: PeyGateway,
  pr: { id: string; providerQrId: string | null },
  item: PeyTransaction,
  now: number,
): Promise<void> {
  const extPrId = item.metadata?.externalMetadata?.["paymentRequestId"];
  if (extPrId !== undefined && extPrId !== pr.id) return; // belongs to another request
  const base = item.amountBreakdown?.base;
  await confirmPayment(
    env,
    gateway,
    {
      source: "REFRESH",
      transactionId: item.id,
      codiQrId: pr.providerQrId ?? undefined,
      amountCents: mxnToCents(item.amount),
      baseAmountCents: base !== undefined ? mxnToCents(base) : undefined,
      paymentRequestId: pr.id,
      datePaid: parseDatePaid(item.datePaid, now),
    },
    now,
  );
}

/**
 * Active reconciliation of one payment request: replays matching PENDING_RETRY webhooks, asks the
 * provider (throttled to once per 10 s per request) and applies any PAID result through the same
 * `confirmPayment` the webhook uses. Never throws because of provider failures.
 */
export async function reconcilePaymentRequest(
  env: AppEnv,
  gateway: PeyGateway,
  paymentRequestId: string,
  now: number,
  options: ReconcileOptions = {},
): Promise<void> {
  const db = createDb(env.DB);
  let pr = await findPaymentRequest(db, paymentRequestId);
  if (!pr) return;
  const reconcilable = pr.status === "AWAITING_PAYMENT" || pr.status === "EXPIRED_LOCAL" || pr.status === "CREATION_UNKNOWN";
  if (!reconcilable) return;

  try {
    await reprocessPendingReceipts(env, gateway, pr, now);
    pr = (await findPaymentRequest(db, paymentRequestId)) ?? pr;
    if (pr.status === "PAID") return;

    const queryable = pr.method === "CODI_QR" ? pr.providerQrId !== null : pr.providerTransactionId !== null;
    if (queryable) {
      // Atomic throttle: only the request that wins this UPDATE talks to the provider.
      const claim = options.force
        ? await env.DB.prepare("UPDATE payment_requests SET last_reconciled_at = ? WHERE id = ?").bind(now, pr.id).run()
        : await env.DB.prepare(
            "UPDATE payment_requests SET last_reconciled_at = ? WHERE id = ? AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)",
          )
            .bind(now, pr.id, now - REFRESH_THROTTLE_MS)
            .run();
      if (claim.meta.changes === 1) {
        if (pr.method === "CODI_QR" && pr.providerQrId) {
          const r = await gateway.getQrTransactions(pr.providerQrId);
          if (r.kind === "ok") {
            for (const item of r.data.items) {
              if (item.status === "PAID") await confirmItem(env, gateway, pr, item, now);
            }
          } else logger.warn("refresh_provider_unavailable", { paymentRequestId: pr.id, kind: r.kind });
        } else if (pr.providerTransactionId) {
          const r = await gateway.getTransaction(pr.providerTransactionId);
          if (r.kind === "ok") {
            if (r.data.status === "PAID") await confirmItem(env, gateway, pr, r.data, now);
          } else logger.warn("refresh_provider_unavailable", { paymentRequestId: pr.id, kind: r.kind });
        }
      }
    }
  } catch (err) {
    logger.error("refresh_failed", { paymentRequestId, error: err });
  }

  if (options.expireIfOverdue) {
    const fresh = await findPaymentRequest(db, paymentRequestId);
    if (fresh && fresh.status === "AWAITING_PAYMENT" && fresh.expiresAt !== null && now > fresh.expiresAt) {
      const milestone = await findMilestone(db, fresh.milestoneId);
      if (milestone) await expirePaymentRequest(env, fresh, milestone, now);
    }
  }
}
