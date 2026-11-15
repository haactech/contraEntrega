import { z } from "zod";
import type { ActorType } from "./enums";
import {
  canAccept,
  canAddEvidence,
  canConfirmPayment,
  canCreatePaymentRequest,
  canRequestReview,
  canReview,
  canShare,
  type AgreementSnapshot,
  type MilestoneSnapshot,
  type PayeeAccountSnapshot,
  type PaymentRequestSnapshot,
} from "./state-machine";

/**
 * Human actions available in the UI chips / MCP. Derived from the state machine guards;
 * never decided by the AI.
 */
export const ALLOWED_ACTIONS = [
  // seller
  "CONFIRM_PROPOSAL",
  "SHARE_LINK",
  "UPLOAD_EVIDENCE",
  "REQUEST_REVIEW",
  "REDELIVER",
  // buyer
  "ACCEPT_TERMS",
  "PAY_ADVANCE",
  "PAY_BALANCE",
  "REFRESH_PAYMENT",
  "APPROVE_DELIVERY",
  "DISPUTE_DELIVERY",
  // both
  "EXPORT",
] as const;
export const AllowedActionSchema = z.enum(ALLOWED_ACTIONS);
export type AllowedAction = z.infer<typeof AllowedActionSchema>;

/** Chip labels (Spanish, short). */
export const ALLOWED_ACTION_LABELS: Readonly<Record<AllowedAction, string>> = {
  CONFIRM_PROPOSAL: "Confirmar propuesta",
  SHARE_LINK: "Compartir enlace",
  UPLOAD_EVIDENCE: "Subir fotos",
  REQUEST_REVIEW: "Ya terminé",
  REDELIVER: "Entregar de nuevo",
  ACCEPT_TERMS: "Aceptar el acuerdo",
  PAY_ADVANCE: "Pagar anticipo",
  PAY_BALANCE: "Pagar saldo",
  REFRESH_PAYMENT: "Revisar mi pago",
  APPROVE_DELIVERY: "Recibido, todo bien",
  DISPUTE_DELIVERY: "Reportar problema",
  EXPORT: "Descargar comprobante",
};

export const ACTION_ROLES = ["SELLER", "BUYER"] as const satisfies readonly ActorType[];
export type ActionRole = (typeof ACTION_ROLES)[number];

/** Snapshot of everything the guards need. Built by the API from DB rows. */
export interface ActionState {
  /** null = no agreement yet (only a conversation). */
  agreement: AgreementSnapshot | null;
  advance: MilestoneSnapshot | null;
  balance: MilestoneSnapshot | null;
  /** Active payment request (CREATING / AWAITING_PAYMENT / CREATION_UNKNOWN) per milestone. */
  activePaymentRequests: {
    advance: PaymentRequestSnapshot | null;
    balance: PaymentRequestSnapshot | null;
  };
  /** Delivery evidence uploaded in the current round and not yet submitted. */
  unsubmittedEvidenceCount: number;
  /** A proposal in status OPEN exists in the conversation. */
  hasOpenProposal: boolean;
  nowMs: number;
  account: PayeeAccountSnapshot;
}

/** State for a conversation that has no agreement yet. */
export function noAgreementActionState(hasOpenProposal: boolean, nowMs: number): ActionState {
  return {
    agreement: null,
    advance: null,
    balance: null,
    activePaymentRequests: { advance: null, balance: null },
    unsubmittedEvidenceCount: 0,
    hasOpenProposal,
    nowMs,
    account: { codiStatus: "ACTIVE", enabled: true },
  };
}

const REFRESHABLE_PR = ["AWAITING_PAYMENT", "CREATION_UNKNOWN"] as const;

function payAction(
  kind: "advance" | "balance",
  state: ActionState,
  agreement: AgreementSnapshot,
): boolean {
  const milestone = state[kind];
  if (!milestone) return false;
  const active = state.activePaymentRequests[kind];
  const r = canCreatePaymentRequest(milestone, agreement, active, state.nowMs, state.account);
  if (r.ok) return true;
  // A valid pending request exists: the buyer can still open it (QR / push) to pay.
  if (agreement.status === "COMPLETED" || agreement.status === "DISPUTED") return false;
  return (
    "reusePaymentRequestId" in r &&
    r.reusePaymentRequestId !== undefined &&
    active !== null &&
    canConfirmPayment(active, milestone).ok &&
    milestone.status !== "PAID"
  );
}

/**
 * Actions the given role can take right now. Pure; every entry is backed by the matching guard
 * in `state-machine.ts`, so it never lists something the server would reject.
 */
export function allowedActions(state: ActionState, role: ActionRole): AllowedAction[] {
  const out = new Set<AllowedAction>();
  const { agreement, advance, balance } = state;

  if (role === "SELLER") {
    const revisable = agreement === null || agreement.status === "DRAFT" || agreement.status === "SHARED";
    if (state.hasOpenProposal && revisable) out.add("CONFIRM_PROPOSAL");
    if (agreement) {
      if ((agreement.status === "DRAFT" || agreement.status === "SHARED") && canShare(agreement).ok) {
        out.add("SHARE_LINK");
      }
      if (balance) {
        if (canAddEvidence(agreement, balance, state.unsubmittedEvidenceCount).ok) out.add("UPLOAD_EVIDENCE");
        if (canRequestReview(agreement, balance, state.unsubmittedEvidenceCount).ok) {
          out.add(balance.status === "DISPUTED" ? "REDELIVER" : "REQUEST_REVIEW");
        }
      }
      out.add("EXPORT");
    }
  } else if (agreement) {
    if (canAccept(agreement).ok) out.add("ACCEPT_TERMS");
    if (payAction("advance", state, agreement)) out.add("PAY_ADVANCE");
    if (payAction("balance", state, agreement)) out.add("PAY_BALANCE");
    const refreshable = (["advance", "balance"] as const).some((k) => {
      const pr = state.activePaymentRequests[k];
      return pr !== null && (REFRESHABLE_PR as readonly string[]).includes(pr.status);
    });
    if (refreshable && agreement.status !== "COMPLETED") out.add("REFRESH_PAYMENT");
    if (balance && canReview(agreement, balance).ok) {
      out.add("APPROVE_DELIVERY");
      out.add("DISPUTE_DELIVERY");
    }
    // Buyers only see agreements that have been shared.
    if (agreement.status !== "DRAFT") out.add("EXPORT");
  }
  // keep a stable order
  return ALLOWED_ACTIONS.filter((a) => out.has(a));
}

/** Convenience for context building: both roles at once. */
export function allowedActionsByRole(state: ActionState): Record<"seller" | "buyer", AllowedAction[]> {
  return { seller: allowedActions(state, "SELLER"), buyer: allowedActions(state, "BUYER") };
}
