import { describe, expect, it } from "vitest";
import {
  canAccept,
  canAddEvidence,
  canConfirmPayment,
  canCreatePaymentRequest,
  canRequestReview,
  canReview,
  canShare,
  computeBuyerNextAction,
  computeSellerNextAction,
  evidenceRoundFor,
  onAccepted,
  onPaymentConfirmed,
  onPaymentRequestCreated,
  onPaymentRequestExpiredOrFailed,
  onReviewRequested,
  onReviewed,
  type AgreementSnapshot,
  type MilestoneSnapshot,
  type PaymentRequestSnapshot,
  type PayeeAccountSnapshot,
} from "../src";
import type { AgreementStatus, MilestoneStatus } from "../src";

const NOW = 1_800_000_000_000;
const active: PayeeAccountSnapshot = { codiStatus: "ACTIVE", enabled: true };
const ag = (status: AgreementStatus): AgreementSnapshot => ({ status });
const adv = (status: MilestoneStatus): MilestoneSnapshot => ({ kind: "ADVANCE", status, deliveryRound: 0 });
const bal = (status: MilestoneStatus, deliveryRound = 0): MilestoneSnapshot => ({ kind: "BALANCE", status, deliveryRound });
const pr = (status: PaymentRequestSnapshot["status"], expiresAtMs: number | null = NOW + 60_000): PaymentRequestSnapshot => ({ id: "pr1", status, expiresAtMs });

