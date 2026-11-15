import {
  allowedActions,
  assistantFactsFromStatuses,
  buildAssistantContext,
  mxnToCents,
  type ActionState,
  type AgreementStatus,
  type AllowedAction,
  type AssistantContext,
  type AssistantContextInput,
  type AssistantStateFacts,
  type MilestoneStatus,
} from "@trato/shared";
import type { EvalCase, EvalTerms, Scenario } from "./types";
import { TermsSchema } from "./types";

/** Named term sets used by the datasets (kept out of the JSONL to keep cases short). */
export const TERMS_PRESETS: Record<string, EvalTerms> = {
  PUERTA: {
    title: "Puerta de herrería",
    description: "",
    acceptanceCriteria: "Puerta instalada, alineada y cerrando sin atorarse",
    buyerName: "Mariana",
    dueDate: "2026-11-20",
    totalMxn: 20000,
    advanceMxn: 8000,
  },
  FACHADA: {
    title: "Pintura de fachada",
    description: "Dos manos de pintura vinílica con material incluido",
    acceptanceCriteria: "Fachada completa pintada, sin goteos y con el color acordado",
    buyerName: "Luis Hernández",
    dueDate: null,
    totalMxn: 35000,
    advanceMxn: 17500,
  },
  LAVADORA: {
    title: "Reparación de lavadora",
    description: "",
    acceptanceCriteria: "Lavadora funcionando un ciclo completo sin fugas",
    buyerName: "Doña Chela",
    dueDate: null,
    totalMxn: 1250.5,
    advanceMxn: 400.25,
  },
};

interface ScenarioSpec {
  agreementStatus: AgreementStatus | null;
  advance: MilestoneStatus | null;
  balance: MilestoneStatus | null;
  evidence: number;
  advancePaymentRequest: boolean;
}

const SPECS: Record<Scenario, ScenarioSpec> = {
  NO_AGREEMENT: { agreementStatus: null, advance: null, balance: null, evidence: 0, advancePaymentRequest: false },
  OPEN_PROPOSAL: { agreementStatus: null, advance: null, balance: null, evidence: 0, advancePaymentRequest: false },
  SHARED: { agreementStatus: "SHARED", advance: "PENDING_ACCEPTANCE", balance: "WAITING_DELIVERY", evidence: 0, advancePaymentRequest: false },
  ACCEPTED: { agreementStatus: "ACCEPTED", advance: "ELIGIBLE", balance: "WAITING_DELIVERY", evidence: 0, advancePaymentRequest: false },
  ADVANCE_PAYMENT_PENDING: { agreementStatus: "ACCEPTED", advance: "AWAITING_PAYMENT", balance: "WAITING_DELIVERY", evidence: 0, advancePaymentRequest: true },
  IN_PROGRESS: { agreementStatus: "IN_PROGRESS", advance: "PAID", balance: "WAITING_DELIVERY", evidence: 0, advancePaymentRequest: false },
  EVIDENCE_READY: { agreementStatus: "IN_PROGRESS", advance: "PAID", balance: "WAITING_DELIVERY", evidence: 2, advancePaymentRequest: false },
  IN_REVIEW: { agreementStatus: "IN_PROGRESS", advance: "PAID", balance: "WAITING_BUYER_REVIEW", evidence: 0, advancePaymentRequest: false },
  READY_TO_CHARGE: { agreementStatus: "IN_PROGRESS", advance: "PAID", balance: "READY_TO_CHARGE", evidence: 0, advancePaymentRequest: false },
  DISPUTED: { agreementStatus: "DISPUTED", advance: "PAID", balance: "DISPUTED", evidence: 0, advancePaymentRequest: false },
  DISPUTED_FIXED: { agreementStatus: "DISPUTED", advance: "PAID", balance: "DISPUTED", evidence: 2, advancePaymentRequest: false },
  COMPLETED: { agreementStatus: "COMPLETED", advance: "PAID", balance: "PAID", evidence: 0, advancePaymentRequest: false },
};

export function resolveTerms(c: EvalCase): EvalTerms | null {
  const t = c.input.terms;
  if (t === undefined) return null;
  if (typeof t === "string") {
    const preset = TERMS_PRESETS[t];
    if (!preset) throw new Error(`${c.id}: terms preset desconocido «${t}»`);
    return preset;
  }
  return TermsSchema.parse(t);
}

export function nowMsFor(today: string): number {
  // 12:00 in Mexico City (UTC-6, no DST since 2022) -> 18:00Z
  return Date.parse(`${today}T18:00:00Z`);
}

export interface BuiltCase {
  context: AssistantContext;
  allowed: AllowedAction[];
  allowedBoth: { seller: AllowedAction[]; buyer: AllowedAction[] };
  facts: AssistantStateFacts;
  baseTerms: EvalTerms | null;
}

export function buildCase(c: EvalCase): BuiltCase {
  const spec = SPECS[c.input.scenario];
  const terms = resolveTerms(c);
  const nowMs = nowMsFor(c.input.today);
  if (c.input.scenario !== "NO_AGREEMENT" && !terms) throw new Error(`${c.id}: el escenario ${c.input.scenario} requiere terms`);

  const toCtxTerms = (t: EvalTerms) => ({
    title: t.title,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria,
    buyerName: t.buyerName,
    dueDate: t.dueDate,
    totalCents: mxnToCents(t.totalMxn),
    advanceCents: mxnToCents(t.advanceMxn),
  });

  const hasOpenProposal = c.input.scenario === "OPEN_PROPOSAL";
  const actionState: ActionState = {
    agreement: spec.agreementStatus ? { status: spec.agreementStatus } : null,
    advance: spec.advance ? { kind: "ADVANCE", status: spec.advance, deliveryRound: 1 } : null,
    balance: spec.balance ? { kind: "BALANCE", status: spec.balance, deliveryRound: 1 } : null,
    activePaymentRequests: {
      advance: spec.advancePaymentRequest
        ? { id: "pr-1", status: "AWAITING_PAYMENT", expiresAtMs: nowMs + 3_600_000 }
        : null,
      balance: null,
    },
    unsubmittedEvidenceCount: spec.evidence,
    hasOpenProposal,
    nowMs,
    account: { codiStatus: "ACTIVE", enabled: true },
  };
  const allowedBoth = {
    seller: allowedActions(actionState, "SELLER"),
    buyer: allowedActions(actionState, "BUYER"),
  };

  const input: AssistantContextInput = {
    nowMs,
    speaker: c.input.speaker,
    agreement:
      spec.agreementStatus && terms
        ? {
            status: spec.agreementStatus,
            terms: toCtxTerms(terms),
            milestones: [
              { kind: "ADVANCE", status: spec.advance ?? "PENDING_ACCEPTANCE", amountCents: mxnToCents(terms.advanceMxn) },
              {
                kind: "BALANCE",
                status: spec.balance ?? "WAITING_DELIVERY",
                amountCents: mxnToCents(terms.totalMxn) - mxnToCents(terms.advanceMxn),
              },
            ],
          }
        : null,
    openProposal: hasOpenProposal && terms ? { version: 1, status: "OPEN", terms: toCtxTerms(terms) } : null,
    allowedActions: allowedBoth,
    messages: c.input.messages.map((m) => ({ authorType: m.author, text: m.text })),
  };

  return {
    context: buildAssistantContext(input),
    allowed: c.input.speaker === "SELLER" ? allowedBoth.seller : allowedBoth.buyer,
    allowedBoth,
    facts: assistantFactsFromStatuses(spec.advance, spec.balance),
    baseTerms: terms,
  };
}
