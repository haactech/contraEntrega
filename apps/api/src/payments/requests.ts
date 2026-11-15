import {
  PEY_LIMITS,
  buildConcept,
  buildPeyMetadata,
  canCreatePaymentRequest,
  centsToMxn,
  formatNumRef,
  onPaymentRequestCreated,
  type ActionVia,
  type CreatePaymentRequestInput,
  type PaymentRequestView,
} from "@trato/shared";
import { createDb, rawStmt, stmt } from "../db/client";
import { paymentRequests } from "../db/schema";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { loadBundle, nextCounter } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { paymentRequestView } from "../services/views";
import { GUARD_SQL, claimStmt, findPaymentRequest, paymentEventPayload, type PaymentRequestRow } from "./common";
import type { PeyGateway } from "./gateway";
import { reconcilePaymentRequest } from "./refresh";

const STALE_CREATING_MS = 60_000;
const MAX_ITERATIONS = 12;
const CREATING_WAIT_MS = 300;
const CREATING_MAX_WAITS = 6;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isIndexConflict = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /payment_requests/i.test(msg);
};

export interface CreatePaymentRequestResult {
  view: PaymentRequestView;
  /** True for a freshly created request (HTTP 201), false when an existing one is returned (200). */
  created: boolean;
}

/**
 * Spec §G "Creación de solicitud". Amount and bank account always come from the DB
 * (milestone + seller account); nothing monetary is taken from the client.
 */