describe("simple guards", () => {
  it("canShare / canAccept", () => {
    expect(canShare(ag("DRAFT")).ok).toBe(true);
    expect(canShare(ag("COMPLETED")).ok).toBe(false);
    expect(canAccept(ag("SHARED")).ok).toBe(true);
    const r = canAccept(ag("ACCEPTED"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_STATE");
    expect(canAccept(ag("DRAFT")).ok).toBe(false);
  });
});

describe("invariant 1: no advance charge before acceptance", () => {
  it("rejects PENDING_ACCEPTANCE", () => {
    const r = canCreatePaymentRequest(adv("PENDING_ACCEPTANCE"), ag("SHARED"), null, NOW, active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/acepte/);
  });
  it("allows after acceptance", () => {
    expect(canCreatePaymentRequest(adv("ELIGIBLE"), ag("ACCEPTED"), null, NOW, active).ok).toBe(true);
  });
});

describe("invariant 2: balance only after approval, never while disputed", () => {
  it.each(["WAITING_DELIVERY", "WAITING_BUYER_REVIEW"] as const)("rejects %s", (s) => {
    expect(canCreatePaymentRequest(bal(s), ag("IN_PROGRESS"), null, NOW, active).ok).toBe(false);
  });
  it("rejects DISPUTED", () => {
    const r = canCreatePaymentRequest(bal("DISPUTED"), ag("DISPUTED"), null, NOW, active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/disputa/);
  });
  it("allows READY_TO_CHARGE", () => {
    expect(canCreatePaymentRequest(bal("READY_TO_CHARGE"), ag("IN_PROGRESS"), null, NOW, active).ok).toBe(true);
  });
  it("rejects already PAID", () => {
    expect(canCreatePaymentRequest(bal("PAID"), ag("COMPLETED"), null, NOW, active).ok).toBe(false);
  });
});

describe("payee account must be ACTIVE", () => {
  it.each(["PENDING", "PROCESSING", "ERROR"] as const)("rejects %s", (codiStatus) => {
    const r = canCreatePaymentRequest(adv("ELIGIBLE"), ag("ACCEPTED"), null, NOW, { codiStatus, enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INVALID_STATE");
      expect(r.message).toBe("La cuenta del prestador aún no está activa en CoDi");
    }
  });
  it("rejects disabled", () => {
    expect(canCreatePaymentRequest(adv("ELIGIBLE"), ag("ACCEPTED"), null, NOW, { codiStatus: "ACTIVE", enabled: false }).ok).toBe(false);
  });
});

describe("invariant 10: one active request per milestone", () => {
  it("reports reuse of a valid AWAITING_PAYMENT request", () => {
    const r = canCreatePaymentRequest(adv("AWAITING_PAYMENT"), ag("ACCEPTED"), pr("AWAITING_PAYMENT"), NOW, active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { reusePaymentRequestId?: string }).reusePaymentRequestId).toBe("pr1");
  });
  it("asks to reconcile expired or unknown requests", () => {
    for (const p of [pr("AWAITING_PAYMENT", NOW - 1), pr("CREATION_UNKNOWN", null)]) {
      const r = canCreatePaymentRequest(adv("AWAITING_PAYMENT"), ag("ACCEPTED"), p, NOW, active);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("PAYMENT_PENDING_RECONCILIATION");
        expect((r as { reconcilePaymentRequestId?: string }).reconcilePaymentRequestId).toBe("pr1");
      }
    }
  });
  it("rejects while CREATING", () => {
    const r = canCreatePaymentRequest(adv("ELIGIBLE"), ag("ACCEPTED"), pr("CREATING", null), NOW, active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PAYMENT_PENDING_RECONCILIATION");
  });
});

describe("payment request lifecycle transitions", () => {
  it("created -> AWAITING_PAYMENT only from eligible", () => {
    expect(onPaymentRequestCreated(adv("ELIGIBLE"))).toMatchObject({ ok: true, milestoneStatus: "AWAITING_PAYMENT" });
    expect(onPaymentRequestCreated(bal("READY_TO_CHARGE"))).toMatchObject({ ok: true });
    expect(onPaymentRequestCreated(adv("PENDING_ACCEPTANCE")).ok).toBe(false);
    expect(onPaymentRequestCreated(bal("WAITING_BUYER_REVIEW")).ok).toBe(false);
  });
  it("expired/failed returns to eligible state", () => {
    expect(onPaymentRequestExpiredOrFailed(adv("AWAITING_PAYMENT")).milestoneStatus).toBe("ELIGIBLE");
    expect(onPaymentRequestExpiredOrFailed(bal("AWAITING_PAYMENT")).milestoneStatus).toBe("READY_TO_CHARGE");
    expect(onPaymentRequestExpiredOrFailed(adv("PAID")).milestoneStatus).toBe("PAID");
  });
});

describe("payment confirmation (invariants 5 and 6)", () => {
  it("advance paid -> IN_PROGRESS", () => {
    expect(onPaymentConfirmed(adv("AWAITING_PAYMENT"), ag("ACCEPTED"))).toEqual({
      ok: true, duplicate: false, milestoneStatus: "PAID", agreementStatus: "IN_PROGRESS", agreementCompleted: false,
    });
  });
  it("balance paid -> COMPLETED", () => {
    expect(onPaymentConfirmed(bal("AWAITING_PAYMENT"), ag("IN_PROGRESS"))).toMatchObject({
      duplicate: false, milestoneStatus: "PAID", agreementStatus: "COMPLETED", agreementCompleted: true,
    });
  });
  it("late payment on expired request still credits", () => {
    expect(canConfirmPayment(pr("EXPIRED_LOCAL"), bal("READY_TO_CHARGE")).ok).toBe(true);
    expect(canConfirmPayment(pr("CREATION_UNKNOWN", null), adv("ELIGIBLE")).ok).toBe(true);
  });
  it("confirming twice is a duplicate with no state change", () => {
    const first = onPaymentConfirmed(bal("AWAITING_PAYMENT"), ag("IN_PROGRESS"));
    expect(first).toMatchObject({ duplicate: false });
    const second = onPaymentConfirmed(bal("PAID"), ag("COMPLETED"));
    expect(second).toEqual({ ok: true, duplicate: true, milestoneStatus: "PAID", agreementStatus: "COMPLETED", agreementCompleted: false });
    expect(canConfirmPayment(pr("PAID", null), bal("PAID")).ok).toBe(true);
  });
  it("rejects non-confirmable states", () => {
    expect(canConfirmPayment(pr("FAILED", null), adv("ELIGIBLE")).ok).toBe(false);
    expect(canConfirmPayment(pr("AWAITING_PAYMENT"), adv("PENDING_ACCEPTANCE")).ok).toBe(false);
    expect(canConfirmPayment(pr("AWAITING_PAYMENT"), bal("WAITING_BUYER_REVIEW")).ok).toBe(false);
    expect(onPaymentConfirmed(bal("DISPUTED"), ag("DISPUTED")).ok).toBe(false);
  });
  it("payment does not touch approval fields", () => {
    const r = onPaymentConfirmed(bal("AWAITING_PAYMENT"), ag("IN_PROGRESS"));
    expect(Object.keys(r)).not.toContain("approved");
  });
});

describe("evidence, review request, review", () => {
  it("evidence only after advance paid and while delivering", () => {
    expect(canAddEvidence(ag("ACCEPTED"), bal("WAITING_DELIVERY"), 0).ok).toBe(false);
    expect(canAddEvidence(ag("IN_PROGRESS"), bal("WAITING_DELIVERY"), 0).ok).toBe(true);
    expect(canAddEvidence(ag("IN_PROGRESS"), bal("WAITING_DELIVERY"), 3).ok).toBe(false);
    expect(canAddEvidence(ag("IN_PROGRESS"), bal("WAITING_BUYER_REVIEW"), 1).ok).toBe(false);
    expect(canAddEvidence(ag("DISPUTED"), bal("DISPUTED"), 0).ok).toBe(true);
    expect(canAddEvidence(ag("COMPLETED"), bal("PAID"), 0).ok).toBe(false);
  });
  it("request review needs at least one new photo", () => {
    expect(canRequestReview(ag("IN_PROGRESS"), bal("WAITING_DELIVERY"), 0).ok).toBe(false);
    expect(canRequestReview(ag("IN_PROGRESS"), bal("WAITING_DELIVERY"), 1).ok).toBe(true);
    expect(canRequestReview(ag("ACCEPTED"), bal("WAITING_DELIVERY"), 1).ok).toBe(false);
  });
  it("canReview only while waiting for buyer", () => {
    expect(canReview(ag("IN_PROGRESS"), bal("WAITING_BUYER_REVIEW")).ok).toBe(true);
    expect(canReview(ag("IN_PROGRESS"), bal("WAITING_DELIVERY")).ok).toBe(false);
    expect(canReview(ag("IN_PROGRESS"), bal("READY_TO_CHARGE")).ok).toBe(false);
    expect(canReview(ag("DISPUTED"), bal("DISPUTED")).ok).toBe(false);
  });
  it("approve does not mark PAID, only READY_TO_CHARGE", () => {
    const r = onReviewed("APPROVE", ag("IN_PROGRESS"), bal("WAITING_BUYER_REVIEW"));
    expect(r).toMatchObject({ ok: true, balanceStatus: "READY_TO_CHARGE", agreementStatus: "IN_PROGRESS", approved: true, eventType: "DELIVERY_APPROVED" });
    if (r.ok) expect(r.balanceStatus).not.toBe("PAID");
  });
  it("dispute blocks charge", () => {
    const r = onReviewed("DISPUTE", ag("IN_PROGRESS"), bal("WAITING_BUYER_REVIEW"));
    expect(r).toMatchObject({ ok: true, balanceStatus: "DISPUTED", agreementStatus: "DISPUTED", approved: false, eventType: "DELIVERY_DISPUTED" });
    expect(onReviewed("APPROVE", ag("IN_PROGRESS"), bal("WAITING_DELIVERY")).ok).toBe(false);
  });
  it("first review request keeps round; redelivery after dispute increments", () => {
    expect(onReviewRequested(ag("IN_PROGRESS"), bal("WAITING_DELIVERY", 0), 2)).toMatchObject({
      ok: true, balanceStatus: "WAITING_BUYER_REVIEW", agreementStatus: "IN_PROGRESS", deliveryRound: 0, redelivery: false,
    });
    expect(onReviewRequested(ag("DISPUTED"), bal("DISPUTED", 0), 1)).toMatchObject({
      ok: true, balanceStatus: "WAITING_BUYER_REVIEW", agreementStatus: "IN_PROGRESS", deliveryRound: 1, redelivery: true,
    });
    expect(onReviewRequested(ag("DISPUTED"), bal("DISPUTED", 1), 1)).toMatchObject({ deliveryRound: 2 });
    expect(onReviewRequested(ag("DISPUTED"), bal("DISPUTED", 0), 0).ok).toBe(false);
  });
  it("evidenceRoundFor", () => {
    expect(evidenceRoundFor(bal("WAITING_DELIVERY", 0))).toBe(0);
    expect(evidenceRoundFor(bal("DISPUTED", 0))).toBe(1);
  });
  it("after redelivery the balance can be approved and charged", () => {
    const disputed = onReviewed("DISPUTE", ag("IN_PROGRESS"), bal("WAITING_BUYER_REVIEW", 0));
    expect(disputed.ok).toBe(true);
    const re = onReviewRequested(ag("DISPUTED"), bal("DISPUTED", 0), 1);
    if (!re.ok) throw new Error("expected ok");
    const approved = onReviewed("APPROVE", ag(re.agreementStatus), bal(re.balanceStatus, re.deliveryRound));
    expect(approved).toMatchObject({ ok: true, balanceStatus: "READY_TO_CHARGE" });
  });
});

describe("onAccepted", () => {
  it("makes advance eligible", () => {
    expect(onAccepted(ag("SHARED"))).toEqual({ ok: true, agreementStatus: "ACCEPTED", advanceStatus: "ELIGIBLE" });
    expect(onAccepted(ag("ACCEPTED")).ok).toBe(false);
  });
});

describe("next actions: happy path", () => {
  const steps: Array<[AgreementStatus, MilestoneStatus, MilestoneStatus, string, string]> = [
    ["DRAFT", "PENDING_ACCEPTANCE", "WAITING_DELIVERY", "SHARE", "WAIT_SELLER"],
    ["SHARED", "PENDING_ACCEPTANCE", "WAITING_DELIVERY", "WAIT_ACCEPTANCE", "ACCEPT"],
    ["ACCEPTED", "ELIGIBLE", "WAITING_DELIVERY", "WAIT_ADVANCE", "PAY_ADVANCE"],
    ["ACCEPTED", "AWAITING_PAYMENT", "WAITING_DELIVERY", "WAIT_ADVANCE", "PAY_ADVANCE"],
    ["IN_PROGRESS", "PAID", "WAITING_DELIVERY", "UPLOAD_EVIDENCE", "WAIT_DELIVERY"],
    ["IN_PROGRESS", "PAID", "WAITING_BUYER_REVIEW", "WAIT_REVIEW", "REVIEW"],
    ["IN_PROGRESS", "PAID", "READY_TO_CHARGE", "WAIT_BALANCE", "PAY_BALANCE"],
    ["IN_PROGRESS", "PAID", "AWAITING_PAYMENT", "WAIT_BALANCE", "PAY_BALANCE"],
    ["COMPLETED", "PAID", "PAID", "DONE", "DONE"],
  ];
  it.each(steps)("%s / %s / %s", (agreementStatus, advanceStatus, balanceStatus, seller, buyer) => {
    const s = { agreementStatus, advanceStatus, balanceStatus };
    expect(computeSellerNextAction(s)).toBe(seller);
    expect(computeBuyerNextAction(s)).toBe(buyer);
  });
});

describe("next actions: negative path", () => {
  it("dispute", () => {
    const s = { agreementStatus: "DISPUTED" as const, advanceStatus: "PAID" as const, balanceStatus: "DISPUTED" as const };
    expect(computeSellerNextAction(s)).toBe("RESOLVE_DISPUTE");
    expect(computeBuyerNextAction(s)).toBe("WAIT_SELLER");
  });
  it("back to review after redelivery", () => {
    const s = { agreementStatus: "IN_PROGRESS" as const, advanceStatus: "PAID" as const, balanceStatus: "WAITING_BUYER_REVIEW" as const };
    expect(computeSellerNextAction(s)).toBe("WAIT_REVIEW");
    expect(computeBuyerNextAction(s)).toBe("REVIEW");
  });
});
