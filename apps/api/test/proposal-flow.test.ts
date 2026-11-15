import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ConfirmProposalResponseSchema,
  ConversationViewSchema,
  type BuyerAgreementView,
  type ConfirmProposalResponse,
  type ConversationView,
} from "@trato/shared";
import { setLlmProviderForTests } from "../src/assistant/provider";
import { settleAssistantTasks } from "../src/assistant/tasks";
import { call, createAgreement, login, seedMock, tokenOf } from "./helpers";
import { buyerRoom, buyerSays, messagesOf, newRoom, roomOf, sellerRoom, sellerSays } from "./assistant-helpers";

beforeAll(seedMock);
afterEach(async () => {
  await settleAssistantTasks();
  setLlmProviderForTests(undefined);
});

const confirm = (cookie: string, room: string, proposalId: string, headers: Record<string, string> = {}) =>
  call(`/api/conversations/${room}/proposals/${proposalId}/confirm`, { method: "POST", cookie, headers });

const accept = (token: string, hash: string, headers: Record<string, string> = {}) =>
  call(`/api/public/tratos/${token}/accept`, { method: "POST", headers, json: { buyerName: "Mariana López", termsSha256: hash, consent: true } });

const proposalsOf = (v: ConversationView) => messagesOf(v).flatMap((m) => (m.proposal ? [m.proposal] : []));

