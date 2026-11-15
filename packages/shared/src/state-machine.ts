import type {
  AgreementStatus,
  BuyerNextAction,
  ErrorCode,
  MilestoneKind,
  MilestoneStatus,
  PaymentRequestStatus,
  ReviewDecision,
  SellerNextAction,
} from "./enums";
import { EVIDENCE_LIMITS_COUNT } from "./state-constants";

/* ------------------------------------------------------------------ types */

export type Ok = { ok: true };
export type Fail = { ok: false; code: ErrorCode; message: string };
export type Result = Ok | Fail;

export interface AgreementSnapshot {
  status: AgreementStatus;
}

export interface MilestoneSnapshot {
  kind: MilestoneKind;
  status: MilestoneStatus;
  deliveryRound: number;
}

export interface PaymentRequestSnapshot {
  id: string;
  status: PaymentRequestStatus;
  /** Epoch ms; null when never confirmed by the provider. */
  expiresAtMs: number | null;
}

export interface PayeeAccountSnapshot {
  codiStatus: "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";
  enabled: boolean;
}

export interface AgreementState {
  agreementStatus: AgreementStatus;
  advanceStatus: MilestoneStatus;
  balanceStatus: MilestoneStatus;
}

const fail = (code: ErrorCode, message: string): Fail => ({ ok: false, code, message });
const OK: Ok = { ok: true };

/* ------------------------------------------------------------- guards */

export function canShare(agreement: AgreementSnapshot): Result {
  if (agreement.status === "COMPLETED") {
    return fail("INVALID_STATE", "Este trato ya está completado; no es necesario compartirlo de nuevo.");
  }
  return OK;
}

export function canAccept(agreement: AgreementSnapshot): Result {
  switch (agreement.status) {
    case "SHARED":
      return OK;
    case "DRAFT":
      return fail("INVALID_STATE", "Este trato todavía no está disponible.");
    default:
      return fail("INVALID_STATE", "Este acuerdo ya fue aceptado.");
  }
}

export type ActiveRequestFail = Fail & {
  /** Set when a valid active request exists and should be returned as-is (HTTP 200). */
  reusePaymentRequestId?: string;
  /** Set when the request must be reconciled with the provider before continuing. */
  reconcilePaymentRequestId?: string;
};
export type CanCreatePaymentRequestResult = Ok | ActiveRequestFail;

/**
 * Whether a new payment request can be created for `milestone`.
 * `activePaymentRequest` is the request (if any) in CREATING / AWAITING_PAYMENT / CREATION_UNKNOWN.
 */
export function canCreatePaymentRequest(
  milestone: MilestoneSnapshot,
  agreement: AgreementSnapshot,
  activePaymentRequest: PaymentRequestSnapshot | null,
  nowMs: number,
  account: PayeeAccountSnapshot,
): CanCreatePaymentRequestResult {
  const base = canCreateIgnoringAccount(milestone, agreement, activePaymentRequest, nowMs);
  if (!base.ok) return base;
  if (account.codiStatus !== "ACTIVE" || !account.enabled) {
    return fail("INVALID_STATE", "La cuenta del prestador aún no está activa en CoDi");
  }
  return OK;
}

