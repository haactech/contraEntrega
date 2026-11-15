import { describe, expect, it } from "vitest";
import {
  PeyCreatePnRequestSchema,
  PeyCreateQrRequestSchema,
  PeyCreateQrResponseSchema,
  PeyErrorResponseSchema,
  PeyQrTransactionsResponseSchema,
  PeyTransactionSchema,
  PeyWebhookEventSchema,
  buildConcept,
  buildPeyMetadata,
  formatNumRef,
  PeyRegisterBankAccountRequestSchema,
  PeyRegisterBankAccountResponseSchema,
  getExternalMetadata,
  redactPeyWebhookPayload,
} from "../src";

const qrEvent = {
  type: "codi.qr.payment_received",
  amount: 150,
  apiKeyId: "key_1",
  bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q",
  codiQrId: "AB12CD34EF",
  concept: "Trato TR-0007 anticipo",
  datePaid: 1704067260,
  numRef: "0000007",
  transactionId: "01HXYZTXN1234567890ABCDE00",
  metadata: {
    clabe: "000000000000000000",
    bankCode: 40012,
    accountType: 40,
    description: "Trato TR-0007 anticipo",
    trackingKey: "0192191042",
    externalMetadata: { agreementId: "a1", milestoneId: "m1", paymentRequestId: "p1", app: "trato" },
  },
};

describe("webhook schema", () => {
  it("parses QR event with string metadata", () => {
    const r = PeyWebhookEventSchema.parse(qrEvent);
    expect(r.type).toBe("codi.qr.payment_received");
    if (r.type === "codi.qr.payment_received") expect(r.codiQrId).toBe("AB12CD34EF");
    expect(getExternalMetadata(r).paymentRequestId).toBe("p1");
  });
  it("parses PN event without codiQrId and without bankAccountId", () => {
    const { codiQrId: _q, bankAccountId: _b, ...pn } = qrEvent;
    const r = PeyWebhookEventSchema.parse({ ...pn, type: "codi.pn.payment_received", extraField: 1 });
    expect(r.type).toBe("codi.pn.payment_received");
    expect((r as Record<string, unknown>)["extraField"]).toBe(1);
  });
  it("tolerates missing externalMetadata", () => {
    const r = PeyWebhookEventSchema.parse({ ...qrEvent, metadata: { clabe: "1" } });
    expect(getExternalMetadata(r)).toEqual({});
  });
  it("rejects unknown type and non-string external metadata", () => {
    expect(PeyWebhookEventSchema.safeParse({ ...qrEvent, type: "other" }).success).toBe(false);
    expect(
      PeyWebhookEventSchema.safeParse({ ...qrEvent, metadata: { externalMetadata: { a: 1 } } }).success,
    ).toBe(false);
  });
  it("QR event requires codiQrId", () => {
    const { codiQrId: _q, ...rest } = qrEvent;
    expect(PeyWebhookEventSchema.safeParse(rest).success).toBe(false);
  });
});

