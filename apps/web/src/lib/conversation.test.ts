import { describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@trato/shared";
import { createApiClient, ApiError } from "./api";
import { parseCriteria } from "./criteria";
import { isMissingEndpoint } from "./endpoint";
import { POLL_BUSY_MS, POLL_FAST_MS, POLL_SLOW_MS, pollInterval } from "./polling";
import {
  activeCards,
  chipsFromActions,
  chipTargetCard,
  conversationPollState,
  groupFeed,
  proposalCardModel,
  reconcilePending,
  sortFeed,
  submitOptimistic,
  supersededByVersion,
  type PendingMessage,
} from "./conversation";
import {
  actions,
  buyerAgreementFixture,
  conversationView,
  eventItem,
  proposal,
  proposalMsg,
  sellerAgreementFixture,
  textMsg,
} from "./test-fixtures";

describe("feed order and grouping", () => {
  it("sorts by occurredAt, messages before events at the same instant, then seq", () => {
    const feed = [
      eventItem("e1", 1, 2, "AGREEMENT_SHARED"),
      textMsg("m2", 2, 1, "BUYER", "hola"),
      textMsg("m1", 1, 1, "SELLER", "buenas"),
      textMsg("m3", 3, 2, "ASSISTANT", "listo"),
    ];
    expect(sortFeed(feed).map((i) => i.id)).toEqual(["m1", "m2", "m3", "e1"]);
  });

  it("groups consecutive messages by author within 5 minutes; events and proposals break groups", () => {
    const p = proposal();
    const feed = [
      textMsg("m1", 1, 0, "SELLER", "uno"),
      textMsg("m2", 2, 1, "SELLER", "dos"),
      textMsg("m3", 3, 8, "SELLER", "tres, mucho después"),
      proposalMsg("m4", 4, 9, p),
      textMsg("m5", 5, 10, "SELLER", "cuatro"),
      eventItem("e1", 1, 11, "AGREEMENT_SHARED"),
      textMsg("m6", 6, 12, "SELLER", "cinco"),
      textMsg("m7", 7, 12, "BUYER", "seis"),
    ];
    const g = groupFeed(feed);
    expect(g.map((e) => e.kind)).toEqual(["messages", "messages", "proposal", "messages", "event", "messages", "messages"]);
    expect(g[0]?.kind === "messages" && g[0].items.map((i) => i.id)).toEqual(["m1", "m2"]);
  });

  it("finds the version that replaced a proposal", () => {
    const feed = [proposalMsg("a", 1, 0, proposal({ version: 1 })), proposalMsg("b", 2, 5, proposal({ id: "p2", version: 2 }))];
    expect(supersededByVersion(feed, { version: 1 })).toBe(2);
    expect(supersededByVersion([], { version: 3 })).toBe(4);
  });
});

describe("proposal card model", () => {
  const base = { agreementStatus: null, isActive: true, supersededBy: 2 } as const;

  it("seller with an open active proposal sees «Confirmo y compartir»", () => {
    const m = proposalCardModel(proposal(), { ...base, role: "SELLER", allowedActions: actions("CONFIRM_PROPOSAL") });
    expect(m.primary).toBe("CONFIRM_AND_SHARE");
    expect(m.dimmed).toBe(false);
  });

  it("seller cannot confirm when the guard does not allow it", () => {
    const m = proposalCardModel(proposal(), { ...base, role: "SELLER", allowedActions: [] });
    expect(m.primary).toBeNull();
  });

  it("buyer sees accept only for SELLER_CONFIRMED + SHARED, with the «sí» note", () => {
    const sc = proposal({ status: "SELLER_CONFIRMED" });
    const ok = proposalCardModel(sc, { ...base, role: "BUYER", agreementStatus: "SHARED", allowedActions: actions("ACCEPT_TERMS") });
    expect(ok.primary).toBe("ACCEPT");
    expect(ok.showYesNote).toBe(true);
    const draft = proposalCardModel(proposal(), { ...base, role: "BUYER", allowedActions: [] });
    expect(draft.primary).toBeNull();
    expect(draft.banner).toMatch(/confirmar/);
    const accepted = proposalCardModel(sc, { ...base, role: "BUYER", agreementStatus: "ACCEPTED", allowedActions: [] });
    expect(accepted.primary).toBeNull();
  });

  it("seller sees waiting banner and re-share on SELLER_CONFIRMED", () => {
    const m = proposalCardModel(proposal({ status: "SELLER_CONFIRMED" }), {
      ...base,
      role: "SELLER",
      agreementStatus: "SHARED",
      allowedActions: actions("SHARE_LINK"),
    });
    expect(m.primary).toBe("SHARE_AGAIN");
    expect(m.banner).toMatch(/Esperando/);
  });

  it("SUPERSEDED is dimmed, struck through, has no actions and names the replacement", () => {
    const m = proposalCardModel(proposal({ status: "SUPERSEDED" }), {
      ...base,
      isActive: false,
      role: "SELLER",
      allowedActions: actions("CONFIRM_PROPOSAL"),
      supersededBy: 3,
    });
    expect(m).toMatchObject({ primary: null, dimmed: true, strike: true, banner: "Reemplazada por la versión 3" });
  });
});

describe("action chips", () => {
  it("come from allowedActions with the shared labels, in order, without duplicates", () => {
    const chips = chipsFromActions(["UPLOAD_EVIDENCE", "REQUEST_REVIEW", "EXPORT", "EXPORT"]);
    expect(chips.map((c) => c.label)).toEqual(["Subir fotos", "Ya terminé", "Descargar comprobante"]);
    expect(chips.map((c) => c.primary)).toEqual([true, true, false]);
    expect(chipsFromActions([])).toEqual([]);
  });

  it("route to the matching dock card", () => {
    const sellerView = conversationView({
      role: "SELLER",
      activeProposal: proposal(),
      allowedActions: actions("CONFIRM_PROPOSAL"),
    });
    const cards = activeCards(sellerView);
    expect(cards).toEqual([{ kind: "proposal" }]);
    expect(chipTargetCard("CONFIRM_PROPOSAL", cards)).toBe("proposal");
    expect(chipTargetCard("EXPORT", cards)).toBeNull();
  });

  it("buyer cards: pay balance and review appear from the buyer's state", () => {
    const view = conversationView({
      role: "BUYER",
      agreement: buyerAgreementFixture({ nextAction: "REVIEW" }),
      allowedActions: actions("APPROVE_DELIVERY", "DISPUTE_DELIVERY", "EXPORT"),
    });
    expect(activeCards(view).map((c) => c.kind)).toEqual(["delivery"]);
    const pay = conversationView({
      role: "BUYER",
      agreement: buyerAgreementFixture({ nextAction: "PAY_BALANCE" }),
      allowedActions: actions("PAY_BALANCE"),
    });
    expect(activeCards(pay)).toEqual([{ kind: "payment", milestone: "BALANCE" }]);
  });

  it("seller sees the deliver card, or the dispute card after a dispute", () => {
    const deliver = conversationView({
      agreement: sellerAgreementFixture({ nextAction: "UPLOAD_EVIDENCE" }),
      allowedActions: actions("UPLOAD_EVIDENCE"),
    });
    expect(activeCards(deliver).map((c) => c.kind)).toEqual(["deliver"]);
    const dispute = conversationView({
      agreement: sellerAgreementFixture({ nextAction: "RESOLVE_DISPUTE" }),
      allowedActions: actions("UPLOAD_EVIDENCE", "REDELIVER"),
    });
    expect(activeCards(dispute).map((c) => c.kind)).toEqual(["dispute"]);
  });
});

describe("polling interval", () => {
  it("1.5 s busy, 3 s pending payment, 15 s idle, paused when hidden", () => {
    expect(pollInterval({ awaitingPayment: false, hidden: false, busy: true })).toBe(POLL_BUSY_MS);
    expect(pollInterval({ awaitingPayment: true, hidden: false })).toBe(POLL_FAST_MS);
    expect(pollInterval({ awaitingPayment: false, hidden: false })).toBe(POLL_SLOW_MS);
    expect(pollInterval({ awaitingPayment: true, hidden: true, busy: true })).toBeNull();
    expect(POLL_BUSY_MS).toBe(1500);
  });

  it("derives busy / awaitingPayment from the view", () => {
    expect(conversationPollState(null)).toEqual({ awaitingPayment: false, busy: false });
    expect(conversationPollState(conversationView({ assistantBusy: true })).busy).toBe(true);
    const pr = {
      id: "pr", milestoneId: "m", milestoneKind: "ADVANCE", method: "CODI_QR", status: "AWAITING_PAYMENT",
      amountCents: 1, numRef: "1", qrString: null, phoneLast4: null, expiresAt: null, createdAt: "2026-11-14T10:00:00.000Z", paidAt: null,
    } as const;
    const v = conversationView({ role: "BUYER", agreement: buyerAgreementFixture({ activePaymentRequest: pr }) });
    expect(conversationPollState(v).awaitingPayment).toBe(true);
    const s = conversationView({ agreement: sellerAgreementFixture({ paymentRequests: [pr] }) });
    expect(conversationPollState(s).awaitingPayment).toBe(true);
  });
});

describe("optimistic send", () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });

  function harness(fetchMock: ReturnType<typeof vi.fn>, feed: ConversationView["feed"] = []) {
    const client = createApiClient(fetchMock);
    let pending: PendingMessage[] = [];
    const snapshots: PendingMessage[][] = [];
    const views: ConversationView[] = [];
    let n = 0;
    const deps = (text: string) => ({
      text,
      role: "SELLER" as const,
      feed,
      post: (t: string) => client.postMessage("c1", t),
      setPending: (u: (p: PendingMessage[]) => PendingMessage[]) => {
        pending = u(pending);
        snapshots.push(pending);
      },
      onView: (v: ConversationView) => views.push(v),
      newId: () => `id${++n}`,
      now: () => 1000,
    });
    return { deps, snapshots, views, get pending() { return pending; } };
  }

  it("shows the bubble immediately and drops it when the server answers", async () => {
    const served = conversationView({ feed: [textMsg("m1", 1, 0, "SELLER", "Puerta para Mariana")] });
    const fetchMock = vi.fn().mockResolvedValue(json(served));
    const h = harness(fetchMock);
    const ok = await submitOptimistic(h.deps("  Puerta para Mariana "));
    expect(ok).toBe(true);
    expect(h.snapshots[0]).toMatchObject([{ text: "Puerta para Mariana", status: "sending", baseline: 0 }]);
    expect(h.pending).toEqual([]);
    expect(h.views).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/conversations/c1/messages");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Puerta para Mariana" });
  });

  it("keeps a failed bubble for retry, then reconciles on success", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json(conversationView()));
    const h = harness(fetchMock);
    expect(await submitOptimistic(h.deps("hola"))).toBe(false);
    expect(h.pending).toMatchObject([{ clientId: "id1", status: "failed" }]);
    expect(h.pending[0]?.error).toBeTruthy();
    expect(await submitOptimistic(h.deps("hola"), "id1")).toBe(true);
    expect(h.pending).toEqual([]);
  });

  it("does not post empty text", async () => {
    const fetchMock = vi.fn();
    const h = harness(fetchMock);
    expect(await submitOptimistic(h.deps("   "))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconcilePending hides pending messages that a poll already delivered", () => {
    const pending: PendingMessage = { clientId: "x", text: "hola", createdAt: 1, baseline: 1, status: "sending" };
    const before = [textMsg("m1", 1, 0, "SELLER", "hola")];
    expect(reconcilePending(before, [pending], "SELLER")).toHaveLength(1);
    const after = [...before, textMsg("m2", 2, 1, "SELLER", "hola")];
    expect(reconcilePending(after, [pending], "SELLER")).toHaveLength(0);
    // A message by the other party with the same text does not count.
    const other = [...before, textMsg("m3", 3, 1, "BUYER", "hola")];
    expect(reconcilePending(other, [pending], "SELLER")).toHaveLength(1);
  });
});