function canCreateIgnoringAccount(
  milestone: MilestoneSnapshot,
  agreement: AgreementSnapshot,
  activePaymentRequest: PaymentRequestSnapshot | null,
  nowMs: number,
): CanCreatePaymentRequestResult {
  if (milestone.status === "PAID") {
    return fail("INVALID_STATE", "Este pago ya fue recibido.");
  }
  if (milestone.status === "DISPUTED" || agreement.status === "DISPUTED") {
    return fail("INVALID_STATE", "La entrega está en disputa; el saldo no se puede cobrar hasta resolverla.");
  }
  if (activePaymentRequest) {
    const pr = activePaymentRequest;
    if (pr.status === "AWAITING_PAYMENT" && pr.expiresAtMs !== null && pr.expiresAtMs > nowMs) {
      return {
        ...fail("INVALID_STATE", "Ya hay una solicitud de pago vigente para este hito."),
        reusePaymentRequestId: pr.id,
      };
    }
    if (pr.status === "AWAITING_PAYMENT" && pr.expiresAtMs === null) {
      return {
        ...fail("INVALID_STATE", "Ya hay una solicitud de pago vigente para este hito."),
        reusePaymentRequestId: pr.id,
      };
    }
    if (pr.status === "CREATING") {
      return fail("PAYMENT_PENDING_RECONCILIATION", "Estamos preparando tu cobro. Espera unos segundos.");
    }
    return {
      ...fail("PAYMENT_PENDING_RECONCILIATION", "Estamos verificando tu solicitud anterior antes de crear otra."),
      reconcilePaymentRequestId: pr.id,
    };
  }
  if (milestone.kind === "ADVANCE") {
    if (milestone.status === "PENDING_ACCEPTANCE") {
      return fail("INVALID_STATE", "El anticipo se puede cobrar hasta que el comprador acepte el acuerdo.");
    }
    if (milestone.status !== "ELIGIBLE" || agreement.status !== "ACCEPTED") {
      return fail("INVALID_STATE", "El anticipo no está disponible para cobro.");
    }
    return OK;
  }
  if (milestone.status === "READY_TO_CHARGE" && agreement.status === "IN_PROGRESS") return OK;
  if (milestone.status === "WAITING_DELIVERY" || milestone.status === "WAITING_BUYER_REVIEW") {
    return fail("INVALID_STATE", "Este pago se habilita cuando el comprador apruebe el trabajo.");
  }
  return fail("INVALID_STATE", "El saldo no está disponible para cobro.");
}

function canDeliver(agreement: AgreementSnapshot, balance: MilestoneSnapshot): Result {
  if (agreement.status === "COMPLETED" || balance.status === "PAID") {
    return fail("INVALID_STATE", "Este trato ya está completado.");
  }
  if (agreement.status !== "IN_PROGRESS" && agreement.status !== "DISPUTED") {
    return fail("INVALID_STATE", "Podrás subir evidencia cuando se reciba el anticipo.");
  }
  if (balance.status !== "WAITING_DELIVERY" && balance.status !== "DISPUTED") {
    return fail("INVALID_STATE", "La entrega ya fue enviada a revisión.");
  }
  return OK;
}

export function canAddEvidence(
  agreement: AgreementSnapshot,
  balance: MilestoneSnapshot,
  unsubmittedEvidenceCount: number,
): Result {
  const base = canDeliver(agreement, balance);
  if (!base.ok) return base;
  if (unsubmittedEvidenceCount >= EVIDENCE_LIMITS_COUNT.maxPerRound) {
    return fail("INVALID_STATE", `Máximo ${EVIDENCE_LIMITS_COUNT.maxPerRound} fotos por entrega.`);
  }
  return OK;
}

export function canRequestReview(
  agreement: AgreementSnapshot,
  balance: MilestoneSnapshot,
  unsubmittedEvidenceCount: number,
): Result {
  const base = canDeliver(agreement, balance);
  if (!base.ok) return base;
  if (unsubmittedEvidenceCount < 1) {
    return fail("INVALID_STATE", "Sube al menos una foto de la entrega antes de solicitar revisión.");
  }
  return OK;
}

export function canReview(agreement: AgreementSnapshot, balance: MilestoneSnapshot): Result {
  if (agreement.status !== "IN_PROGRESS" || balance.status !== "WAITING_BUYER_REVIEW") {
    return fail("INVALID_STATE", "No hay una entrega pendiente de revisión.");
  }
  return OK;
}

const CONFIRMABLE_PR_STATUSES: readonly PaymentRequestStatus[] = [
  "AWAITING_PAYMENT",
  "EXPIRED_LOCAL",
  "CREATION_UNKNOWN",
];

const PAYABLE_MILESTONE_STATUSES: Record<MilestoneKind, readonly MilestoneStatus[]> = {
  ADVANCE: ["ELIGIBLE", "AWAITING_PAYMENT"],
  BALANCE: ["READY_TO_CHARGE", "AWAITING_PAYMENT"],
};

