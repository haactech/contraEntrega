import {
  ALLOWED_ACTION_LABELS,
  compareFeedItems,
  type AllowedAction,
  type BuyerAgreementView,
  type ConversationView,
  type FeedEvent,
  type FeedItem,
  type FeedMessage,
  type ProposalView,
  type SellerAgreementView,
} from "@trato/shared";

export type Role = ConversationView["role"];

/* ------------------------------------------------------------------ agreement narrowing */

export function sellerAgreement(view: ConversationView): SellerAgreementView | null {
  const a = view.agreement;
  return a && view.role === "SELLER" && "shareUrl" in a ? a : null;
}

export function buyerAgreement(view: ConversationView): BuyerAgreementView | null {
  const a = view.agreement;
  return a && view.role === "BUYER" && "activePaymentRequest" in a ? a : null;
}

/* ------------------------------------------------------------------ feed */

export function sortFeed(feed: readonly FeedItem[]): FeedItem[] {
  return [...feed].sort(compareFeedItems);
}

/** Consecutive messages by the same author within this window share one header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type FeedEntry =
  | { kind: "messages"; key: string; authorType: FeedMessage["authorType"]; authorName: string; items: FeedMessage[] }
  | { kind: "proposal"; key: string; item: FeedMessage }
  | { kind: "event"; key: string; item: FeedEvent }
  | { kind: "system"; key: string; item: FeedMessage };

/**
 * Sorted feed -> render entries. Text messages from the same author within `GROUP_WINDOW_MS`
 * collapse into one group; proposals and events are standalone cards and break groups.
 */
