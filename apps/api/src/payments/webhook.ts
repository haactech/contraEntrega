import { Webhook, WebhookVerificationError } from "standardwebhooks";
import {
  PeyWebhookEventSchema,
  getExternalMetadata,
  mxnToCents,
  redactPeyWebhookPayload,
  type PeyWebhookEvent,
  type WebhookProcessingStatus,
} from "@trato/shared";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { confirmPayment, parseDatePaid, type ConfirmResult } from "./confirm";
import type { PeyGateway } from "./gateway";
import type { PaymentRequestRow } from "./common";

export const WEBHOOK_MAX_BYTES = 64 * 1024;
const PROVIDER = "PEY";

export interface WebhookOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
  /** Final receipt status when the pipeline got that far. */
  processingStatus?: WebhookProcessingStatus;
}

interface Finalize {
  status: WebhookProcessingStatus;
  reason?: string | null;
  paymentRequestId?: string | null;
}

async function finalizeReceipt(env: AppEnv, receiptId: string, f: Finalize, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_receipts SET processing_status = ?, processed_at = ?, unmatched_reason = ?,
       payment_request_id = COALESCE(?, payment_request_id) WHERE id = ?`,
  )
    .bind(f.status, f.status === "PENDING_RETRY" ? null : now, f.reason ?? null, f.paymentRequestId ?? null, receiptId)
    .run();
}

/** Drops sensitive fields from a payload we could not parse into a known event. */
function redactUnknown(json: unknown): Record<string, unknown> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return {};
  const { clabe: _c, name: _n, taxId: _t, ...rest } = json as Record<string, unknown>;
  const md = rest["metadata"];
  if (md && typeof md === "object" && !Array.isArray(md)) {
    const { clabe: _mc, ...mdRest } = md as Record<string, unknown>;
    rest["metadata"] = mdRest;
  }
  return rest;
}

type ApplyOutcome = { httpStatus: number; body: Record<string, unknown>; processingStatus: WebhookProcessingStatus };

/** Steps 3-7 of the pipeline for an already-recorded receipt. */
async function applyEvent(
  env: AppEnv,
  gateway: PeyGateway,
  receiptId: string,
  event: PeyWebhookEvent | null,
  now: number,
): Promise<ApplyOutcome> {
  try {
    if (!event) {
      await finalizeReceipt(env, receiptId, { status: "IGNORED", reason: "unknown_event_type" }, now);
      return { httpStatus: 200, body: { ok: true, status: "IGNORED" }, processingStatus: "IGNORED" };
    }
    if (event.type === "bank.account.updated") {
      await env.DB.prepare(
        `UPDATE demo_bank_accounts SET codi_status = ?, verified_at = CASE WHEN ? = 'ACTIVE' THEN ? ELSE verified_at END
         WHERE pey_bank_account_id = ?`,
      )
        .bind(event.codiStatus, event.codiStatus, now, event.bankAccountId)
        .run();
      await finalizeReceipt(env, receiptId, { status: "PROCESSED" }, now);
      return { httpStatus: 200, body: { ok: true, status: "PROCESSED" }, processingStatus: "PROCESSED" };
    }

    let amountCents: number;
    try {
      amountCents = mxnToCents(event.amount);
    } catch {
      await finalizeReceipt(env, receiptId, { status: "IGNORED", reason: "invalid_amount" }, now);
      return { httpStatus: 200, body: { ok: true, status: "IGNORED" }, processingStatus: "IGNORED" };
    }
    const result: ConfirmResult = await confirmPayment(
      env,
      gateway,
      {
        source: "WEBHOOK",
        transactionId: event.transactionId,
        codiQrId: event.type === "codi.qr.payment_received" ? event.codiQrId : undefined,
        bankAccountId: event.bankAccountId,
        amountCents,
        paymentRequestId: getExternalMetadata(event)["paymentRequestId"],
        datePaid: parseDatePaid(event.datePaid, now),
      },
      now,
    );
    switch (result.status) {
      case "PROCESSED":
        await finalizeReceipt(env, receiptId, { status: "PROCESSED", paymentRequestId: result.paymentRequestId ?? null }, now);
        return { httpStatus: 200, body: { ok: true, status: "PROCESSED" }, processingStatus: "PROCESSED" };
      case "DUPLICATE":
        await finalizeReceipt(env, receiptId, { status: "DUPLICATE", reason: result.reason ?? null, paymentRequestId: result.paymentRequestId ?? null }, now);
        return { httpStatus: 200, body: { ok: true, status: "DUPLICATE" }, processingStatus: "DUPLICATE" };
      case "UNMATCHED":
        await finalizeReceipt(env, receiptId, { status: "UNMATCHED", reason: result.reason ?? null, paymentRequestId: result.paymentRequestId ?? null }, now);
        return { httpStatus: 200, body: { ok: true, status: "UNMATCHED" }, processingStatus: "UNMATCHED" };
      case "NOT_FOUND":
        // Likely a race with PR creation: leave the receipt retryable and let the provider retry.
        await finalizeReceipt(env, receiptId, { status: "PENDING_RETRY", reason: result.reason ?? null }, now);
        return { httpStatus: 503, body: { ok: false, status: "PENDING_RETRY" }, processingStatus: "PENDING_RETRY" };
    }
  } catch (err) {
    logger.error("webhook_processing_failed", { receiptId, error: err });
    try {
      await finalizeReceipt(env, receiptId, { status: "PENDING_RETRY", reason: "processing_error" }, now);
    } catch {
      // the receipt was inserted as PENDING_RETRY already
    }
    return { httpStatus: 500, body: { ok: false, status: "PENDING_RETRY" }, processingStatus: "PENDING_RETRY" };
  }
}

/**
 * Spec §G webhook pipeline. `raw` must be the untouched request body: the signature is verified
 * over it BEFORE anything is parsed.
 */
export async function handlePeyWebhook(
  env: AppEnv,
  gateway: PeyGateway,
  raw: string,
  headers: Headers,
  now: number,
): Promise<WebhookOutcome> {
  const webhookId = headers.get("webhook-id");
  try {
    new Webhook(env.PEY_WEBHOOK_SECRET).verify(raw, {
      "webhook-id": webhookId ?? "",
      "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
      "webhook-signature": headers.get("webhook-signature") ?? "",
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return { httpStatus: 401, body: { error: { code: "UNAUTHORIZED", message: "Firma inválida." } } };
    }
    // Valid signature but the library could not read the body (not JSON).
    if (!(err instanceof SyntaxError)) throw err;
  }
  if (!webhookId) return { httpStatus: 401, body: { error: { code: "UNAUTHORIZED", message: "Firma inválida." } } };

  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = PeyWebhookEventSchema.safeParse(json);
  const event = parsed.success ? parsed.data : null;
  const eventType =
    json !== null && typeof json === "object" && typeof (json as { type?: unknown }).type === "string"
      ? String((json as { type: string }).type).slice(0, 80)
      : "unknown";
  const redacted = event ? redactPeyWebhookPayload(event) : redactUnknown(json);
  const transactionId = event && event.type !== "bank.account.updated" ? event.transactionId : null;
  const metaPrId = event ? (getExternalMetadata(event)["paymentRequestId"] ?? null) : null;

  const receiptId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO webhook_receipts (id, provider, webhook_id, event_type, transaction_id, payment_request_id, received_at, processing_status, payload_redacted_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_RETRY', ?)
     ON CONFLICT(provider, webhook_id) DO NOTHING`,
  )
    .bind(receiptId, PROVIDER, webhookId, eventType, transactionId, metaPrId, now, JSON.stringify(redacted))
    .run();

  let activeReceiptId = receiptId;
  if (inserted.meta.changes === 0) {
    const existing = await env.DB.prepare("SELECT id, processing_status FROM webhook_receipts WHERE provider = ? AND webhook_id = ?")
      .bind(PROVIDER, webhookId)
      .first<{ id: string; processing_status: WebhookProcessingStatus }>();
    if (!existing || existing.processing_status !== "PENDING_RETRY") {
      return { httpStatus: 200, body: { ok: true, duplicate: true } };
    }
    activeReceiptId = existing.id;
  }

  const out = await applyEvent(env, gateway, activeReceiptId, event, now);
  return out;
}

interface PendingReceiptRow {
  id: string;
  payload_redacted_json: string;
}

/** Reprocesses PENDING_RETRY receipts whose payload correlates with `pr` (used by refresh). */
export async function reprocessPendingReceipts(
  env: AppEnv,
  gateway: PeyGateway,
  pr: PaymentRequestRow,
  now: number,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, payload_redacted_json FROM webhook_receipts
     WHERE processing_status = 'PENDING_RETRY'
       AND (payment_request_id = ? OR transaction_id = ? OR json_extract(payload_redacted_json, '$.codiQrId') = ?)
     ORDER BY received_at LIMIT 10`,
  )
    .bind(pr.id, pr.providerTransactionId, pr.providerQrId)
    .all<PendingReceiptRow>();
  for (const row of rows.results) {
    let event: PeyWebhookEvent | null = null;
    try {
      const p = PeyWebhookEventSchema.safeParse(JSON.parse(row.payload_redacted_json));
      event = p.success ? p.data : null;
    } catch {
      event = null;
    }
    await applyEvent(env, gateway, row.id, event, now);
  }
}
