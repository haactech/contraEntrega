import {
  APP_ROUTES,
  API_ROUTES,
  BUYER_HIDDEN_EVENT_TYPES,
  EventTypeSchema,
  computeBuyerNextAction,
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
} from "@trato/shared";
import type { AppEnv } from "../env";
import { decryptText, signUrl } from "../lib/crypto";
import type { AgreementBundle, AgreementRow, MilestoneRow } from "../repos/agreements";

const EVIDENCE_URL_TTL_MS = 15 * 60 * 1000;

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

const paymentRequestView = (p: AgreementBundle["paymentRequests"][number]): PaymentRequestView => ({
  id: p.id,
  milestoneId: p.milestoneId,
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

async function evidenceView(
  env: AppEnv,
  e: AgreementBundle["evidence"][number],
  nowMs: number,
): Promise<EvidenceView> {
  return {
    id: e.id,
    milestoneId: e.milestoneId,
    deliveryRound: e.deliveryRound,
    url: await signUrl(env.SESSION_SECRET, API_ROUTES.evidenceFile(e.id), nowMs + EVIDENCE_URL_TTL_MS),
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    submitted: e.submitted,
    createdAt: iso(e.createdAt),
  };
}

const reviewView = (r: AgreementBundle["reviews"][number]): ReviewView => ({
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

function eventViews(events: AgreementBundle["events"], hideForBuyer: boolean): EventView[] {
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

export function sellerSummary(a: AgreementRow, balanceStatus: MilestoneRow["status"]): AgreementSummary {
  return {
    id: a.id,
    code: a.code,
    title: a.title,
    buyerName: a.buyerName,
    totalCents: a.totalCents,
    status: a.status,
    dueDate: a.dueDate,
    nextAction: computeSellerNextAction({
      agreementStatus: a.status,
      advanceStatus: "PENDING_ACCEPTANCE",
      balanceStatus,
    }),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

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
    paymentRequests: b.paymentRequests.map(paymentRequestView),
    evidence: await Promise.all(b.evidence.map((e) => evidenceView(env, e, nowMs))),
    reviews: b.reviews.map(reviewView),
    events: eventViews(b.events, false),
    shareUrl,
    whatsappUrl: shareUrl ? whatsappLink(b.agreement, shareUrl) : null,
    nextAction: computeSellerNextAction(states(b)),
  };
}

export async function buildBuyerView(env: AppEnv, b: AgreementBundle, nowMs: number): Promise<BuyerAgreementView> {
  const prs = b.paymentRequests.map(paymentRequestView);
  const active = [...prs].reverse().find((p) => p.status === "AWAITING_PAYMENT") ?? null;
  return {
    agreement: agreementCore(b.agreement),
    seller: { displayName: b.seller.displayName, trade: b.seller.trade },
    payee: { alias: b.account.alias, last4: b.account.clabeLast4 },
    milestones: [...b.milestones].sort(byKind).map(milestoneView),
    paymentRequests: prs,
    // Draft (unsubmitted) evidence is never shown to the buyer.
    evidence: await Promise.all(b.evidence.filter((e) => e.submitted).map((e) => evidenceView(env, e, nowMs))),
    reviews: b.reviews.map(reviewView),
    events: eventViews(b.events, true),
    activePaymentRequest: active,
    nextAction: computeBuyerNextAction(states(b)),
  };
}