export function groupFeed(feed: readonly FeedItem[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let lastAt = 0;
  for (const item of sortFeed(feed)) {
    if (item.type === "event") {
      out.push({ kind: "event", key: item.id, item });
      continue;
    }
    if (item.system) {
      out.push({ kind: "system", key: item.id, item });
      lastAt = 0;
      continue;
    }
    if (item.kind === "PROPOSAL" && item.proposal) {
      out.push({ kind: "proposal", key: item.id, item });
      continue;
    }
    const at = Date.parse(item.occurredAt);
    const prev = out[out.length - 1];
    if (
      prev?.kind === "messages" &&
      prev.authorType === item.authorType &&
      prev.authorName === item.authorName &&
      at - lastAt <= GROUP_WINDOW_MS
    ) {
      prev.items.push(item);
    } else {
      out.push({ kind: "messages", key: item.id, authorType: item.authorType, authorName: item.authorName, items: [item] });
    }
    lastAt = at;
  }
  return out;
}

/** Version that replaced `proposal`: the next higher version seen in the feed (else version + 1). */
export function supersededByVersion(feed: readonly FeedItem[], proposal: Pick<ProposalView, "version">): number {
  let next: number | null = null;
  for (const item of feed) {
    if (item.type !== "message" || !item.proposal) continue;
    const v = item.proposal.version;
    if (v > proposal.version && (next === null || v < next)) next = v;
  }
  return next ?? proposal.version + 1;
}

/** Id of the last item, used to detect new content. */
export function lastFeedKey(feed: readonly FeedItem[]): string | null {
  const s = sortFeed(feed);
  const last = s[s.length - 1];
  return last ? `${last.type}:${last.id}` : null;
}

/* ------------------------------------------------------------------ chips */

export interface ActionChip {
  action: AllowedAction;
  label: string;
  primary: boolean;
}

const SECONDARY_ACTIONS: ReadonlySet<AllowedAction> = new Set(["EXPORT", "REFRESH_PAYMENT", "SHARE_LINK"]);

/** Deterministic chips from the server's `allowedActions` (never from the AI). */
export function chipsFromActions(actions: readonly AllowedAction[]): ActionChip[] {
  const seen = new Set<AllowedAction>();
  const chips: ActionChip[] = [];
  for (const action of actions) {
    if (seen.has(action)) continue;
    seen.add(action);
    chips.push({ action, label: ALLOWED_ACTION_LABELS[action], primary: !SECONDARY_ACTIONS.has(action) });
  }
  return chips;
}

/* ------------------------------------------------------------------ dock cards */

export type DockCard =
  | { kind: "proposal" }
  | { kind: "payment"; milestone: "ADVANCE" | "BALANCE" }
  | { kind: "delivery" }
  | { kind: "deliver" }
  | { kind: "dispute" }
  | { kind: "completed" };

export type DockKind = DockCard["kind"];

/** Cards with a pending or relevant action, shown anchored next to the composer. */
export function activeCards(view: ConversationView): DockCard[] {
  const out: DockCard[] = [];
  const acts = new Set(view.allowedActions);
  const agreement = view.agreement;
  const nextAction: string | null = agreement ? agreement.nextAction : null;
  const status = agreement?.agreement.status ?? null;

  if (view.activeProposal && status !== "COMPLETED") out.push({ kind: "proposal" });

  if (agreement) {
    if (view.role === "SELLER") {
      if (nextAction === "RESOLVE_DISPUTE") out.push({ kind: "dispute" });
      else if (acts.has("UPLOAD_EVIDENCE") || acts.has("REQUEST_REVIEW") || acts.has("REDELIVER")) {
        out.push({ kind: "deliver" });
      }
    } else {
      if (acts.has("PAY_ADVANCE")) out.push({ kind: "payment", milestone: "ADVANCE" });
      if (nextAction === "REVIEW") out.push({ kind: "delivery" });
      if (acts.has("PAY_BALANCE")) out.push({ kind: "payment", milestone: "BALANCE" });
      if (status === "DISPUTED") out.push({ kind: "dispute" });
    }
    if (status === "COMPLETED" || nextAction === "DONE") out.push({ kind: "completed" });
  }
  return out;
}

/** Which dock card a chip should bring into view. `null` = the chip acts directly. */
export function chipTargetCard(action: AllowedAction, cards: readonly DockCard[]): DockKind | null {
  const has = (k: DockKind) => cards.some((c) => c.kind === k);
  switch (action) {
    case "CONFIRM_PROPOSAL":
    case "ACCEPT_TERMS":
      return has("proposal") ? "proposal" : null;
    case "PAY_ADVANCE":
    case "PAY_BALANCE":
    case "REFRESH_PAYMENT":
      return has("payment") ? "payment" : null;
    case "APPROVE_DELIVERY":
    case "DISPUTE_DELIVERY":
      return has("delivery") ? "delivery" : null;
    case "REQUEST_REVIEW":
    case "REDELIVER":
    case "UPLOAD_EVIDENCE":
      return has("dispute") ? "dispute" : has("deliver") ? "deliver" : null;
    case "SHARE_LINK":
    case "EXPORT":
      return null;
  }
}

/* ------------------------------------------------------------------ proposal card model */

export interface ProposalCardContext {
  role: Role;
  agreementStatus: string | null;
  /** The proposal is `view.activeProposal`. */
  isActive: boolean;
  allowedActions: readonly AllowedAction[];
  /** Version that replaced it (for SUPERSEDED). */
  supersededBy: number;
}

export type ProposalPrimary = "CONFIRM_AND_SHARE" | "ACCEPT" | "SHARE_AGAIN" | null;

export interface ProposalCardModel {
  primary: ProposalPrimary;
  dimmed: boolean;
  strike: boolean;
  /** Text shown in place of actions (status line). */
  banner: string | null;
  /** «Escribir "sí" no acepta el trato; usa el botón». */
  showYesNote: boolean;
  statusLabel: string;
  tone: "neutral" | "brand" | "warn" | "success";
}

export const YES_NOTE = "Escribir \"sí\" no acepta el trato; usa el botón.";

export function proposalCardModel(p: Pick<ProposalView, "status" | "version">, ctx: ProposalCardContext): ProposalCardModel {
  const acts = new Set(ctx.allowedActions);
  switch (p.status) {
    case "SUPERSEDED":
      return {
        primary: null,
        dimmed: true,
        strike: true,
        banner: `Reemplazada por la versión ${ctx.supersededBy}`,
        showYesNote: false,
        statusLabel: "Reemplazada",
        tone: "neutral",
      };
    case "ACCEPTED":
      return { primary: null, dimmed: false, strike: false, banner: "Acuerdo aceptado. Esto no es un pago.", showYesNote: false, statusLabel: "Aceptada", tone: "success" };
    case "OPEN": {
      let primary: ProposalPrimary = null;
      let banner: string | null = null;
      if (ctx.isActive && ctx.role === "SELLER" && acts.has("CONFIRM_PROPOSAL")) primary = "CONFIRM_AND_SHARE";
      else if (ctx.isActive && ctx.role === "BUYER") banner = "El prestador debe confirmar esta propuesta antes de que puedas aceptarla.";
      else if (!ctx.isActive) banner = "Propuesta anterior.";
      return {
        primary,
        dimmed: !ctx.isActive,
        strike: false,
        banner,
        showYesNote: ctx.isActive && ctx.role === "BUYER",
        statusLabel: "Borrador",
        tone: "warn",
      };
    }
    case "SELLER_CONFIRMED": {
      let primary: ProposalPrimary = null;
      let banner: string | null = null;
      if (ctx.isActive && ctx.role === "BUYER" && ctx.agreementStatus === "SHARED" && acts.has("ACCEPT_TERMS")) {
        primary = "ACCEPT";
      } else if (ctx.isActive && ctx.role === "SELLER") {
        if (acts.has("SHARE_LINK")) primary = "SHARE_AGAIN";
        banner = "Esperando que el comprador acepte.";
      }
      return {
        primary,
        dimmed: !ctx.isActive,
        strike: false,
        banner,
        showYesNote: primary === "ACCEPT",
        statusLabel: "Confirmada por el prestador",
        tone: "brand",
      };
    }
  }
}

/* ------------------------------------------------------------------ polling state */

export function conversationPollState(view: ConversationView | null): { awaitingPayment: boolean; busy: boolean } {
  if (!view) return { awaitingPayment: false, busy: false };
  const b = buyerAgreement(view);
  const s = sellerAgreement(view);
  const awaitingPayment =
    b?.activePaymentRequest?.status === "AWAITING_PAYMENT" ||
    (s?.paymentRequests.some((p) => p.status === "AWAITING_PAYMENT") ?? false);
  return { awaitingPayment, busy: view.assistantBusy };
}

/* ------------------------------------------------------------------ optimistic messages */

export interface PendingMessage {
  clientId: string;
  text: string;
  createdAt: number;
  /** How many identical own messages the feed had when it was sent. */
  baseline: number;
  status: "sending" | "failed";
  error?: string;
}

export function countOwnWithText(feed: readonly FeedItem[], role: Role, text: string): number {
  const t = text.trim();
  return feed.filter((i) => i.type === "message" && i.kind === "TEXT" && i.authorType === role && i.text.trim() === t).length;
}

/** Pending messages not yet visible in the server feed (poll or response may deliver them first). */
export function reconcilePending(feed: readonly FeedItem[], pending: readonly PendingMessage[], role: Role): PendingMessage[] {
  // Several identical pending texts consume the surplus one at a time.
  const consumed = new Map<string, number>();
  return pending.filter((p) => {
    const have = countOwnWithText(feed, role, p.text);
    const used = consumed.get(p.text) ?? 0;
    const surplus = have - p.baseline - used;
    if (surplus > 0) {
      consumed.set(p.text, used + 1);
      return false;
    }
    return true;
  });
}

export interface SubmitDeps {
  text: string;
  role: Role;
  feed: readonly FeedItem[];
  post: (text: string) => Promise<ConversationView>;
  setPending: (update: (prev: PendingMessage[]) => PendingMessage[]) => void;
  onView: (view: ConversationView) => void;
  newId: () => string;
  now: () => number;
  onError?: (e: unknown) => string;
}

/**
 * Optimistic send: the bubble appears immediately as "sending"; when the server answers with the
 * full view it is dropped (the real message is in the feed), and on failure it stays as "failed"
 * so the user can retry. Returns true when the server accepted the message.
 */
export async function submitOptimistic(d: SubmitDeps, existingId?: string): Promise<boolean> {
  const text = d.text.trim();
  if (!text) return false;
  const clientId = existingId ?? d.newId();
  const entry: PendingMessage = {
    clientId,
    text,
    createdAt: d.now(),
    baseline: countOwnWithText(d.feed, d.role, text),
    status: "sending",
  };
  d.setPending((prev) => (existingId ? prev.map((p) => (p.clientId === clientId ? entry : p)) : [...prev, entry]));
  try {
    const view = await d.post(text);
    d.onView(view);
    d.setPending((prev) => prev.filter((p) => p.clientId !== clientId));
    return true;
  } catch (e) {
    const error = d.onError ? d.onError(e) : e instanceof Error ? e.message : "No se pudo enviar.";
    d.setPending((prev) => prev.map((p) => (p.clientId === clientId ? { ...p, status: "failed", error } : p)));
    return false;
  }
}
