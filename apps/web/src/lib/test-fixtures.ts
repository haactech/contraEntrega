import type {
  AllowedAction,
  BuyerAgreementView,
  ConversationView,
  FeedEvent,
  FeedMessage,
  ProposalView,
  SellerAgreementView,
} from "@trato/shared";

/** Builders for unit tests (never imported by app code). */
const SHA = "a".repeat(64);
const T0 = Date.parse("2026-11-14T10:00:00.000Z");
export const at = (minutes: number, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString();

export function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: "p1",
    version: 1,
    status: "OPEN",
    terms: {
      title: "Puerta de herrería",
      description: "",
      acceptanceCriteria: "Medidas 90x210, pintura negra; chapa instalada",
      buyerName: "Mariana",
      dueDate: "2026-11-21",
      totalCents: 2_000_000,
      advanceCents: 800_000,
      balanceCents: 1_200_000,
    },
    termsSha256: SHA,
    createdAt: at(0),
    confirmedAt: null,
    ...over,
  };
}

export function textMsg(id: string, seq: number, minutes: number, authorType: FeedMessage["authorType"], text: string, seconds = 0): FeedMessage {
  return {
    type: "message",
    id,
    seq,
    occurredAt: at(minutes, seconds),
    authorType,
    authorName: authorType === "SELLER" ? "Luis" : authorType === "BUYER" ? "Mariana" : "Trato",
    kind: "TEXT",
    text,
    proposal: null,
    assistant: authorType === "ASSISTANT" ? { provider: "mock", model: "mock" } : null,
    system: false,
  };
}

export function proposalMsg(id: string, seq: number, minutes: number, p: ProposalView): FeedMessage {
  return { ...textMsg(id, seq, minutes, "ASSISTANT", ""), kind: "PROPOSAL", proposal: p };
}

export function eventItem(id: string, seq: number, minutes: number, eventType: FeedEvent["eventType"], payload: Record<string, unknown> = {}): FeedEvent {
  return { type: "event", id, seq, occurredAt: at(minutes), eventType, actorType: "SYSTEM", payload };
}

export function conversationView(over: Partial<ConversationView> = {}): ConversationView {
  return {
    role: "SELLER",
    conversation: { id: "c1", agreementId: null, createdAt: at(0), updatedAt: at(0), version: 0 },
    feed: [],
    activeProposal: null,
    agreement: null,
    allowedActions: [],
    assistantBusy: false,
    assistant: { enabled: true, provider: "mock", model: "mock" },
    ...over,
  };
}

const core = {
  id: "a1",
  code: "TR-0001",
  title: "Puerta de herrería",
  description: "",
  acceptanceCriteria: "Medidas 90x210, pintura negra",
  buyerName: "Mariana",
  buyerPhoneMasked: null,
  dueDate: "2026-11-21",
  totalCents: 2_000_000,
  status: "SHARED" as const,
  termsSha256: SHA,
  termsVersion: 1,
  sharedAt: at(1),
  buyerAcceptedAt: null,
  buyerAcceptedName: null,
  completedAt: null,
  createdAt: at(0),
  updatedAt: at(1),
  version: 2,
};

export function sellerAgreementFixture(over: Partial<SellerAgreementView> = {}): SellerAgreementView {
  return {
    agreement: core,
    account: { alias: "Cuenta demo", last4: "1234" },
    milestones: [],
    paymentRequests: [],
    evidence: [],
    reviews: [],
    events: [],
    shareUrl: "https://x/t/abc",
    whatsappUrl: "https://wa.me/?text=x",
    nextAction: "WAIT_ACCEPTANCE",
    ...over,
  } as SellerAgreementView;
}

export function buyerAgreementFixture(over: Partial<BuyerAgreementView> = {}): BuyerAgreementView {
  return {
    agreement: core,
    seller: { displayName: "Luis", trade: "Herrería" },
    payee: { alias: "Cuenta demo", last4: "1234" },
    milestones: [],
    paymentRequests: [],
    evidence: [],
    reviews: [],
    events: [],
    activePaymentRequest: null,
    nextAction: "ACCEPT",
    ...over,
  } as BuyerAgreementView;
}

export const actions = (...a: AllowedAction[]): AllowedAction[] => a;
