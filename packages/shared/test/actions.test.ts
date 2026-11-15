import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTIONS,
  ALLOWED_ACTION_LABELS,
  AGREEMENT_STATUSES,
  MILESTONE_STATUSES,
  allowedActions,
  noAgreementActionState,
  onAccepted,
  onPaymentRequestCreated,
  onReviewRequested,
  onReviewed,
  type ActionState,
  type AgreementStatus,
  type MilestoneStatus,
  type PaymentRequestSnapshot,
} from "../src";

const NOW = 1_800_000_000_000;
const noPr = { advance: null, balance: null };

function st(
  agreement: AgreementStatus,
  advance: MilestoneStatus,
  balance: MilestoneStatus,
  extra: Partial<ActionState> = {},
  round = 0,
): ActionState {
  return {
    agreement: { status: agreement },
    advance: { kind: "ADVANCE", status: advance, deliveryRound: 0 },
    balance: { kind: "BALANCE", status: balance, deliveryRound: round },
    activePaymentRequests: noPr,
    unsubmittedEvidenceCount: 0,
    hasOpenProposal: false,
    nowMs: NOW,
    account: { codiStatus: "ACTIVE", enabled: true },
    ...extra,
  };
}
const pr = (status: PaymentRequestSnapshot["status"], expiresAtMs: number | null = NOW + 60_000): PaymentRequestSnapshot => ({
  id: "pr1",
  status,
  expiresAtMs,
});
const S = (s: ActionState) => allowedActions(s, "SELLER");
const B = (s: ActionState) => allowedActions(s, "BUYER");

