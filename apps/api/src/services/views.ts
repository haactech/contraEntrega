import {
  APP_ROUTES,
  API_ROUTES,
  BUYER_HIDDEN_EVENT_TYPES,
  EventTypeSchema,
  computeBuyerNextAction,
  computeCleaningBuyerNextAction,
  computeCleaningSellerNextAction,
  computeSellerNextAction,
  type AgreementCore,
  type AgreementSummary,
  type BuyerAgreementView,
  type EventView,
  type EvidenceView,
  type MilestoneView,
  type PaymentRequestView,
  type ReviewView,
  type SellerAgreementView,
  type TaskProgress,
  type TaskView,
} from "@trato/shared";
import type { AppEnv } from "../env";
import { decryptText, signUrl } from "../lib/crypto";
import { evidenceUrlExpiry } from "../lib/url-window";
import type { AgreementBundle, AgreementRow, MilestoneRow, TaskRow } from "../repos/agreements";


const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

/** "******5678" — the buyer/seller views never carry a full phone number. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `${"*".repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}`;
}

export function buyerLink(env: Pick<AppEnv, "PUBLIC_APP_URL">, token: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/$/, "")}${APP_ROUTES.buyer(token)}`;
}

export function whatsappLink(agreement: Pick<AgreementRow, "buyerName" | "code" | "title">, shareUrl: string): string {
  const text =
    `Hola ${agreement.buyerName}, te comparto el trato ${agreement.code} «${agreement.title}». ` +
    `Revísalo y acéptalo aquí: ${shareUrl}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function agreementCore(a: AgreementRow): AgreementCore {
  return {
    id: a.id,
    code: a.code,
    title: a.title,
    description: a.description,
    acceptanceCriteria: a.acceptanceCriteria,
    buyerName: a.buyerName,
    buyerPhoneMasked: maskPhone(a.buyerPhone),
    dueDate: a.dueDate,
    totalCents: a.totalCents,
    status: a.status,
    termsSha256: a.termsSha256 ?? "",
    termsVersion: a.termsVersion,
    sharedAt: isoOrNull(a.sharedAt),
    buyerAcceptedAt: isoOrNull(a.buyerAcceptedAt),
    buyerAcceptedName: a.buyerAcceptedName,
    completedAt: isoOrNull(a.completedAt),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
    version: a.version,
  };
}

const milestoneView = (m: MilestoneRow): MilestoneView => ({
  id: m.id,
  kind: m.kind,
  amountCents: m.amountCents,
  description: m.description,
  status: m.status,
  deliveryRound: m.deliveryRound,
  approvedAt: isoOrNull(m.approvedAt),
  paidAt: isoOrNull(m.paidAt),
});

export const paymentRequestView = (
  p: AgreementBundle["paymentRequests"][number],
  milestoneKind: MilestoneRow["kind"],
): PaymentRequestView => ({
  id: p.id,
  milestoneId: p.milestoneId,
  milestoneKind,
  method: p.method,
  status: p.status,
  amountCents: p.amountCents,
  numRef: p.numRef,
  qrString: p.qrString,
  phoneLast4: p.phoneLast4,
  expiresAt: isoOrNull(p.expiresAt),
  createdAt: iso(p.createdAt),
  paidAt: isoOrNull(p.paidAt),
});

export async function evidenceView(
  env: AppEnv,
  e: AgreementBundle["evidence"][number],
  nowMs: number,
): Promise<EvidenceView> {
  return {
    id: e.id,
    milestoneId: e.milestoneId,
    deliveryRound: e.deliveryRound,
    url: await signUrl(env.SESSION_SECRET, API_ROUTES.evidenceFile(e.id), evidenceUrlExpiry(nowMs)),
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    submitted: e.submitted,
    taskId: e.taskId,
    kind: e.kind,
    revisionNumber: e.revisionNumber,
    createdAt: iso(e.createdAt),
  };
}

export const isCleaning = (a: Pick<AgreementRow, "serviceType">): boolean => a.serviceType === "CLEANING";

export const taskProgressOf = (tasks: readonly { status: TaskRow["status"] }[]): TaskProgress => ({
  approved: tasks.filter((t) => t.status === "APPROVED").length,
  total: tasks.length,
});

/**
 * Cleaning checklist with each task's photos and decisions. Unsubmitted photos are only for the
 * seller (`includeDrafts`); the buyer sees a photo once its revision was submitted.
 */
export async function taskViews(
  env: AppEnv,
  b: AgreementBundle,
  nowMs: number,
  includeDrafts: boolean,
): Promise<TaskView[] | null> {
  if (!isCleaning(b.agreement)) return null;
  return Promise.all(
    b.tasks.map(async (t) => ({
      id: t.id,
      position: t.position,
      title: t.title,
      description: t.description,
      status: t.status,
      revision: t.revision,
      submittedAt: isoOrNull(t.submittedAt),
      approvedAt: isoOrNull(t.approvedAt),
      evidence: await Promise.all(
        b.evidence.filter((e) => e.taskId === t.id && (includeDrafts || e.submitted)).map((e) => evidenceView(env, e, nowMs)),
      ),
      reviews: b.taskReviews
        .filter((r) => r.taskId === t.id)
        .map((r) => ({
          id: r.id,
          revisionNumber: r.revisionNumber,
          decision: r.decision,
          comment: r.comment,
          reviewerName: r.reviewerName,
          createdAt: iso(r.createdAt),
        })),
    })),
  );
}

