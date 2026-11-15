import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BuyerAgreementView, PaymentRequestView } from "@trato/shared";
import app from "../src/index";
import { setGatewayForTests } from "../src/payments/gateway";
import { call, publicView, seedMock } from "./helpers";
import { FakeGateway } from "./pey-fakes";
import {
  CLABE,
  acceptedAgreement,
  agreementStatus,
  createPr,
  eventCount,
  milestoneStatus,
  newTx,
  postWebhook,
  prCount,
  prRow,
  qrPayload,
  receiptStatus,
  refresh,
  signedHeaders,
} from "./payments-helpers";
import { newSharedAgreement } from "./helpers";

let gw: FakeGateway;
beforeAll(seedMock);
beforeEach(() => {
  gw = new FakeGateway();
  setGatewayForTests(gw);
});
afterEach(() => setGatewayForTests(null));

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe("crear solicitud de pago", () => {
  it("anticipo antes de aceptar -> 409; despues -> 201 con qrString; segundo POST -> 200 misma PR", async () => {
    const s = await newSharedAgreement("seller_2");
    const view = await json<BuyerAgreementView>(await publicView(s.token));
    const advanceId = view.milestones.find((m) => m.kind === "ADVANCE")!.id;
    const early = await createPr(s.token, advanceId);
    expect(early.status).toBe(409);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe("INVALID_STATE");

    const a = await acceptedAgreement("seller_2");
    const r1 = await createPr(a.token, a.advanceId);
    expect(r1.status).toBe(201);
    const v1 = await json<PaymentRequestView>(r1);
    expect(v1.status).toBe("AWAITING_PAYMENT");
    expect(v1.qrString).toContain("FAKEQR");
    expect(v1.milestoneKind).toBe("ADVANCE");
    expect(v1.numRef).toMatch(/^\d{7}$/);
    expect(await milestoneStatus(a.advanceId)).toBe("AWAITING_PAYMENT");
    expect(await eventCount(a.id, "PAYMENT_REQUEST_CREATED")).toBe(1);

    const r2 = await createPr(a.token, a.advanceId);
    expect(r2.status).toBe(200);
    expect((await json<PaymentRequestView>(r2)).id).toBe(v1.id);
    expect(gw.qrCalls).toHaveLength(1);
    expect(await prCount(a.advanceId)).toBe(1);
  });

  it("dos POST concurrentes crean una sola PR", async () => {
    const a = await acceptedAgreement();
    gw.createDelayMs = 50;
    const [r1, r2] = await Promise.all([createPr(a.token, a.advanceId), createPr(a.token, a.advanceId)]);
    expect(await prCount(a.advanceId)).toBe(1);
    expect(gw.qrCalls).toHaveLength(1);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const ids = [(await json<PaymentRequestView>(r1)).id, (await json<PaymentRequestView>(r2)).id];
    expect(ids[0]).toBe(ids[1]);
  });

  it("ignora bankAccountId e importe del navegador: usa los de la DB", async () => {
    const a = await acceptedAgreement("seller_3");
    const res = await createPr(a.token, a.advanceId, { method: "CODI_QR", amountCents: 1, amount: 0.01, bankAccountId: "evil_account" });
    expect(res.status).toBe(201);
    expect(gw.qrCalls[0]?.bankAccountId).toBe("mock_ba_3");
    expect(gw.qrCalls[0]?.amount).toBe(4000);
    expect(gw.qrCalls[0]?.concept).toMatch(/^Trato TR-\d{4} anticipo$/);
    expect(gw.qrCalls[0]?.expiration).toBe(86400);
    expect(gw.qrCalls[0]?.metadata?.["app"]).toBe("trato");
  });

  it("cuenta no ACTIVE -> 409", async () => {
    const a = await acceptedAgreement("seller_4");
    await env.DB.prepare("UPDATE demo_bank_accounts SET codi_status = 'PENDING' WHERE id = 'demo_ba_4'").run();
    try {
      const res = await createPr(a.token, a.advanceId);
      expect(res.status).toBe(409);
      expect((await json<{ error: { message: string } }>(res)).error.message).toContain("no está activa");
      expect(gw.qrCalls).toHaveLength(0);
    } finally {
      await env.DB.prepare("UPDATE demo_bank_accounts SET codi_status = 'ACTIVE' WHERE id = 'demo_ba_4'").run();
    }
  });

  it("PN requiere telefono, guarda solo los ultimos 4 y expira en 600 s", async () => {
    const a = await acceptedAgreement();
    expect((await createPr(a.token, a.advanceId, { method: "CODI_PN" })).status).toBe(400);
    const res = await createPr(a.token, a.advanceId, { method: "CODI_PN", phoneNumber: "5512345678" });
    expect(res.status).toBe(201);
    const v = await json<PaymentRequestView>(res);
    expect(v.phoneLast4).toBe("5678");
    expect(v.qrString).toBeNull();
    expect(JSON.stringify(v)).not.toContain("5512345678");
    expect(gw.pnCalls[0]?.phoneNumber).toBe("5512345678");
    expect(gw.pnCalls[0]?.expiration).toBe(600);
    const row = await prRow(v.id);
    expect(row.provider_transaction_id).toMatch(/^FAKETX/);
  });

  it("Idempotency-Key devuelve la misma PR", async () => {
    const a = await acceptedAgreement();
    const r1 = await createPr(a.token, a.advanceId, { method: "CODI_QR" }, { "Idempotency-Key": "key-123" });
    const r2 = await createPr(a.token, a.advanceId, { method: "CODI_QR" }, { "Idempotency-Key": "key-123" });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((await json<PaymentRequestView>(r2)).id).toBe((await json<PaymentRequestView>(r1)).id);
  });

  it("pey rechaza (4xx) -> FAILED, hito sigue ELIGIBLE, 502; luego se puede reintentar", async () => {
    const a = await acceptedAgreement();
    gw.createQrResult = () => ({ kind: "rejected", status: 400, peyError: { message: "bad", type: "INVALID_PARAMETER" } });
    const res = await createPr(a.token, a.advanceId);
    expect(res.status).toBe(502);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("PROVIDER_ERROR");
    const rows = await env.DB.prepare("SELECT status FROM payment_requests WHERE milestone_id = ?").bind(a.advanceId).all<{ status: string }>();
    expect(rows.results.map((r) => r.status)).toEqual(["FAILED"]);
    expect(await milestoneStatus(a.advanceId)).toBe("ELIGIBLE");
    expect(await eventCount(a.id, "PAYMENT_REQUEST_FAILED")).toBe(1);
    gw.createQrResult = FakeGateway.prototype.createQrResult;
    const retry = new FakeGateway();
    setGatewayForTests(retry);
    expect((await createPr(a.token, a.advanceId)).status).toBe(201);
  });

  it("ambiguo -> CREATION_UNKNOWN; reintento de QR abandona y crea otra", async () => {
    const a = await acceptedAgreement();
    gw.createQrResult = () => ({ kind: "ambiguous", reason: "timeout" });
    const res = await createPr(a.token, a.advanceId);
    expect(res.status).toBe(502);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain("verificando");
    const first = await env.DB.prepare("SELECT id, status FROM payment_requests WHERE milestone_id = ?").bind(a.advanceId).first<{ id: string; status: string }>();
    expect(first?.status).toBe("CREATION_UNKNOWN");
    expect(await milestoneStatus(a.advanceId)).toBe("ELIGIBLE");

    setGatewayForTests(new FakeGateway());
    const retry = await createPr(a.token, a.advanceId);
    expect(retry.status).toBe(201);
    expect((await prRow(first!.id)).status).toBe("ABANDONED");
    expect(await prCount(a.advanceId)).toBe(2);
  });

  it("PN ambiguo reciente -> 409 PAYMENT_PENDING_RECONCILIATION", async () => {
    const a = await acceptedAgreement();
    gw.createPnResult = () => ({ kind: "ambiguous", reason: "network_error" });
    const body = { method: "CODI_PN", phoneNumber: "5512345678" };
    expect((await createPr(a.token, a.advanceId, body)).status).toBe(502);
    const again = await createPr(a.token, a.advanceId, body);
    expect(again.status).toBe(409);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("PAYMENT_PENDING_RECONCILIATION");
    // After the PN window passes, it is abandoned and a new one is allowed.
    await env.DB.prepare("UPDATE payment_requests SET created_at = created_at - 700000 WHERE milestone_id = ?").bind(a.advanceId).run();
    setGatewayForTests(new FakeGateway());
    expect((await createPr(a.token, a.advanceId, body)).status).toBe(201);
  });

  it("las vistas no exponen cuenta bancaria interna, qr id ni telefono completo", async () => {
    const a = await acceptedAgreement();
    await createPr(a.token, a.advanceId, { method: "CODI_QR" });
    const view = await json<BuyerAgreementView>(await publicView(a.token));
    expect(view.activePaymentRequest?.status).toBe("AWAITING_PAYMENT");
    expect(view.paymentRequests).toHaveLength(1);
    const text = JSON.stringify(view);
    expect(text).not.toContain("mock_ba_");
    expect(text).not.toContain("FAKEQR1\"");
    expect(view.nextAction).toBe("PAY_ADVANCE");
  });
});

