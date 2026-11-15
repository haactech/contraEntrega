import { describe, expect, it } from "vitest";
import {
  API_ROUTES,
  AcceptAgreementRequestSchema,
  CreateAgreementInputSchema,
  CreatePaymentRequestSchema,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  PaymentRequestViewSchema,
  ReviewRequestSchema,
} from "../src";

const valid = {
  title: "Portón de herrería",
  acceptanceCriteria: "Instalado y pintado",
  buyerName: "Ana",
  totalCents: 100_000,
  advanceCents: 30_000,
};

describe("CreateAgreementInputSchema", () => {
  it("accepts valid input", () => {
    expect(CreateAgreementInputSchema.safeParse(valid).success).toBe(true);
    expect(CreateAgreementInputSchema.safeParse({ ...valid, buyerPhone: "5512345678", dueDate: "2026-12-01" }).success).toBe(true);
  });
  it("rejects bad splits and dates", () => {
    expect(CreateAgreementInputSchema.safeParse({ ...valid, advanceCents: 100_000 }).success).toBe(false);
    expect(CreateAgreementInputSchema.safeParse({ ...valid, advanceCents: 0 }).success).toBe(false);
    expect(CreateAgreementInputSchema.safeParse({ ...valid, totalCents: 10.5 }).success).toBe(false);
    expect(CreateAgreementInputSchema.safeParse({ ...valid, dueDate: "2026-02-30" }).success).toBe(false);
    expect(CreateAgreementInputSchema.safeParse({ ...valid, buyerPhone: "123" }).success).toBe(false);
  });
});

describe("public request schemas", () => {
  it("accept requires consent true and sha256", () => {
    const sha = "a".repeat(64);
    expect(AcceptAgreementRequestSchema.safeParse({ buyerName: "Ana", termsSha256: sha, consent: true }).success).toBe(true);
    expect(AcceptAgreementRequestSchema.safeParse({ buyerName: "Ana", termsSha256: sha, consent: false }).success).toBe(false);
    expect(AcceptAgreementRequestSchema.safeParse({ buyerName: "Ana", termsSha256: "x", consent: true }).success).toBe(false);
  });
  it("PN requires phone", () => {
    expect(CreatePaymentRequestSchema.safeParse({ method: "CODI_QR" }).success).toBe(true);
    expect(CreatePaymentRequestSchema.safeParse({ method: "CODI_PN" }).success).toBe(false);
    expect(CreatePaymentRequestSchema.safeParse({ method: "CODI_PN", phoneNumber: "5512345678" }).success).toBe(true);
  });
  it("dispute requires comment 5+", () => {
    expect(ReviewRequestSchema.safeParse({ decision: "APPROVE", buyerName: "Ana" }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ decision: "DISPUTE", buyerName: "Ana" }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ decision: "DISPUTE", buyerName: "Ana", comment: "Roto" }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ decision: "DISPUTE", buyerName: "Ana", comment: "Está roto" }).success).toBe(true);
  });
});

describe("errors and routes", () => {
  it("maps every error code to a status", () => {
    for (const c of ERROR_CODES) expect(ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(ERROR_HTTP_STATUS.TERMS_MISMATCH).toBe(409);
    expect(ERROR_HTTP_STATUS.PROVIDER_ERROR).toBe(502);
  });
  it("parses envelope", () => {
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: "NOT_FOUND", message: "x" } }).success).toBe(true);
  });
  it("builds routes", () => {
    expect(API_ROUTES.publicTrato("abc")).toBe("/api/public/tratos/abc");
    expect(API_ROUTES.publicPaymentRequests("t", "m")).toBe("/api/public/tratos/t/milestones/m/payment-requests");
    expect(API_ROUTES.agreementShare("a/b")).toBe("/api/agreements/a%2Fb/share");
  });
});

describe("PaymentRequestViewSchema", () => {
  it("requires milestoneKind", () => {
    const base = {
      id: "p", milestoneId: "m", method: "CODI_QR", status: "AWAITING_PAYMENT", amountCents: 100,
      numRef: "0000001", qrString: null, phoneLast4: null, expiresAt: null,
      createdAt: "2026-11-14T00:00:00.000Z", paidAt: null,
    };
    expect(PaymentRequestViewSchema.safeParse(base).success).toBe(false);
    expect(PaymentRequestViewSchema.safeParse({ ...base, milestoneKind: "ADVANCE" }).success).toBe(true);
  });
});
