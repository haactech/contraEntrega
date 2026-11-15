import type { PaymentRequestView } from "@trato/shared";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { AppError, notFound } from "../lib/errors";
import { findMilestone, findPaymentRequest } from "../payments/common";
import { getGateway } from "../payments/gateway";
import { reconcilePaymentRequest } from "../payments/refresh";
import { createPaymentRequest, type CreatePaymentRequestResult } from "../payments/requests";
import { paymentRequestView } from "./views";

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined || header === "") return null;
  if (!IDEMPOTENCY_KEY_RE.test(header)) {
    throw new AppError("VALIDATION_ERROR", "La clave de idempotencia no es válida.");
  }
  return header;
}

export function createForBuyer(
  env: AppEnv,
  agreementId: string,
  milestoneId: string,
  input: Parameters<typeof createPaymentRequest>[4],
  idempotencyKey: string | null,
): Promise<CreatePaymentRequestResult> {
  return createPaymentRequest(env, getGateway(env), agreementId, milestoneId, input, idempotencyKey);
}

/** Refresh: reconcile (throttled) and return the request's current view. */
export async function refreshForBuyer(
  env: AppEnv,
  agreementId: string,
  paymentRequestId: string,
  now: number,
): Promise<PaymentRequestView> {
  const db = createDb(env.DB);
  const pr = await findPaymentRequest(db, paymentRequestId);
  const milestone = pr ? await findMilestone(db, pr.milestoneId) : null;
  if (!pr || !milestone || milestone.agreementId !== agreementId) throw notFound("No encontramos esta solicitud de pago.");
  await reconcilePaymentRequest(env, getGateway(env), pr.id, now, { expireIfOverdue: true });
  const fresh = await findPaymentRequest(db, pr.id);
  if (!fresh) throw notFound("No encontramos esta solicitud de pago.");
  return paymentRequestView(fresh, milestone.kind);
}