/**
 * Whether a provider-confirmed payment may be applied to `pr`/`milestone`.
 * A milestone that is already PAID is "ok" here: onPaymentConfirmed reports `duplicate`.
 */
export function canConfirmPayment(pr: PaymentRequestSnapshot, milestone: MilestoneSnapshot): Result {
  if (milestone.status === "PAID") return OK;
  if (!CONFIRMABLE_PR_STATUSES.includes(pr.status)) {
    return fail("INVALID_STATE", "La solicitud de pago no admite confirmación en su estado actual.");
  }
  if (!PAYABLE_MILESTONE_STATUSES[milestone.kind].includes(milestone.status)) {
    return fail("INVALID_STATE", "El hito aún no es elegible para cobro.");
  }
  return OK;
}

/* -------------------------------------------------------- transitions */

export type AcceptedTransition = Ok & { agreementStatus: "ACCEPTED"; advanceStatus: "ELIGIBLE" };
export function onAccepted(agreement: AgreementSnapshot): Fail | AcceptedTransition {
  const g = canAccept(agreement);
  if (!g.ok) return g;
  return { ok: true, agreementStatus: "ACCEPTED", advanceStatus: "ELIGIBLE" };
}

export type PaymentRequestCreatedTransition = Ok & { milestoneStatus: "AWAITING_PAYMENT" };
export function onPaymentRequestCreated(milestone: MilestoneSnapshot): Fail | PaymentRequestCreatedTransition {
  const eligible = milestone.kind === "ADVANCE" ? "ELIGIBLE" : "READY_TO_CHARGE";
  if (milestone.status !== eligible) {
    return fail("INVALID_STATE", "El hito no está listo para cobrarse.");
  }
  return { ok: true, milestoneStatus: "AWAITING_PAYMENT" };
}

/** Request expired or failed: milestone goes back to its charge-eligible state. */
export function onPaymentRequestExpiredOrFailed(milestone: MilestoneSnapshot): { milestoneStatus: MilestoneStatus } {
  if (milestone.status !== "AWAITING_PAYMENT") return { milestoneStatus: milestone.status };
  return { milestoneStatus: milestone.kind === "ADVANCE" ? "ELIGIBLE" : "READY_TO_CHARGE" };
}

export interface PaymentConfirmedTransition {
  ok: true;
  /** True when the milestone was already PAID (caller emits DUPLICATE_PAYMENT_DETECTED, no state change). */
  duplicate: boolean;
  milestoneStatus: MilestoneStatus;
  agreementStatus: AgreementStatus;
  /** True when this payment completes the agreement (emit AGREEMENT_COMPLETED). */
  agreementCompleted: boolean;
}

/** Payment never touches approvals/reviews: only milestone + agreement status change. */
export function onPaymentConfirmed(
  milestone: MilestoneSnapshot,
  agreement: AgreementSnapshot,
): Fail | PaymentConfirmedTransition {
  if (milestone.status === "PAID") {
    return {
      ok: true,
      duplicate: true,
      milestoneStatus: "PAID",
      agreementStatus: agreement.status,
      agreementCompleted: false,
    };
  }
  if (!PAYABLE_MILESTONE_STATUSES[milestone.kind].includes(milestone.status)) {
    return fail("INVALID_STATE", "El hito aún no es elegible para cobro.");
  }
  if (milestone.kind === "ADVANCE") {
    return {
      ok: true,
      duplicate: false,
      milestoneStatus: "PAID",
      agreementStatus: "IN_PROGRESS",
      agreementCompleted: false,
    };
  }
  return {
    ok: true,
    duplicate: false,
    milestoneStatus: "PAID",
    agreementStatus: "COMPLETED",
    agreementCompleted: true,
  };
}

export interface ReviewRequestedTransition {
  ok: true;
  balanceStatus: "WAITING_BUYER_REVIEW";
  agreementStatus: "IN_PROGRESS";
  deliveryRound: number;
  /** True when this is a re-delivery after a dispute. */
  redelivery: boolean;
}

