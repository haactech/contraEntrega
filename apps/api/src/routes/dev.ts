import { Hono } from "hono";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import type { HonoEnv } from "../env";
import { createDb } from "../db/client";
import { AppError, invalidState, notFound } from "../lib/errors";
import { parseJson } from "../lib/validate";
import { findMilestone, findPaymentRequest } from "../payments/common";
import { getGateway } from "../payments/gateway";
import { handlePeyWebhook } from "../payments/webhook";

export const devRoutes = new Hono<HonoEnv>();

const SimulatePaymentSchema = z.object({ paymentRequestId: z.string().min(1).max(64) });

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function fakeUlid(now: number): string {
  let t = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = ULID_ALPHABET[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => ULID_ALPHABET[b % 32]).join("");
  return t + rand;
}

/**
 * Mock-mode payment simulator: builds a realistic pey webhook, signs it with the real secret and
 * feeds it to the SAME pipeline as POST /api/webhooks/pey. 404 outside mock mode.
 */
devRoutes.post("/simulate-payment", async (c) => {
  if (c.env.PAYMENTS_MODE !== "mock") throw notFound();
  const { paymentRequestId } = await parseJson(c, SimulatePaymentSchema);
  const db = createDb(c.env.DB);
  const pr = await findPaymentRequest(db, paymentRequestId);
  const milestone = pr ? await findMilestone(db, pr.milestoneId) : null;
  if (!pr || !milestone) throw notFound("No encontramos esta solicitud de pago.");
  if (pr.method === "CODI_QR" && !pr.providerQrId) {
    throw invalidState("Esta solicitud no tiene un QR emitido; no se puede simular el pago.");
  }

  const now = Date.now();
  // Push (PN): pey returns the transactionId when the request is created and the webhook
  // carries that same id. QR: the transaction is born when the payer scans, so it is new.
  const transactionId = pr.method === "CODI_PN" && pr.providerTransactionId ? pr.providerTransactionId : fakeUlid(now);
  const common = {
    amount: pr.amountCents / 100,
    apiKeyId: "mock_api_key",
    bankAccountId: pr.providerBankAccountId,
    concept: `Trato ${milestone.kind === "ADVANCE" ? "anticipo" : "saldo"}`,
    datePaid: now,
    numRef: pr.numRef,
    transactionId,
    metadata: {
      bankCode: "40012",
      accountType: "40",
      description: "Pago simulado",
      trackingKey: `MOCK${now}`,
      externalMetadata: {
        agreementId: milestone.agreementId,
        milestoneId: milestone.id,
        paymentRequestId: pr.id,
        app: "trato",
      },
    },
  };
  const payload =
    pr.method === "CODI_QR"
      ? { type: "codi.qr.payment_received", ...common, codiQrId: pr.providerQrId }
      : { type: "codi.pn.payment_received", ...common };
  const raw = JSON.stringify(payload);

  const msgId = `msg_${crypto.randomUUID()}`;
  const timestamp = new Date(now);
  const signature = new Webhook(c.env.PEY_WEBHOOK_SECRET).sign(msgId, timestamp, raw);
  const headers = new Headers({
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  });
  const out = await handlePeyWebhook(c.env, getGateway(c.env), raw, headers, now);
  if (out.httpStatus >= 500 && out.httpStatus !== 503) throw new AppError("INTERNAL", "No se pudo procesar el pago simulado.");
  return c.json({ ok: true, processingStatus: out.processingStatus ?? "IGNORED" });
});