describe("criteria checklist parser", () => {
  it("splits by commas, semicolons and newlines", () => {
    expect(parseCriteria("Medidas 90x210, pintura negra; chapa instalada\nSin rebabas")).toEqual([
      "Medidas 90x210",
      "pintura negra",
      "chapa instalada",
      "Sin rebabas",
    ]);
  });

  it("strips bullets, numbering and duplicates; splits sentences", () => {
    expect(parseCriteria("- Pintura negra\n2) Chapa instalada\n• pintura negra")).toEqual(["Pintura negra", "Chapa instalada"]);
    expect(parseCriteria("Queda nivelada. Se entrega limpia.")).toEqual(["Queda nivelada", "Se entrega limpia"]);
    expect(parseCriteria("  \n ; , ")).toEqual([]);
  });
});

describe("missing endpoint detection", () => {
  it("treats bare 404, 405, 501 and HTML as missing; envelope 404 as a real not found", () => {
    expect(isMissingEndpoint(new ApiError("INTERNAL", "Error 404", 404))).toBe(true);
    expect(isMissingEndpoint(new ApiError("INTERNAL", "Error 501", 501))).toBe(true);
    expect(isMissingEndpoint(new ApiError("BAD_RESPONSE", "x", 200))).toBe(true);
    expect(isMissingEndpoint(new ApiError("NOT_FOUND", "No existe", 404))).toBe(false);
    expect(isMissingEndpoint(new ApiError("NETWORK", "x"))).toBe(false);
  });
});
