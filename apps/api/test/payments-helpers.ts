import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import type { BuyerAgreementView, PaymentRequestView } from "@trato/shared";
import app from "../src/index";
import { call, newSharedAgreement, publicView } from "./helpers";

export interface PrRow {
  id: string;
  milestone_id: string;
  status: string;
  method: string;
  provider_qr_id: string | null;
  provider_transaction_id: string | null;
  provider_bank_account_id: string;
  amount_cents: number;
  num_ref: string;
  idempotency_key: string | null;
  last_reconciled_at: number | null;
  expires_at: number | null;
}

export async function acceptedAgreement(sellerId = "seller_1") {
  const s = await newSharedAgreement(sellerId);
  const view = (await (await publicView(s.token)).json()) as BuyerAgreementView;
  const res = await call(`/api/public/tratos/${s.token}/accept`, {
    method: "POST",
    json: { buyerName: "Ana Pérez", termsSha256: view.agreement.termsSha256, consent: true },
  });
  if (res.status !== 200) throw new Error(`accept failed ${res.status}`);
  const accepted = (await res.json()) as BuyerAgreementView;
  const advance = accepted.milestones.find((m) => m.kind === "ADVANCE")!;
  const balance = accepted.milestones.find((m) => m.kind === "BALANCE")!;
  return { ...s, advanceId: advance.id, balanceId: balance.id, view: accepted };
}

export function createPr(
  token: string,
  milestoneId: string,
  body: Record<string, unknown> = { method: "CODI_QR" },
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(`/api/public/tratos/${token}/milestones/${milestoneId}/payment-requests`, { method: "POST", json: body, headers });
}

export async function refresh(token: string, prId: string): Promise<Response> {
  return call(`/api/public/tratos/${token}/payment-requests/${prId}/refresh`, { method: "POST" });
}

export async function prRow(id: string): Promise<PrRow> {
  const r = await env.DB.prepare("SELECT * FROM payment_requests WHERE id = ?").bind(id).first<PrRow>();
  if (!r) throw new Error("PR not found");
  return r;
}

export async function prCount(milestoneId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE milestone_id = ?").bind(milestoneId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function milestoneStatus(id: string): Promise<string> {
  const r = await env.DB.prepare("SELECT status FROM milestones WHERE id = ?").bind(id).first<{ status: string }>();
  return r?.status ?? "";
}

export async function agreementStatus(id: string): Promise<string> {
  const r = await env.DB.prepare("SELECT status FROM agreements WHERE id = ?").bind(id).first<{ status: string }>();
  return r?.status ?? "";
}

export async function eventCount(agreementId: string, type: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_events WHERE agreement_id = ? AND event_type = ?")
    .bind(agreementId, type)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export const CLABE = "012345678901234567";
let txCounter = 0;
export const newTx = (): string => `01TESTTX${String(++txCounter).padStart(8, "0")}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

export function qrPayload(pr: PrRow, o: { amountMxn?: number; bankAccountId?: string; transactionId?: string; paymentRequestId?: string | null; codiQrId?: string } = {}) {
  const prId = o.paymentRequestId === undefined ? pr.id : o.paymentRequestId;
  return {
    type: "codi.qr.payment_received",
    amount: o.amountMxn ?? pr.amount_cents / 100,
    apiKeyId: "k",
    bankAccountId: o.bankAccountId ?? pr.provider_bank_account_id,
    codiQrId: o.codiQrId ?? pr.provider_qr_id,
    concept: "Trato TR-0001 anticipo",
    datePaid: Date.now(),
    numRef: pr.num_ref,
    transactionId: o.transactionId ?? newTx(),
    metadata: {
      clabe: CLABE,
      bankCode: "40012",
      accountType: "40",
      description: "x",
      trackingKey: "T1",
      externalMetadata: prId === null ? {} : { paymentRequestId: prId, app: "trato" },
    },
  };
}

export function signedHeaders(raw: string, webhookId = `msg_${crypto.randomUUID()}`, secret = env.PEY_WEBHOOK_SECRET): Record<string, string> {
  const ts = new Date();
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(webhookId, ts, raw),
  };
}

export async function postWebhook(payload: unknown, opts: { webhookId?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const raw = JSON.stringify(payload);
  const headers = opts.headers ?? signedHeaders(raw, opts.webhookId);
  return Promise.resolve(
    app.fetch(new Request("http://localhost:8787/api/webhooks/pey", { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } }), env),
  );
}

export async function receiptStatus(webhookId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT processing_status FROM webhook_receipts WHERE webhook_id = ?").bind(webhookId).first<{ processing_status: string }>();
  return r?.processing_status ?? null;
}

export type { PaymentRequestView };