export const reviewView = (r: AgreementBundle["reviews"][number]): ReviewView => ({
  id: r.id,
  milestoneId: r.milestoneId,
  deliveryRound: r.deliveryRound,
  decision: r.decision,
  comment: r.comment,
  buyerName: r.buyerName,
  createdAt: iso(r.createdAt),
});

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function eventViews(events: AgreementBundle["events"], hideForBuyer: boolean): EventView[] {
  const hidden: readonly string[] = BUYER_HIDDEN_EVENT_TYPES;
  const out: EventView[] = [];
  for (const e of events) {
    if (hideForBuyer && hidden.includes(e.eventType)) continue;
    out.push({
      id: e.id,
      seq: e.seq,
      type: EventTypeSchema.parse(e.eventType),
      actorType: e.actorType,
      occurredAt: iso(e.occurredAt),
      payload: parsePayload(e.payloadJson),
    });
  }
  return out;
}

function states(b: AgreementBundle) {
  const advance = b.milestones.find((m) => m.kind === "ADVANCE");
  const balance = b.milestones.find((m) => m.kind === "BALANCE");
  return {
    agreementStatus: b.agreement.status,
    advanceStatus: advance?.status ?? "PENDING_ACCEPTANCE",
    balanceStatus: balance?.status ?? "WAITING_DELIVERY",
  } as const;
}

export function sellerSummary(
  a: AgreementRow,
  balanceStatus: MilestoneRow["status"],
  conversationId: string | null = null,
  tasks: readonly { status: TaskRow["status"] }[] = [],
): AgreementSummary {
  const cleaning = a.serviceType === "CLEANING";
  return {
    id: a.id,
    code: a.code,
    title: a.title,
    buyerName: a.buyerName,
    totalCents: a.totalCents,
    status: a.status,
    dueDate: a.dueDate,
    conversationId,
    nextAction: cleaning
      ? computeCleaningSellerNextAction({ agreementStatus: a.status, balanceStatus, tasks })
      : computeSellerNextAction({ agreementStatus: a.status, advanceStatus: "PENDING_ACCEPTANCE", balanceStatus }),
    serviceType: a.serviceType,
    taskProgress: cleaning ? taskProgressOf(tasks) : null,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

const nextActionSeller = (b: AgreementBundle) =>
  isCleaning(b.agreement)
    ? computeCleaningSellerNextAction({ agreementStatus: b.agreement.status, balanceStatus: states(b).balanceStatus, tasks: b.tasks })
    : computeSellerNextAction(states(b));
const nextActionBuyer = (b: AgreementBundle) =>
  isCleaning(b.agreement)
    ? computeCleaningBuyerNextAction({ agreementStatus: b.agreement.status, balanceStatus: states(b).balanceStatus, tasks: b.tasks })
    : computeBuyerNextAction(states(b));

const prViews = (b: AgreementBundle): PaymentRequestView[] => {
  const kinds = new Map(b.milestones.map((m) => [m.id, m.kind]));
  return b.paymentRequests.map((p) => paymentRequestView(p, kinds.get(p.milestoneId) ?? "ADVANCE"));
};

const byKind = (a: MilestoneRow, b: MilestoneRow): number => (a.kind === b.kind ? 0 : a.kind === "ADVANCE" ? -1 : 1);

export async function buildSellerView(
  env: AppEnv,
  b: AgreementBundle,
  nowMs: number,
  /** Plaintext token when the caller just issued it; otherwise decrypted from the stored ciphertext. */
  knownToken?: string,
): Promise<SellerAgreementView> {
  let shareUrl: string | null = null;
  if (b.activeAccess) {
    const token = knownToken ?? (await decryptText(env.SESSION_SECRET, b.activeAccess.tokenCiphertext));
    shareUrl = buyerLink(env, token);
  }
  return {
    agreement: agreementCore(b.agreement),
    account: { alias: b.account.alias, last4: b.account.clabeLast4 },
    milestones: [...b.milestones].sort(byKind).map(milestoneView),
    paymentRequests: prViews(b),
    evidence: await Promise.all(b.evidence.map((e) => evidenceView(env, e, nowMs))),
    serviceType: b.agreement.serviceType,
    paymentStrategy: b.agreement.paymentStrategy,
    tasks: await taskViews(env, b, nowMs, true),
    taskProgress: isCleaning(b.agreement) ? taskProgressOf(b.tasks) : null,
    reviews: b.reviews.map(reviewView),
    events: eventViews(b.events, false),
    shareUrl,
    whatsappUrl: shareUrl ? whatsappLink(b.agreement, shareUrl) : null,
    conversationId: b.conversationId,
    nextAction: nextActionSeller(b),
  };
}

export async function buildBuyerView(env: AppEnv, b: AgreementBundle, nowMs: number): Promise<BuyerAgreementView> {
  const prs = prViews(b);
  const active = [...prs].reverse().find((p) => p.status === "AWAITING_PAYMENT") ?? null;
  return {
    agreement: agreementCore(b.agreement),
    seller: { displayName: b.seller.displayName, trade: b.seller.trade },
    payee: { alias: b.account.alias, last4: b.account.clabeLast4 },
    milestones: [...b.milestones].sort(byKind).map(milestoneView),
    paymentRequests: prs,
    // Draft (unsubmitted) evidence is never shown to the buyer.
    evidence: await Promise.all(b.evidence.filter((e) => e.submitted).map((e) => evidenceView(env, e, nowMs))),
    serviceType: b.agreement.serviceType,
    paymentStrategy: b.agreement.paymentStrategy,
    tasks: await taskViews(env, b, nowMs, false),
    taskProgress: isCleaning(b.agreement) ? taskProgressOf(b.tasks) : null,
    reviews: b.reviews.map(reviewView),
    events: eventViews(b.events, true),
    activePaymentRequest: active,
    nextAction: nextActionBuyer(b),
  };
}