async function paidAdvance(sellerId = "seller_1") {
  const a = await acceptedAgreement(sellerId);
  const v = await json<PaymentRequestView>(await createPr(a.token, a.advanceId));
  return { ...a, pr: await prRow(v.id) };
}

describe("webhook", () => {
  it("firma invalida -> 401 y nada se guarda", async () => {
    const a = await paidAdvance();
    const raw = JSON.stringify(qrPayload(a.pr));
    const bad = signedHeaders(raw, "msg_bad", "whsec_" + btoa("another-secret-another-secret-123456"));
    const res = await postWebhook(qrPayload(a.pr), { headers: bad });
    expect(res.status).toBe(401);
    expect(await receiptStatus("msg_bad")).toBeNull();
    expect((await prRow(a.pr.id)).status).toBe("AWAITING_PAYMENT");
    // Body tampered after signing.
    const h = signedHeaders(raw);
    const tampered = await app.fetch(
      new Request("http://localhost:8787/api/webhooks/pey", { method: "POST", body: raw.replace("amount", "amounT"), headers: h }),
      env,
    );
    expect(tampered.status).toBe(401);
  });

  it("valido -> PAID + evento + agreement IN_PROGRESS; mismo webhook x3 -> un solo pago", async () => {
    const a = await paidAdvance();
    const payload = qrPayload(a.pr);
    const r1 = await postWebhook(payload, { webhookId: "msg_ok_1" });
    expect(r1.status).toBe(200);
    expect(await receiptStatus("msg_ok_1")).toBe("PROCESSED");
    expect((await prRow(a.pr.id)).status).toBe("PAID");
    expect(await milestoneStatus(a.advanceId)).toBe("PAID");
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);

    for (let i = 0; i < 2; i++) {
      const again = await postWebhook(payload, { webhookId: "msg_ok_1" });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, duplicate: true });
    }
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);

    // The payment event carries the agreed payload shape and no banking data.
    const ev = await env.DB.prepare("SELECT payload_json FROM agreement_events WHERE agreement_id = ? AND event_type = 'PAYMENT_CONFIRMED'").bind(a.id).first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toEqual({ milestoneKind: "ADVANCE", amountCents: 400000, method: "CODI_QR", numRef: a.pr.num_ref });
    const view = await json<BuyerAgreementView>(await publicView(a.token));
    expect(view.nextAction).toBe("WAIT_DELIVERY");
    expect(view.paymentRequests[0]?.status).toBe("PAID");
    expect(view.activePaymentRequest).toBeNull();
  });

  it("mismo transactionId con distinto webhook-id no duplica nada", async () => {
    const a = await paidAdvance();
    const tx = newTx();
    expect((await postWebhook(qrPayload(a.pr, { transactionId: tx }), { webhookId: "msg_tx_a" })).status).toBe(200);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_events WHERE agreement_id = ?").bind(a.id).first<{ n: number }>();
    const r = await postWebhook(qrPayload(a.pr, { transactionId: tx }), { webhookId: "msg_tx_b" });
    expect(r.status).toBe(200);
    expect(await receiptStatus("msg_tx_b")).toBe("DUPLICATE");
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);
    expect(await eventCount(a.id, "DUPLICATE_PAYMENT_DETECTED")).toBe(0);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_events WHERE agreement_id = ?").bind(a.id).first<{ n: number }>();
    expect(after?.n).toBe(events?.n);
  });

  it("importe distinto -> UNMATCHED y nunca PAID", async () => {
    const a = await paidAdvance();
    const r = await postWebhook(qrPayload(a.pr, { amountMxn: 1 }), { webhookId: "msg_amt" });
    expect(r.status).toBe(200);
    expect(await receiptStatus("msg_amt")).toBe("UNMATCHED");
    expect((await prRow(a.pr.id)).status).toBe("AWAITING_PAYMENT");
    expect(await milestoneStatus(a.advanceId)).toBe("AWAITING_PAYMENT");
    expect(await eventCount(a.id, "PAYMENT_UNMATCHED")).toBe(1);
    // The unmatched event is seller-only.
    const buyer = await json<BuyerAgreementView>(await publicView(a.token));
    expect(buyer.events.some((e) => e.type === "PAYMENT_UNMATCHED")).toBe(false);
    const sellerView = await call(`/api/agreements/${a.id}`, { cookie: a.cookie });
    expect((await json<{ events: { type: string }[] }>(sellerView)).events.some((e) => e.type === "PAYMENT_UNMATCHED")).toBe(true);
  });

  it("cuenta distinta -> UNMATCHED", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr, { bankAccountId: "other_account" }), { webhookId: "msg_acct" });
    expect(await receiptStatus("msg_acct")).toBe("UNMATCHED");
    expect((await prRow(a.pr.id)).status).toBe("AWAITING_PAYMENT");
  });

  it("codiQrId distinto -> UNMATCHED", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr, { codiQrId: "OTHERQR" }), { webhookId: "msg_qrid" });
    expect(await receiptStatus("msg_qrid")).toBe("UNMATCHED");
  });

  it("importe = base + fee concilia si getTransaction devuelve la base", async () => {
    const a = await paidAdvance();
    const tx = newTx();
    gw.transaction = (id) => ({
      kind: "ok",
      data: { id, status: "PAID", amount: 4012, amountBreakdown: { base: 4000, fee: 12 } },
    });
    await postWebhook(qrPayload(a.pr, { amountMxn: 4012, transactionId: tx }), { webhookId: "msg_fee" });
    expect(gw.txLookups).toEqual([tx]);
    expect(await receiptStatus("msg_fee")).toBe("PROCESSED");
    expect((await prRow(a.pr.id)).status).toBe("PAID");
  });

  it("importe mayor sin base conciliable -> UNMATCHED", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr, { amountMxn: 4012 }), { webhookId: "msg_fee_bad" });
    expect(await receiptStatus("msg_fee_bad")).toBe("UNMATCHED");
    expect((await prRow(a.pr.id)).status).toBe("AWAITING_PAYMENT");
  });

  it("webhook antes de que exista la PR -> 503 PENDING_RETRY; al reintentar tras existir -> PROCESSED", async () => {
    const a = await acceptedAgreement();
    const futureId = crypto.randomUUID();
    const r = await createPr(a.token, a.advanceId);
    const created = await json<PaymentRequestView>(r);
    const real = await prRow(created.id);
    // Simulate the race: the provider sends a payment tagged with an id we do not know yet.
    const payload = qrPayload(real, { paymentRequestId: futureId });
    const first = await postWebhook(payload, { webhookId: "msg_race" });
    expect(first.status).toBe(503);
    expect(await receiptStatus("msg_race")).toBe("PENDING_RETRY");
    expect((await prRow(real.id)).status).toBe("AWAITING_PAYMENT");
    // The request becomes known under that id; the provider retries the same webhook.
    await env.DB.prepare("UPDATE payment_requests SET id = ? WHERE id = ?").bind(futureId, real.id).run();
    const retry = await postWebhook(payload, { webhookId: "msg_race" });
    expect(retry.status).toBe(200);
    expect(await receiptStatus("msg_race")).toBe("PROCESSED");
    expect((await prRow(futureId)).status).toBe("PAID");
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);
  });

  it("refresh reprocesa recibos PENDING_RETRY que correlacionan con la PR", async () => {
    const a = await acceptedAgreement();
    const created = await json<PaymentRequestView>(await createPr(a.token, a.advanceId));
    const real = await prRow(created.id);
    const futureId = crypto.randomUUID();
    expect((await postWebhook(qrPayload(real, { paymentRequestId: futureId }), { webhookId: "msg_race2" })).status).toBe(503);
    await env.DB.prepare("UPDATE payment_requests SET id = ? WHERE id = ?").bind(futureId, real.id).run();
    const res = await refresh(a.token, futureId);
    expect(res.status).toBe(200);
    expect((await json<PaymentRequestView>(res)).status).toBe("PAID");
    expect(await receiptStatus("msg_race2")).toBe("PROCESSED");
  });

  it("correlaciona por codiQrId cuando no hay paymentRequestId en la metadata", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr, { paymentRequestId: null }), { webhookId: "msg_noext" });
    expect(await receiptStatus("msg_noext")).toBe("PROCESSED");
    expect((await prRow(a.pr.id)).status).toBe("PAID");
  });

  it("recibo guardado sin CLABE; payload desconocido -> IGNORED; body enorme -> 413", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr), { webhookId: "msg_redact" });
    const row = await env.DB.prepare("SELECT payload_redacted_json FROM webhook_receipts WHERE webhook_id = 'msg_redact'").first<{ payload_redacted_json: string }>();
    expect(row!.payload_redacted_json).not.toContain(CLABE);
    expect((await postWebhook({ type: "something.else", clabe: CLABE }, { webhookId: "msg_unknown" })).status).toBe(200);
    expect(await receiptStatus("msg_unknown")).toBe("IGNORED");
    const big = await app.fetch(
      new Request("http://localhost:8787/api/webhooks/pey", { method: "POST", body: "x".repeat(70_000), headers: { "content-length": "70000" } }),
      env,
    );
    expect(big.status).toBe(413);
  });

  it("bank.account.updated actualiza codi_status y no guarda la CLABE", async () => {
    await env.DB.prepare("UPDATE demo_bank_accounts SET codi_status = 'PENDING', verified_at = NULL WHERE id = 'demo_ba_5'").run();
    const res = await postWebhook(
      { type: "bank.account.updated", bankAccountId: "mock_ba_5", codiStatus: "ACTIVE", clabe: CLABE, name: "Titular Secreto", entity: "PERSON", ownerType: "x", ownerId: "y", taxId: "XAXX010101000" },
      { webhookId: "msg_bank" },
    );
    expect(res.status).toBe(200);
    const acc = await env.DB.prepare("SELECT codi_status, verified_at FROM demo_bank_accounts WHERE id = 'demo_ba_5'").first<{ codi_status: string; verified_at: number | null }>();
    expect(acc?.codi_status).toBe("ACTIVE");
    expect(acc?.verified_at).not.toBeNull();
    const row = await env.DB.prepare("SELECT payload_redacted_json, processing_status FROM webhook_receipts WHERE webhook_id = 'msg_bank'").first<{ payload_redacted_json: string; processing_status: string }>();
    expect(row?.processing_status).toBe("PROCESSED");
    for (const secret of [CLABE, "Titular Secreto", "XAXX010101000"]) expect(row!.payload_redacted_json).not.toContain(secret);
  });
});