/** Re-delivery from DISPUTED increments deliveryRound; history is preserved by the caller. */
export function onReviewRequested(
  agreement: AgreementSnapshot,
  balance: MilestoneSnapshot,
  unsubmittedEvidenceCount: number,
): Fail | ReviewRequestedTransition {
  const g = canRequestReview(agreement, balance, unsubmittedEvidenceCount);
  if (!g.ok) return g;
  const redelivery = balance.status === "DISPUTED";
  return {
    ok: true,
    balanceStatus: "WAITING_BUYER_REVIEW",
    agreementStatus: "IN_PROGRESS",
    deliveryRound: redelivery ? balance.deliveryRound + 1 : balance.deliveryRound,
    redelivery,
  };
}

/** Round that newly uploaded evidence belongs to (next round while DISPUTED). */
export function evidenceRoundFor(balance: MilestoneSnapshot): number {
  return balance.status === "DISPUTED" ? balance.deliveryRound + 1 : balance.deliveryRound;
}

export type ReviewedTransition =
  | { ok: true; decision: "APPROVE"; balanceStatus: "READY_TO_CHARGE"; agreementStatus: "IN_PROGRESS"; approved: true; eventType: "DELIVERY_APPROVED" }
  | { ok: true; decision: "DISPUTE"; balanceStatus: "DISPUTED"; agreementStatus: "DISPUTED"; approved: false; eventType: "DELIVERY_DISPUTED" };

/** Approving never marks PAID: it only makes the balance chargeable. */
export function onReviewed(
  decision: ReviewDecision,
  agreement: AgreementSnapshot,
  balance: MilestoneSnapshot,
): Fail | ReviewedTransition {
  const g = canReview(agreement, balance);
  if (!g.ok) return g;
  if (decision === "APPROVE") {
    return {
      ok: true,
      decision,
      balanceStatus: "READY_TO_CHARGE",
      agreementStatus: "IN_PROGRESS",
      approved: true,
      eventType: "DELIVERY_APPROVED",
    };
  }
  return {
    ok: true,
    decision,
    balanceStatus: "DISPUTED",
    agreementStatus: "DISPUTED",
    approved: false,
    eventType: "DELIVERY_DISPUTED",
  };
}

/* -------------------------------------------------------- next actions */

export function computeSellerNextAction(state: AgreementState): SellerNextAction {
  const { agreementStatus: a, balanceStatus: b } = state;
  if (a === "COMPLETED" || b === "PAID") return "DONE";
  if (a === "DISPUTED" || b === "DISPUTED") return "RESOLVE_DISPUTE";
  switch (a) {
    case "DRAFT":
      return "SHARE";
    case "SHARED":
      return "WAIT_ACCEPTANCE";
    case "ACCEPTED":
      return "WAIT_ADVANCE";
    case "IN_PROGRESS":
      if (b === "WAITING_DELIVERY") return "UPLOAD_EVIDENCE";
      if (b === "WAITING_BUYER_REVIEW") return "WAIT_REVIEW";
      return "WAIT_BALANCE";
    default:
      return "WAIT_ADVANCE";
  }
}

export function computeBuyerNextAction(state: AgreementState): BuyerNextAction {
  const { agreementStatus: a, balanceStatus: b } = state;
  if (a === "COMPLETED" || b === "PAID") return "DONE";
  if (a === "DISPUTED" || b === "DISPUTED") return "WAIT_SELLER";
  switch (a) {
    case "DRAFT":
      return "WAIT_SELLER";
    case "SHARED":
      return "ACCEPT";
    case "ACCEPTED":
      return "PAY_ADVANCE";
    case "IN_PROGRESS":
      if (b === "WAITING_DELIVERY") return "WAIT_DELIVERY";
      if (b === "WAITING_BUYER_REVIEW") return "REVIEW";
      return "PAY_BALANCE";
    default:
      return "WAIT_SELLER";
  }
}