describe("pey responses", () => {
  it("parses documented examples", () => {
    expect(PeyCreateQrResponseSchema.parse({ id: "AB12CD34EF", qrString: "{\"TYP\":1}", qrImage: null }).id).toBe("AB12CD34EF");
    const tx = PeyTransactionSchema.parse({
      id: "t",
      status: "PAID",
      amount: 102.5,
      amountBreakdown: { base: 100, tip: 0, fee: 2.5 },
      payableType: "API_CODI_PN",
      datePaid: 1704067260,
      metadata: { externalMetadata: { orderId: "1" } },
    });
    expect(tx.amountBreakdown?.base).toBe(100);
    expect(PeyQrTransactionsResponseSchema.parse({ items: [tx], nextToken: null }).items).toHaveLength(1);
    expect(
      PeyErrorResponseSchema.parse({ error: { message: "Missing phoneNumber", type: "INCOMPLETE_PARAMETERS", requestId: "x" } }).error.type,
    ).toBe("INCOMPLETE_PARAMETERS");
  });
  it("validates requests", () => {
    const meta = buildPeyMetadata({ agreementId: "a", milestoneId: "m", paymentRequestId: "p" });
    expect(
      PeyCreateQrRequestSchema.safeParse({ amount: 1.5, concept: "Trato TR-0007 saldo", expiration: 86400, numRef: "0000001", generateImage: false, bankAccountId: "b", metadata: meta }).success,
    ).toBe(true);
    expect(PeyCreateQrRequestSchema.safeParse({ amount: 1, numRef: "12345678" }).success).toBe(false);
    expect(PeyCreatePnRequestSchema.safeParse({ amount: 1, phoneNumber: "5512345678", expiration: 600 }).success).toBe(true);
    expect(PeyCreatePnRequestSchema.safeParse({ amount: 1, phoneNumber: "55", expiration: 600 }).success).toBe(false);
    expect(PeyCreatePnRequestSchema.safeParse({ amount: 1, phoneNumber: "5512345678", expiration: 100 }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("buildPeyMetadata respects limits", () => {
    const m = buildPeyMetadata({ agreementId: "a", milestoneId: "m", paymentRequestId: "p" });
    expect(m).toEqual({ agreementId: "a", milestoneId: "m", paymentRequestId: "p", app: "trato" });
    for (const [k, v] of Object.entries(m)) {
      expect(k.length).toBeLessThanOrEqual(40);
      expect(v.length).toBeLessThanOrEqual(500);
    }
    expect(() => buildPeyMetadata({ agreementId: "x".repeat(501), milestoneId: "m", paymentRequestId: "p" })).toThrow();
    expect(() => buildPeyMetadata({ agreementId: "", milestoneId: "m", paymentRequestId: "p" })).toThrow();
  });
  it("buildConcept", () => {
    expect(buildConcept("TR-0007", "ADVANCE")).toBe("Trato TR-0007 anticipo");
    expect(buildConcept("TR-0007", "BALANCE")).toBe("Trato TR-0007 saldo");
    expect(buildConcept("TR-123456", "ADVANCE").length).toBeLessThanOrEqual(40);
    expect(() => buildConcept("bad code", "BALANCE")).toThrow();
  });
  it("formatNumRef", () => {
    expect(formatNumRef(7)).toBe("0000007");
    expect(() => formatNumRef(10_000_000)).toThrow();
  });
});

describe("bank accounts", () => {
  it("validates register request/response", () => {
    expect(PeyRegisterBankAccountRequestSchema.safeParse({ alias: "a", name: "n", clabe: "012180001234567899", entity: "PERSON" }).success).toBe(true);
    expect(PeyRegisterBankAccountRequestSchema.safeParse({ alias: "a", name: "n", clabe: "123", entity: "PERSON" }).success).toBe(false);
    expect(PeyRegisterBankAccountResponseSchema.parse({ id: "x", codiStatus: "PENDING" }).codiStatus).toBe("PENDING");
  });
  it("parses bank.account.updated and redacts", () => {
    const ev = PeyWebhookEventSchema.parse({
      type: "bank.account.updated", bankAccountId: "b1", codiStatus: "ACTIVE",
      clabe: "012180001234567899", name: "Juan", entity: "PERSON", ownerType: "API_KEY", ownerId: "o", taxId: "XAXX010101000",
    });
    const red = redactPeyWebhookPayload(ev);
    expect(red).toEqual({ type: "bank.account.updated", bankAccountId: "b1", codiStatus: "ACTIVE", entity: "PERSON", ownerType: "API_KEY", ownerId: "o" });
    expect(getExternalMetadata(ev)).toEqual({});
  });
  it("redacts metadata.clabe from payment events", () => {
    const red = redactPeyWebhookPayload(PeyWebhookEventSchema.parse(qrEvent));
    expect(JSON.stringify(red)).not.toContain("000000000000000000");
    expect((red["metadata"] as Record<string, unknown>)["trackingKey"]).toBe("0192191042");
  });
});