describe("refresh y expiracion", () => {
  it("refresh con gateway que reporta PAID -> PAID con la misma logica; throttle de 10 s", async () => {
    const a = await paidAdvance();
    const first = await refresh(a.token, a.pr.id);
    expect((await json<PaymentRequestView>(first)).status).toBe("AWAITING_PAYMENT");
    expect(gw.qrLookups).toHaveLength(1);
    // Within 10 s: no provider call, current state returned.
    gw.qrTransactions = () => ({
      kind: "ok",
      data: { items: [{ id: newTx(), status: "PAID", amount: 4000, datePaid: Date.now(), metadata: { externalMetadata: { paymentRequestId: a.pr.id } } }], nextToken: null },
    });
    const throttled = await refresh(a.token, a.pr.id);
    expect((await json<PaymentRequestView>(throttled)).status).toBe("AWAITING_PAYMENT");
    expect(gw.qrLookups).toHaveLength(1);
    // After the window it queries again and confirms.
    await env.DB.prepare("UPDATE payment_requests SET last_reconciled_at = last_reconciled_at - 11000 WHERE id = ?").bind(a.pr.id).run();
    const paid = await refresh(a.token, a.pr.id);
    expect((await json<PaymentRequestView>(paid)).status).toBe("PAID");
    expect(gw.qrLookups).toHaveLength(2);
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);
  });

  it("refresh con importe distinto en pey -> sigue AWAITING (UNMATCHED)", async () => {
    const a = await paidAdvance();
    gw.qrTransactions = () => ({ kind: "ok", data: { items: [{ id: newTx(), status: "PAID", amount: 1, datePaid: Date.now() }], nextToken: null } });
    const res = await refresh(a.token, a.pr.id);
    expect((await json<PaymentRequestView>(res)).status).toBe("AWAITING_PAYMENT");
  });

  it("refresh de una PR de otro trato -> 404", async () => {
    const a = await paidAdvance();
    const b = await acceptedAgreement();
    expect((await refresh(b.token, a.pr.id)).status).toBe(404);
  });

  it("expiracion local -> EXPIRED_LOCAL y el hito vuelve a elegible; pago tardio -> PAID", async () => {
    const a = await paidAdvance();
    await env.DB.prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, a.pr.id).run();
    const view = await json<BuyerAgreementView>(await publicView(a.token));
    expect(view.paymentRequests[0]?.status).toBe("EXPIRED_LOCAL");
    expect(view.milestones.find((m) => m.kind === "ADVANCE")?.status).toBe("ELIGIBLE");
    expect(view.activePaymentRequest).toBeNull();
    expect(await eventCount(a.id, "PAYMENT_REQUEST_EXPIRED")).toBe(1);
    // Idempotent: a second read does not emit another event.
    await publicView(a.token);
    expect(await eventCount(a.id, "PAYMENT_REQUEST_EXPIRED")).toBe(1);

    const late = await postWebhook(qrPayload(a.pr), { webhookId: "msg_late" });
    expect(late.status).toBe(200);
    expect(await receiptStatus("msg_late")).toBe("PROCESSED");
    expect((await prRow(a.pr.id)).status).toBe("PAID");
    expect(await milestoneStatus(a.advanceId)).toBe("PAID");
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");
  });

  it("refresh expira una PR vencida sin pago", async () => {
    const a = await paidAdvance();
    await env.DB.prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, a.pr.id).run();
    const res = await refresh(a.token, a.pr.id);
    expect((await json<PaymentRequestView>(res)).status).toBe("EXPIRED_LOCAL");
    expect(await milestoneStatus(a.advanceId)).toBe("ELIGIBLE");
  });

  it("crear tras vencer: la vencida pasa a EXPIRED_LOCAL y se emite una nueva", async () => {
    const a = await paidAdvance();
    await env.DB.prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, a.pr.id).run();
    const res = await createPr(a.token, a.advanceId);
    expect(res.status).toBe(201);
    expect((await json<PaymentRequestView>(res)).id).not.toBe(a.pr.id);
    expect((await prRow(a.pr.id)).status).toBe("EXPIRED_LOCAL");
    expect(gw.qrLookups).toEqual([a.pr.provider_qr_id]);
  });

  it("pago duplicado de otra PR sobre un hito ya pagado -> DUPLICATE_PAYMENT_DETECTED", async () => {
    const a = await paidAdvance();
    await postWebhook(qrPayload(a.pr), { webhookId: "msg_first" });
    // An old request (expired earlier) receives money after the milestone was paid.
    const oldId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO payment_requests (id, milestone_id, method, provider, provider_qr_id, provider_bank_account_id, amount_cents, num_ref, status, created_at)
       VALUES (?, ?, 'CODI_QR', 'PEY', 'OLDQR', ?, ?, '0000999', 'EXPIRED_LOCAL', 1)`,
    )
      .bind(oldId, a.advanceId, a.pr.provider_bank_account_id, a.pr.amount_cents)
      .run();
    const old = await prRow(oldId);
    const tx = newTx();
    await postWebhook(qrPayload(old, { transactionId: tx }), { webhookId: "msg_dup1" });
    expect(await receiptStatus("msg_dup1")).toBe("DUPLICATE");
    expect(await eventCount(a.id, "DUPLICATE_PAYMENT_DETECTED")).toBe(1);
    await postWebhook(qrPayload(old, { transactionId: tx }), { webhookId: "msg_dup2" });
    expect(await eventCount(a.id, "DUPLICATE_PAYMENT_DETECTED")).toBe(1);
    expect(await eventCount(a.id, "PAYMENT_CONFIRMED")).toBe(1);
    expect((await prRow(oldId)).status).toBe("EXPIRED_LOCAL");
  });
});

describe("saldo", () => {
  it("BALANCE READY_TO_CHARGE -> QR con misma cuenta y distinta PR -> webhook -> COMPLETED", async () => {
    const a = await paidAdvance("seller_5");
    await postWebhook(qrPayload(a.pr), { webhookId: "msg_adv" });
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");

    // Review is stage 2c: put the balance in the approved state directly.
    expect((await createPr(a.token, a.balanceId)).status).toBe(409);
    await env.DB.prepare("UPDATE milestones SET status = 'READY_TO_CHARGE' WHERE id = ?").bind(a.balanceId).run();
    const res = await createPr(a.token, a.balanceId);
    expect(res.status).toBe(201);
    const v = await json<PaymentRequestView>(res);
    expect(v.milestoneKind).toBe("BALANCE");
    expect(v.amountCents).toBe(600000);
    expect(v.id).not.toBe(a.pr.id);
    expect(gw.qrCalls[1]?.bankAccountId).toBe(gw.qrCalls[0]?.bankAccountId);
    expect(gw.qrCalls[1]?.concept).toMatch(/saldo$/);

    const bal = await prRow(v.id);
    expect((await postWebhook(qrPayload(bal), { webhookId: "msg_bal" })).status).toBe(200);
    expect(await receiptStatus("msg_bal")).toBe("PROCESSED");
    expect(await milestoneStatus(a.balanceId)).toBe("PAID");
    expect(await agreementStatus(a.id)).toBe("COMPLETED");
    expect(await eventCount(a.id, "AGREEMENT_COMPLETED")).toBe(1);
    const done = await json<BuyerAgreementView>(await publicView(a.token));
    expect(done.nextAction).toBe("DONE");
    expect(done.agreement.completedAt).not.toBeNull();
  });

  it("saldo con disputa no se puede cobrar", async () => {
    const a = await paidAdvance("seller_5");
    await postWebhook(qrPayload(a.pr), { webhookId: "msg_adv2" });
    await env.DB.prepare("UPDATE milestones SET status = 'DISPUTED' WHERE id = ?").bind(a.balanceId).run();
    expect((await createPr(a.token, a.balanceId)).status).toBe(409);
  });
});

describe("simulate-payment", () => {
  it("en modo live -> 404", async () => {
    const a = await paidAdvance();
    const req = new Request("http://localhost:8787/api/dev/simulate-payment", {
      method: "POST",
      body: JSON.stringify({ paymentRequestId: a.pr.id }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.fetch(req, { ...env, PAYMENTS_MODE: "live" });
    expect(res.status).toBe(404);
    expect((await prRow(a.pr.id)).status).toBe("AWAITING_PAYMENT");
  });

  it("en modo mock -> PAID por el pipeline real del webhook", async () => {
    setGatewayForTests(null); // real MockPeyGateway
    const a = await acceptedAgreement();
    const created = await json<PaymentRequestView>(await createPr(a.token, a.advanceId));
    expect(created.qrString).toContain("IDC");
    const res = await call("/api/dev/simulate-payment", { method: "POST", json: { paymentRequestId: created.id } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processingStatus: "PROCESSED" });
    expect((await prRow(created.id)).status).toBe("PAID");
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");
    const receipts = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_receipts WHERE payment_request_id = ?").bind(created.id).first<{ n: number }>();
    expect(receipts?.n).toBe(1);
  });

  it("push (CODI_PN) en modo mock -> PAID con el transactionId emitido al crear la solicitud", async () => {
    setGatewayForTests(null); // real MockPeyGateway
    const a = await acceptedAgreement();
    const created = await json<PaymentRequestView>(await createPr(a.token, a.advanceId, { method: "CODI_PN", phoneNumber: "5512345678" }));
    const txBefore = (await prRow(created.id)).provider_transaction_id;
    expect(txBefore).toBeTruthy();
    const res = await call("/api/dev/simulate-payment", { method: "POST", json: { paymentRequestId: created.id } });
    expect(await res.json()).toEqual({ ok: true, processingStatus: "PROCESSED" });
    const row = await prRow(created.id);
    expect(row.status).toBe("PAID");
    expect(row.provider_transaction_id).toBe(txBefore);
    expect(await agreementStatus(a.id)).toBe("IN_PROGRESS");
  });

  it("PR inexistente -> 404", async () => {
    const res = await call("/api/dev/simulate-payment", { method: "POST", json: { paymentRequestId: "nope" } });
    expect(res.status).toBe(404);
  });
});