export async function createPaymentRequest(
  env: AppEnv,
  gateway: PeyGateway,
  agreementId: string,
  milestoneId: string,
  input: CreatePaymentRequestInput,
  idempotencyKey: string | null,
  now: () => number = Date.now,
  opts: { via?: ActionVia | undefined } = {},
): Promise<CreatePaymentRequestResult> {
  const db = createDb(env.DB);
  let waits = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const t = now();
    const b = await loadBundle(db, agreementId);
    if (!b) throw new AppError("NOT_FOUND", "Este enlace no existe o ya no está vigente.");
    const milestone = b.milestones.find((m) => m.id === milestoneId);
    if (!milestone) throw new AppError("NOT_FOUND", "No encontramos este hito.");
    const viewOf = (p: PaymentRequestRow): PaymentRequestView => paymentRequestView(p, milestone.kind);
    const mine = b.paymentRequests.filter((p) => p.milestoneId === milestone.id);

    // Idempotency-Key: a live or paid request created with the same key is returned as-is.
    if (idempotencyKey) {
      const same = mine.find(
        (p) =>
          p.idempotencyKey === idempotencyKey &&
          (p.status === "PAID" || (p.status === "AWAITING_PAYMENT" && (p.expiresAt === null || p.expiresAt > t))),
      );
      if (same) return { view: viewOf(same), created: false };
    }

    let active = mine.find((p) => p.status === "CREATING" || p.status === "AWAITING_PAYMENT" || p.status === "CREATION_UNKNOWN");

    // A CREATING row that outlived any sane provider call: the worker died mid-flight.
    if (active?.status === "CREATING" && t - active.createdAt > STALE_CREATING_MS) {
      await env.DB.prepare("UPDATE payment_requests SET status = 'CREATION_UNKNOWN', failure_reason = 'stale_creating' WHERE id = ? AND status = 'CREATING'")
        .bind(active.id)
        .run();
      continue;
    }

    const check = canCreatePaymentRequest(
      { kind: milestone.kind, status: milestone.status, deliveryRound: milestone.deliveryRound },
      b.agreement,
      active ? { id: active.id, status: active.status, expiresAtMs: active.expiresAt } : null,
      t,
      { codiStatus: b.account.codiStatus, enabled: b.account.enabled },
    );

    if (!check.ok) {
      if (check.reusePaymentRequestId && active) return { view: viewOf(active), created: false };
      if (active && check.reconcilePaymentRequestId) {
        if (active.status === "AWAITING_PAYMENT") {
          // Overdue: reconcile once with the provider; without payment it becomes EXPIRED_LOCAL.
          await reconcilePaymentRequest(env, gateway, active.id, t, { force: true, expireIfOverdue: true });
          continue;
        }
        if (active.status === "CREATION_UNKNOWN") {
          if (active.method === "CODI_PN" && t < active.createdAt + PEY_LIMITS.pnExpirationSeconds * 1000) {
            throw new AppError("PAYMENT_PENDING_RECONCILIATION", "Estamos verificando tu solicitud anterior. Espera unos minutos antes de intentarlo otra vez.");
          }
          // A QR whose string never reached the buyer cannot have been paid; an expired PN is dead.
          await env.DB.prepare("UPDATE payment_requests SET status = 'ABANDONED' WHERE id = ? AND status = 'CREATION_UNKNOWN'")
            .bind(active.id)
            .run();
          continue;
        }
      }
      if (check.code === "PAYMENT_PENDING_RECONCILIATION" && active?.status === "CREATING" && waits < CREATING_MAX_WAITS) {
        // Another request (double click) is calling the provider right now: wait for its result.
        waits++;
        await sleep(CREATING_WAIT_MS);
        continue;
      }
      throw new AppError(check.code, check.message);
    }

    // ---- Step 3: reserve the slot. The partial unique index makes the INSERT the arbiter.
    const prId = crypto.randomUUID();
    const numRef = formatNumRef(await nextCounter(db, "num_ref"));
    const bankAccountId = b.account.peyBankAccountId;
    try {
      await stmt(
        env.DB,
        db.insert(paymentRequests).values({
          id: prId,
          milestoneId: milestone.id,
          method: input.method,
          providerBankAccountId: bankAccountId,
          amountCents: milestone.amountCents,
          numRef,
          phoneLast4: input.method === "CODI_PN" && input.phoneNumber ? input.phoneNumber.slice(-4) : null,
          idempotencyKey,
          status: "CREATING",
          createdAt: t,
        }),
      ).run();
    } catch (err) {
      if (isIndexConflict(err)) continue; // someone else got the slot: re-read and answer from it
      throw err;
    }

    // ---- Step 4: call the provider and persist the outcome.
    const reservation: PaymentRequestRow = {
      id: prId,
      milestoneId: milestone.id,
      method: input.method,
      provider: "PEY",
      providerQrId: null,
      providerTransactionId: null,
      providerBankAccountId: bankAccountId,
      amountCents: milestone.amountCents,
      numRef,
      qrString: null,
      phoneLast4: null,
      idempotencyKey,
      status: "CREATING",
      failureReason: null,
      lastReconciledAt: null,
      createdAt: t,
      expiresAt: null,
      paidAt: null,
    };
    const common = {
      amount: centsToMxn(milestone.amountCents),
      concept: buildConcept(b.agreement.code, milestone.kind),
      numRef,
      bankAccountId,
      metadata: buildPeyMetadata({ agreementId, milestoneId: milestone.id, paymentRequestId: prId }),
    };

    type Outcome =
      | { kind: "ok"; qrId: string | null; transactionId: string | null; qrString: string | null; expiresAt: number }
      | { kind: "rejected"; reason: string }
      | { kind: "ambiguous"; reason: string };
    let outcome: Outcome;
    try {
      if (input.method === "CODI_QR") {
        const r = await gateway.createQr({ ...common, expiration: PEY_LIMITS.qrExpirationSeconds, generateImage: false });
        outcome =
          r.kind === "ok"
            ? { kind: "ok", qrId: r.data.id, transactionId: null, qrString: r.data.qrString, expiresAt: now() + PEY_LIMITS.qrExpirationSeconds * 1000 }
            : r.kind === "rejected"
              ? { kind: "rejected", reason: `rejected:${r.status}:${r.peyError?.type ?? "unknown"}` }
              : { kind: "ambiguous", reason: r.reason };
      } else {
        const r = await gateway.createPushNotification({
          ...common,
          phoneNumber: input.phoneNumber as string,
          expiration: PEY_LIMITS.pnExpirationSeconds,
        });
        outcome =
          r.kind === "ok"
            ? { kind: "ok", qrId: null, transactionId: r.data.transactionId, qrString: null, expiresAt: now() + PEY_LIMITS.pnExpirationSeconds * 1000 }
            : r.kind === "rejected"
              ? { kind: "rejected", reason: `rejected:${r.status}:${r.peyError?.type ?? "unknown"}` }
              : { kind: "ambiguous", reason: r.reason };
      }
    } catch (err) {
      logger.error("gateway_threw", { error: err });
      outcome = { kind: "ambiguous", reason: "gateway_exception" };
    }

    const final: Outcome = outcome;
    const writeId = crypto.randomUUID();
    const creatingCond = "EXISTS (SELECT 1 FROM payment_requests WHERE id = ? AND status = 'CREATING')";

    if (final.kind === "ok") {
      const transition = onPaymentRequestCreated({
        kind: milestone.kind,
        status: milestone.status,
        deliveryRound: milestone.deliveryRound,
      });
      if (!transition.ok) throw new AppError(transition.code, transition.message);
      const results = await batchWithSeqRetry(() =>
        env.DB.batch([
          claimStmt(env.DB, agreementId, writeId, now(), creatingCond, prId),
          rawStmt(
            env.DB,
            `UPDATE payment_requests SET status = 'AWAITING_PAYMENT', provider_qr_id = ?, provider_transaction_id = ?, qr_string = ?, expires_at = ?
             WHERE id = ? AND status = 'CREATING' AND ${GUARD_SQL}`,
            final.qrId,
            final.transactionId,
            final.qrString,
            final.expiresAt,
            prId,
            agreementId,
            writeId,
          ),
          rawStmt(
            env.DB,
            `UPDATE milestones SET status = ? WHERE id = ? AND status = ? AND ${GUARD_SQL}`,
            transition.milestoneStatus,
            milestone.id,
            milestone.status,
            agreementId,
            writeId,
          ),
          ...appendEventStatements(env.DB, {
            agreementId,
            type: "PAYMENT_REQUEST_CREATED",
            actorType: "BUYER",
            payload: { ...paymentEventPayload(reservation, milestone.kind), ...(opts.via ? { via: opts.via } : {}) },
            now: now(),
            guardWriteId: writeId,
          }),
        ]),
      );
      if (results[0]?.meta.changes !== 1) {
        throw new AppError("PROVIDER_ERROR", "Estamos verificando el estado de tu solicitud. Intenta de nuevo en unos minutos.");
      }
      const fresh = await findPaymentRequest(db, prId);
      if (!fresh) throw new AppError("INTERNAL", "No se pudo leer la solicitud creada.");
      return { view: viewOf(fresh), created: true };
    }

    if (final.kind === "rejected") {
      await batchWithSeqRetry(() =>
        env.DB.batch([
          claimStmt(env.DB, agreementId, writeId, now(), creatingCond, prId),
          rawStmt(
            env.DB,
            `UPDATE payment_requests SET status = 'FAILED', failure_reason = ? WHERE id = ? AND status = 'CREATING' AND ${GUARD_SQL}`,
            final.reason,
            prId,
            agreementId,
            writeId,
          ),
          ...appendEventStatements(env.DB, {
            agreementId,
            type: "PAYMENT_REQUEST_FAILED",
            actorType: "SYSTEM",
            payload: { ...paymentEventPayload(reservation, milestone.kind), ...(opts.via ? { via: opts.via } : {}) },
            now: now(),
            guardWriteId: writeId,
          }),
        ]),
      );
      throw new AppError("PROVIDER_ERROR", "No pudimos generar el cobro en este momento. Inténtalo de nuevo.");
    }

    await env.DB.prepare("UPDATE payment_requests SET status = 'CREATION_UNKNOWN', failure_reason = ? WHERE id = ? AND status = 'CREATING'")
      .bind(final.reason, prId)
      .run();
    throw new AppError("PROVIDER_ERROR", "Estamos verificando el estado de tu solicitud. Intenta de nuevo en unos minutos.");
  }
  throw new AppError("PAYMENT_PENDING_RECONCILIATION", "Estamos preparando tu cobro. Espera unos segundos e inténtalo de nuevo.");
}