describe("allowedActions", () => {
  it("has a Spanish label for every action", () => {
    for (const a of ALLOWED_ACTIONS) expect(ALLOWED_ACTION_LABELS[a].length).toBeGreaterThan(2);
  });

  it("no agreement yet: seller confirms an open proposal, buyer has nothing", () => {
    expect(S(noAgreementActionState(true, NOW))).toEqual(["CONFIRM_PROPOSAL"]);
    expect(S(noAgreementActionState(false, NOW))).toEqual([]);
    expect(B(noAgreementActionState(true, NOW))).toEqual([]);
  });

  it("DRAFT: seller shares, buyer cannot do anything", () => {
    const s = st("DRAFT", "PENDING_ACCEPTANCE", "PENDING_ACCEPTANCE");
    expect(S(s)).toEqual(["SHARE_LINK", "EXPORT"]);
    expect(B(s)).toEqual([]);
  });

  it("SHARED: buyer accepts; seller may re-share or confirm a revision", () => {
    const s = st("SHARED", "PENDING_ACCEPTANCE", "PENDING_ACCEPTANCE");
    expect(B(s)).toEqual(["ACCEPT_TERMS", "EXPORT"]);
    expect(S(s)).toEqual(["SHARE_LINK", "EXPORT"]);
    expect(S({ ...s, hasOpenProposal: true })).toEqual(["CONFIRM_PROPOSAL", "SHARE_LINK", "EXPORT"]);
  });

  it("ACCEPTED: terms are immutable (no CONFIRM_PROPOSAL); buyer pays advance", () => {
    const s = st("ACCEPTED", "ELIGIBLE", "WAITING_DELIVERY", { hasOpenProposal: true });
    expect(S(s)).toEqual(["EXPORT"]);
    expect(B(s)).toEqual(["PAY_ADVANCE", "EXPORT"]);
  });

  it("advance payment pending: buyer may reopen the valid request and refresh it", () => {
    const s = st("ACCEPTED", "AWAITING_PAYMENT", "WAITING_DELIVERY", {
      activePaymentRequests: { advance: pr("AWAITING_PAYMENT"), balance: null },
    });
    expect(B(s)).toEqual(["PAY_ADVANCE", "REFRESH_PAYMENT", "EXPORT"]);
  });

  it("expired local request while reconciling: refresh only", () => {
    const s = st("ACCEPTED", "AWAITING_PAYMENT", "WAITING_DELIVERY", {
      activePaymentRequests: { advance: pr("CREATION_UNKNOWN", null), balance: null },
    });
    // CREATION_UNKNOWN requires reconciliation before creating another
    expect(B(s)).toEqual(["REFRESH_PAYMENT", "EXPORT"]);
  });

  it("payee account not active: buyer cannot pay", () => {
    const s = st("ACCEPTED", "ELIGIBLE", "WAITING_DELIVERY", { account: { codiStatus: "PENDING", enabled: true } });
    expect(B(s)).toEqual(["EXPORT"]);
  });

  it("IN_PROGRESS waiting delivery: seller uploads, requests review only with evidence", () => {
    const s = st("IN_PROGRESS", "PAID", "WAITING_DELIVERY");
    expect(S(s)).toEqual(["UPLOAD_EVIDENCE", "EXPORT"]);
    expect(S({ ...s, unsubmittedEvidenceCount: 1 })).toEqual(["UPLOAD_EVIDENCE", "REQUEST_REVIEW", "EXPORT"]);
    expect(S({ ...s, unsubmittedEvidenceCount: 3 })).toEqual(["REQUEST_REVIEW", "EXPORT"]); // max 3 per round
    expect(B(s)).toEqual(["EXPORT"]);
  });

  it("WAITING_BUYER_REVIEW: buyer approves or disputes; seller waits", () => {
    const s = st("IN_PROGRESS", "PAID", "WAITING_BUYER_REVIEW");
    expect(B(s)).toEqual(["APPROVE_DELIVERY", "DISPUTE_DELIVERY", "EXPORT"]);
    expect(S(s)).toEqual(["EXPORT"]);
  });

  it("READY_TO_CHARGE: buyer pays balance", () => {
    const s = st("IN_PROGRESS", "PAID", "READY_TO_CHARGE");
    expect(B(s)).toEqual(["PAY_BALANCE", "EXPORT"]);
    const pending = st("IN_PROGRESS", "PAID", "AWAITING_PAYMENT", {
      activePaymentRequests: { advance: null, balance: pr("AWAITING_PAYMENT") },
    });
    expect(B(pending)).toEqual(["PAY_BALANCE", "REFRESH_PAYMENT", "EXPORT"]);
  });

  it("DISPUTED: no payment; seller re-delivers only after uploading new evidence", () => {
    const s = st("DISPUTED", "PAID", "DISPUTED", {}, 0);
    expect(B(s)).toEqual(["EXPORT"]);
    expect(S(s)).toEqual(["UPLOAD_EVIDENCE", "EXPORT"]);
    expect(S({ ...s, unsubmittedEvidenceCount: 1 })).toEqual(["UPLOAD_EVIDENCE", "REDELIVER", "EXPORT"]);
  });

  it("COMPLETED: only export", () => {
    const s = st("COMPLETED", "PAID", "PAID");
    expect(S(s)).toEqual(["EXPORT"]);
    expect(B(s)).toEqual(["EXPORT"]);
  });

  it("never lists an action its guard would reject (exhaustive over statuses)", () => {
    for (const a of AGREEMENT_STATUSES) {
      for (const adv of MILESTONE_STATUSES) {
        for (const bal of MILESTONE_STATUSES) {
          for (const ev of [0, 1, 3]) {
            for (const withPr of [false, true]) {
              const s = st(a, adv, bal, {
                unsubmittedEvidenceCount: ev,
                activePaymentRequests: {
                  advance: withPr ? pr("AWAITING_PAYMENT") : null,
                  balance: withPr ? pr("AWAITING_PAYMENT") : null,
                },
              });
              const sellerA = S(s);
              const buyerA = B(s);
              const ag = s.agreement!;
              const b = s.balance!;
              if (buyerA.includes("ACCEPT_TERMS")) expect(onAccepted(ag).ok).toBe(true);
              if (buyerA.includes("APPROVE_DELIVERY")) expect(onReviewed("APPROVE", ag, b).ok).toBe(true);
              if (buyerA.includes("DISPUTE_DELIVERY")) expect(onReviewed("DISPUTE", ag, b).ok).toBe(true);
              if (sellerA.includes("REQUEST_REVIEW") || sellerA.includes("REDELIVER")) {
                expect(onReviewRequested(ag, b, ev).ok).toBe(true);
              }
              if (buyerA.includes("PAY_ADVANCE") && !withPr) {
                expect(onPaymentRequestCreated(s.advance!).ok).toBe(true);
              }
              if (buyerA.includes("PAY_BALANCE") && !withPr) {
                expect(onPaymentRequestCreated(b).ok).toBe(true);
              }
              if (a === "COMPLETED") {
                expect(sellerA.filter((x) => x !== "EXPORT")).toEqual([]);
                expect(buyerA.filter((x) => x !== "EXPORT")).toEqual([]);
              }
              expect(new Set(sellerA).size).toBe(sellerA.length);
            }
          }
        }
      }
    }
  });
});