describe("negociación en la sala: propuesta -> acuerdo -> contrapropuesta -> revisión -> aceptación", () => {
  it("flujo completo", async () => {
    const cookie = await login("seller_1");
    const room = await newRoom(cookie);
    await sellerSays(cookie, room, "Puerta de herrería para Mariana, 20 mil, 8 mil para empezar y el resto al instalarla");
    await settleAssistantTasks();
    const v1 = (await sellerRoom(cookie, room)).activeProposal!;
    expect(v1).toMatchObject({ version: 1, status: "OPEN" });

    // 1) confirmar sin acuerdo -> acuerdo SHARED con los montos de la propuesta
    const res = await confirm(cookie, room, v1.id);
    expect(res.status).toBe(200);
    const out = ConfirmProposalResponseSchema.parse(await res.json()) as ConfirmProposalResponse;
    const seller1 = out.conversation;
    ConversationViewSchema.parse(seller1);
    expect(out.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(seller1.conversation.agreementId).not.toBeNull();
    expect(seller1.agreement && "shareUrl" in seller1.agreement ? seller1.agreement.agreement : null).toMatchObject({
      status: "SHARED",
      totalCents: 2_000_000,
      buyerName: "Mariana",
      termsVersion: 1,
    });
    const agreementId = seller1.conversation.agreementId!;
    const milestones = seller1.agreement && "shareUrl" in seller1.agreement ? seller1.agreement.milestones : [];
    expect(milestones.map((m) => m.amountCents)).toEqual([800_000, 1_200_000]);
    expect(seller1.activeProposal).toMatchObject({ id: v1.id, status: "SELLER_CONFIRMED" });
    const token = tokenOf(out.shareUrl);
    const created = seller1.feed.find((f) => f.type === "event" && f.eventType === "AGREEMENT_CREATED");
    expect(created && created.type === "event" ? created.payload.via : null).toBe("chat");
    expect(await roomOf(cookie, agreementId)).toBe(room);

    // confirmar de nuevo (doble clic) -> 409
    expect((await confirm(cookie, room, v1.id)).status).toBe(409);

    // 2) el comprador ve la sala por el enlace (con la negociación previa) y contrapropone
    const b1 = await buyerRoom(token);
    expect(b1.role).toBe("BUYER");
    expect(b1.activeProposal).toMatchObject({ id: v1.id, status: "SELLER_CONFIRMED" });
    expect(messagesOf(b1).map((m) => m.kind)).toEqual(["TEXT", "PROPOSAL"]);
    expect(b1.allowedActions).toContain("ACCEPT_TERMS");
    const said = await buyerSays(token, "¿me lo dejas en 6 mil de anticipo?");
    expect(said.status).toBe(200);
    expect(((await said.json()) as ConversationView).assistantBusy).toBe(true);
    await settleAssistantTasks();
    const b2 = await buyerRoom(token);
    const v2 = b2.activeProposal!;
    expect(v2).toMatchObject({ version: 2, status: "OPEN", terms: { advanceCents: 600_000, totalCents: 2_000_000 } });
    expect(messagesOf(b2).at(-1)).toMatchObject({ kind: "PROPOSAL", authorType: "ASSISTANT" });

    // 3) el prestador confirma la revisión: TERMS_REVISED, terms_version 2, hash nuevo, mismo enlace
    const oldHash = (await (await call(`/api/public/tratos/${token}`)).json() as BuyerAgreementView).agreement.termsSha256;
    const res2 = await confirm(cookie, room, v2.id, { "X-Trato-Via": "web" });
    expect(res2.status).toBe(200);
    const out2 = ConfirmProposalResponseSchema.parse(await res2.json());
    expect(out2.shareUrl).toBe(out.shareUrl);
    const a2 = out2.conversation.agreement && "shareUrl" in out2.conversation.agreement ? out2.conversation.agreement : null;
    expect(a2?.agreement).toMatchObject({ termsVersion: 2, status: "SHARED" });
    expect(a2?.agreement.termsSha256).not.toBe(oldHash);
    expect(a2?.milestones.map((m) => m.amountCents)).toEqual([600_000, 1_400_000]);
    const rev = out2.conversation.feed.find((f) => f.type === "event" && f.eventType === "TERMS_REVISED");
    expect(rev && rev.type === "event" ? rev.payload : null).toMatchObject({ termsVersion: 2, advanceCents: 600_000, via: "web" });
    expect(proposalsOf(out2.conversation).map((p) => [p.version, p.status])).toEqual([[1, "SUPERSEDED"], [2, "SELLER_CONFIRMED"]]);
    expect(out2.conversation.activeProposal?.termsSha256).toBe(a2?.agreement.termsSha256);

    // 4) aceptar con el hash viejo -> 409 TERMS_MISMATCH; con el nuevo -> ACCEPTED y propuesta ACCEPTED
    const bad = await accept(token, oldHash);
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("TERMS_MISMATCH");
    const ok = await accept(token, a2!.agreement.termsSha256, { "X-Trato-Via": "mcp" });
    expect(ok.status).toBe(200);
    const done = await sellerRoom(cookie, room);
    expect(proposalsOf(done).map((p) => [p.version, p.status])).toEqual([[1, "SUPERSEDED"], [2, "ACCEPTED"]]);
    expect(done.activeProposal).toBeNull();
    const acc = done.feed.find((f) => f.type === "event" && f.eventType === "TERMS_ACCEPTED");
    expect(acc && acc.type === "event" ? acc.payload.via : null).toBe("mcp");
    // tras ACCEPTED ya no se puede confirmar ni revisar
    expect((await confirm(cookie, room, v2.id)).status).toBe(409);
    const buyerAfter = await buyerRoom(token);
    expect(buyerAfter.agreement && "seller" in buyerAfter.agreement ? buyerAfter.agreement.agreement.status : null).toBe("ACCEPTED");
  });

  it("acuerdo DRAFT creado por formulario: la sala propone una revisión y al confirmar se revisa y comparte", async () => {
    const cookie = await login("seller_2");
    const created = await createAgreement(cookie);
    const room = await roomOf(cookie, created.agreement.id);
    await sellerSays(cookie, room, "mejor 5 mil de anticipo");
    await settleAssistantTasks();
    const prop = (await sellerRoom(cookie, room)).activeProposal!;
    expect(prop.terms).toMatchObject({ advanceCents: 500_000, totalCents: 1_000_000, buyerName: "Ana Pérez" });
    const out = ConfirmProposalResponseSchema.parse(await (await confirm(cookie, room, prop.id)).json());
    const a = out.conversation.agreement && "shareUrl" in out.conversation.agreement ? out.conversation.agreement : null;
    expect(a?.agreement).toMatchObject({ id: created.agreement.id, status: "SHARED", termsVersion: 2 });
    expect(a?.milestones.map((m) => m.amountCents)).toEqual([500_000, 500_000]);
    expect(out.shareUrl).toContain("/t/");
  });

  it("autorización: otro vendedor 404; propuesta inexistente 404; el comprador no puede confirmar", async () => {
    const cookie = await login("seller_3");
    const room = await newRoom(cookie);
    await sellerSays(cookie, room, "Reja para Luis, 10 mil, 3 mil de anticipo");
    await settleAssistantTasks();
    const p = (await sellerRoom(cookie, room)).activeProposal!;
    const other = await login("seller_4");
    expect((await confirm(other, room, p.id)).status).toBe(404);
    expect((await confirm(cookie, room, "nope")).status).toBe(404);
    expect((await call(`/api/conversations/${room}/proposals/${p.id}/confirm`, { method: "POST" })).status).toBe(401);
    // la propuesta sigue OPEN tras los intentos fallidos
    expect((await sellerRoom(cookie, room)).activeProposal?.status).toBe("OPEN");
  });

  it("si el paso del acuerdo falla, la propuesta vuelve a OPEN", async () => {
    const cookie = await login("seller_5");
    const room = await newRoom(cookie);
    await sellerSays(cookie, room, "Mesa para Rosa, 4 mil, 1 mil de anticipo");
    await settleAssistantTasks();
    const p = (await sellerRoom(cookie, room)).activeProposal!;
    // corrompe el JSON de términos para forzar el fallo después del claim
    await env.DB.prepare("UPDATE proposals SET terms_json = '{\"title\":\"x\"}' WHERE id = ?").bind(p.id).run();
    expect((await confirm(cookie, room, p.id)).status).toBe(500); // datos corruptos: error interno, pero sin estado a medias
    const row = await env.DB.prepare("SELECT status, confirmed_at FROM proposals WHERE id = ?").bind(p.id).first<{ status: string; confirmed_at: number | null }>();
    expect(row).toEqual({ status: "OPEN", confirmed_at: null });
    expect((await env.DB.prepare("SELECT agreement_id FROM conversations WHERE id = ?").bind(room).first<{ agreement_id: string | null }>())?.agreement_id).toBeNull();
  });
});
