import { describe, expect, it } from "vitest";
import type { ConversationView, FeedEvent } from "@trato/shared";
import { conversationNotices, eventNotices, noticesForEvents, type NoticeContext } from "./notices";
import {
  buyerAgreementFixture,
  conversationView,
  eventItem,
  proposal,
  proposalMsg,
  sellerAgreementFixture,
  textMsg,
} from "./test-fixtures";

const seller: NoticeContext = { viewer: "SELLER", otherName: "Mariana", cleaning: true };
const buyer: NoticeContext = { viewer: "BUYER", otherName: "Rosa", cleaning: true };
const ev = (id: string, type: FeedEvent["eventType"], actorType: FeedEvent["actorType"], payload: Record<string, unknown> = {}) => ({
  id,
  type,
  actorType,
  payload,
});

describe("noticesForEvents", () => {
  it("ignores what the viewer did themselves", () => {
    expect(noticesForEvents([ev("1", "TASK_SUBMITTED", "SELLER", { taskTitle: "Baño" })], seller)).toEqual([]);
    expect(noticesForEvents([ev("1", "TASK_APPROVED", "BUYER", { taskTitle: "Baño" })], buyer)).toEqual([]);
  });

  it("tells the seller about an adjustment with the reason and the task", () => {
    const [n] = noticesForEvents(
      [ev("1", "TASK_ADJUSTMENT_REQUESTED", "BUYER", { taskId: "t1", taskTitle: "Limpiar baño", comment: "Faltó el espejo" })],
      seller,
    );
    expect(n).toMatchObject({ tone: "warn", target: "checklist", taskId: "t1" });
    expect(n!.title).toBe("Mariana pidió un ajuste en “Limpiar baño”");
    expect(n!.detail).toContain("Faltó el espejo");
  });

  it("tells the buyer a task is ready, and that a resubmission is the fix", () => {
    const [first] = noticesForEvents([ev("1", "TASK_SUBMITTED", "SELLER", { taskTitle: "Cocina", revision: 1 })], buyer);
    expect(first!.title).toBe("Lista para revisar: “Cocina”");
    expect(first!.detail).toContain("Rosa subió la foto");
    const [again] = noticesForEvents([ev("2", "TASK_SUBMITTED", "SELLER", { taskTitle: "Cocina", revision: 2 })], buyer);
    expect(again!.detail).toContain("hizo el ajuste");
  });

  it("collapses the last approval into «aprobó todo el trabajo» for the seller", () => {
    const out = noticesForEvents(
      [ev("1", "TASK_APPROVED", "BUYER", { taskTitle: "Ventanas" }), ev("2", "ALL_TASKS_APPROVED", "SYSTEM")],
      seller,
    );
    expect(out.map((n) => n.title)).toEqual(["Mariana aprobó todo el trabajo"]);
  });

  it("buyer's own last approval still announces that paying is now possible", () => {
    const out = noticesForEvents(
      [ev("1", "TASK_APPROVED", "BUYER", { taskTitle: "Ventanas" }), ev("2", "ALL_TASKS_APPROVED", "SYSTEM")],
      buyer,
    );
    expect(out).toEqual([expect.objectContaining({ title: "Aprobaste todo el trabajo", target: "payment" })]);
  });

  it("merges payment confirmed + completed, and never says the money was released", () => {
    const out = noticesForEvents(
      [ev("1", "PAYMENT_CONFIRMED", "PROVIDER", { amountCents: 70000, milestoneKind: "BALANCE" }), ev("2", "AGREEMENT_COMPLETED", "SYSTEM")],
      seller,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Trato completado");
    expect(out[0]!.detail).toContain("Pago confirmado: $700.00");
    expect(JSON.stringify(out)).not.toMatch(/libera/i);
  });

  it("caps a burst of changes with a «y N cambios más» line", () => {
    const out = noticesForEvents(
      ["a", "b", "c", "d", "e"].map((t, i) => ev(String(i), "TASK_APPROVED", "BUYER", { taskTitle: t })),
      seller,
    );
    expect(out).toHaveLength(3);
    expect(out[2]!.title).toBe("Y 3 cambios más");
  });
});

describe("eventNotices", () => {
  it("is silent on first load and only announces new events", () => {
    const e1 = ev("1", "TERMS_ACCEPTED", "BUYER");
    expect(eventNotices(null, [e1], seller)).toEqual([]);
    expect(eventNotices([e1], [e1], seller)).toEqual([]);
    const e2 = ev("2", "TASK_APPROVED", "BUYER", { taskTitle: "Baño" });
    expect(eventNotices([e1], [e1, e2], seller).map((n) => n.title)).toEqual(["Mariana aprobó “Baño”"]);
  });
});

describe("conversationNotices", () => {
  const sellerView = (feed: ConversationView["feed"], over: Partial<ConversationView> = {}) =>
    conversationView({ role: "SELLER", feed, agreement: sellerAgreementFixture({ serviceType: "CLEANING" }), ...over });

  it("returns nothing on the first load", () => {
    expect(conversationNotices(null, sellerView([textMsg("m1", 1, 0, "BUYER", "hola")]))).toEqual([]);
  });

  it("announces a message from the other person, not the viewer's own", () => {
    const prev = sellerView([]);
    const mine = sellerView([textMsg("m1", 1, 0, "SELLER", "voy en camino")]);
    expect(conversationNotices(prev, mine)).toEqual([]);
    const theirs = sellerView([textMsg("m2", 2, 1, "BUYER", "¿A qué hora llegas?")]);
    expect(conversationNotices(prev, theirs)).toEqual([
      expect.objectContaining({ title: "Mensaje de Mariana", detail: "“¿A qué hora llegas?”", target: "feed" }),
    ]);
  });

  it("seller: a new proposal version triggered by the client asks to confirm it", () => {
    const p1 = proposal({ id: "p1", version: 1, status: "SELLER_CONFIRMED" });
    const p2 = proposal({ id: "p2", version: 2, status: "OPEN" });
    const base = [proposalMsg("a1", 1, 0, p1)];
    const prev = sellerView(base);
    const next = sellerView([...base, textMsg("m1", 2, 1, "BUYER", "¿Le agregas sacar la basura?"), proposalMsg("a2", 3, 2, p2)]);
    const out = conversationNotices(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: "proposal" });
    expect(out[0]!.title).toContain("propuesta v2");
  });

  it("buyer: the seller confirming the new version says it can be accepted now", () => {
    const view = (feed: ConversationView["feed"]) =>
      conversationView({ role: "BUYER", feed, agreement: buyerAgreementFixture({ serviceType: "CLEANING" }) });
    const confirmed = { ...eventItem("e1", 1, 3, "TERMS_REVISED"), actorType: "SELLER" as const };
    const out = conversationNotices(view([]), view([confirmed]));
    expect(out[0]).toMatchObject({ title: "Luis confirmó la nueva versión", target: "proposal" });
  });
});
