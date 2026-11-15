import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { BuyerAgreementView, ConversationView, ListConversationsResponse } from "@trato/shared";
import { call, createAgreement, login, newSharedAgreement, seedMock } from "./helpers";

beforeAll(seedMock);

const room = async (cookie: string, id: string, headers: Record<string, string> = {}) =>
  call(`/api/conversations/${id}`, { cookie, headers });

describe("salas: creación, lista y lectura", () => {
  it("crea una sala vacía y la lista", async () => {
    const cookie = await login("seller_3");
    const res = await call("/api/conversations", { method: "POST", cookie });
    expect(res.status).toBe(201);
    const view = (await res.json()) as ConversationView;
    expect(view.role).toBe("SELLER");
    expect(view.feed).toEqual([]);
    expect(view.agreement).toBeNull();
    expect(view.activeProposal).toBeNull();
    expect(view.assistantBusy).toBe(false);
    expect(view.assistant).toEqual({ enabled: true, provider: "mock", model: "mock-rules-v1" });
    const list = (await (await call("/api/conversations", { cookie })).json()) as ListConversationsResponse;
    expect(list.conversations.some((c) => c.id === view.conversation.id && c.title === null && c.agreementId === null)).toBe(true);
  });

  it("el flujo de formulario también crea su conversación y la lista muestra el estado del trato", async () => {
    const cookie = await login("seller_4");
    const created = await createAgreement(cookie);
    const list = (await (await call("/api/conversations", { cookie })).json()) as ListConversationsResponse;
    const conv = list.conversations.find((c) => c.agreementId === created.agreement.id);
    expect(conv).toMatchObject({ agreementCode: created.agreement.code, agreementStatus: "DRAFT", nextAction: "SHARE", title: "Portón de herrería" });
    const view = (await (await room(cookie, conv!.id)).json()) as ConversationView;
    expect(view.agreement && "shareUrl" in view.agreement).toBe(true);
    // evento de creación en el feed
    expect(view.feed.some((f) => f.type === "event" && f.eventType === "AGREEMENT_CREATED")).toBe(true);
    expect(view.allowedActions).toContain("SHARE_LINK");
  });

  it("acuerdos previos sin conversación la reciben de forma perezosa (lista y comprador)", async () => {
    const s = await newSharedAgreement("seller_5");
    await env.DB.prepare("DELETE FROM conversations WHERE agreement_id = ?").bind(s.id).run();
    const buyer = await call(`/api/public/tratos/${s.token}/conversation`);
    expect(buyer.status).toBe(200);
    const bv = (await buyer.json()) as ConversationView;
    expect(bv.role).toBe("BUYER");
    expect(bv.agreement && "seller" in bv.agreement).toBe(true);
    await env.DB.prepare("DELETE FROM conversations WHERE agreement_id = ?").bind(s.id).run();
    const list = (await (await call("/api/conversations", { cookie: s.cookie })).json()) as ListConversationsResponse;
    expect(list.conversations.some((c) => c.agreementId === s.id)).toBe(true);
  });

  it("otro vendedor no ve la sala (404) y sin sesión 401", async () => {
    const owner = await login("seller_1");
    const view = (await (await call("/api/conversations", { method: "POST", cookie: owner })).json()) as ConversationView;
    const other = await login("seller_2");
    expect((await room(other, view.conversation.id)).status).toBe(404);
    expect((await call(`/api/conversations/${view.conversation.id}`)).status).toBe(401);
  });

  it("ETag / 304 en la sala del vendedor y del comprador; cambia al avanzar el trato", async () => {
    const s = await newSharedAgreement("seller_2");
    const conv = (await (await call("/api/conversations", { cookie: s.cookie })).json()) as ListConversationsResponse;
    const id = conv.conversations.find((c) => c.agreementId === s.id)!.id;
    const first = await room(s.cookie, id);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"c\d+-a\d+-w\d+"$/);
    expect((await room(s.cookie, id, { "If-None-Match": etag })).status).toBe(304);

    const b1 = await call(`/api/public/tratos/${s.token}/conversation`);
    const bTag = b1.headers.get("etag")!;
    expect((await call(`/api/public/tratos/${s.token}/conversation`, { headers: { "If-None-Match": bTag } })).status).toBe(304);

    const view = (await (await call(`/api/public/tratos/${s.token}`)).json()) as BuyerAgreementView;
    await call(`/api/public/tratos/${s.token}/accept`, { method: "POST", json: { buyerName: "Ana", termsSha256: view.agreement.termsSha256, consent: true } });
    const after = await call(`/api/public/tratos/${s.token}/conversation`, { headers: { "If-None-Match": bTag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(bTag);
  });

  it("el dueño de la sala no puede leerla como comprador oculto: el comprador no ve eventos ocultos", async () => {
    const s = await newSharedAgreement("seller_3");
    await env.DB.prepare(
      "INSERT INTO agreement_events (id, agreement_id, seq, event_type, actor_type, payload_json, occurred_at) VALUES ('ev_hidden', ?, 99, 'PAYMENT_UNMATCHED', 'SYSTEM', '{}', 5)",
    ).bind(s.id).run();
    const bv = (await (await call(`/api/public/tratos/${s.token}/conversation`)).json()) as ConversationView;
    expect(bv.feed.some((f) => f.type === "event" && f.eventType === "PAYMENT_UNMATCHED")).toBe(false);
    const list = (await (await call("/api/conversations", { cookie: s.cookie })).json()) as ListConversationsResponse;
    const sv = (await (await call(`/api/conversations/${list.conversations.find((c) => c.agreementId === s.id)!.id}`, { cookie: s.cookie })).json()) as ConversationView;
    expect(sv.feed.some((f) => f.type === "event" && f.eventType === "PAYMENT_UNMATCHED")).toBe(true);
  });
});
