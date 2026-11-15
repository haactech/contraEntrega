import type { MilestoneView, SellerAgreementView } from "@trato/shared";

export const PROGRESS_STEPS = [
  { label: "Acordado" },
  { label: "Aceptado" },
  { label: "Anticipo" },
  { label: "Entrega" },
  { label: "Revisión" },
  { label: "Saldo" },
  { label: "Completado" },
] as const;

export interface Progress {
  /** Index of the active step (ignored when `done`). */
  current: number;
  done: boolean;
}

type ProgressInput = {
  agreement: Pick<SellerAgreementView["agreement"], "status" | "sharedAt" | "buyerAcceptedAt">;
  milestones: readonly Pick<MilestoneView, "kind" | "status">[];
};

/** Maps agreement + milestone state to the 7-step stepper (spec §H.3). */
export function computeProgress(v: ProgressInput): Progress {
  const advance = v.milestones.find((m) => m.kind === "ADVANCE");
  const balance = v.milestones.find((m) => m.kind === "BALANCE");
  if (v.agreement.status === "COMPLETED" || balance?.status === "PAID") return { current: 6, done: true };
  if (advance?.status !== "PAID") {
    if (v.agreement.buyerAcceptedAt) return { current: 2, done: false };
    if (v.agreement.sharedAt) return { current: 1, done: false };
    return { current: 0, done: false };
  }
  switch (balance?.status) {
    case "WAITING_BUYER_REVIEW":
    case "DISPUTED":
      return { current: 4, done: false };
    case "READY_TO_CHARGE":
    case "AWAITING_PAYMENT":
      return { current: 5, done: false };
    default:
      return { current: 3, done: false };
  }
}
