import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfirmProposalResponseSchema } from "@trato/shared";
import { setLlmProviderForTests } from "../src/assistant/provider";
import { settleAssistantTasks } from "../src/assistant/tasks";
import { call, createAgreement, login, seedMock, tokenOf } from "./helpers";
import { buyerRoom, buyerSays, newRoom, roomOf, sellerRoom, sellerSays } from "./assistant-helpers";

beforeAll(seedMock);
afterEach(async () => {
  await settleAssistantTasks();
  setLlmProviderForTests(undefined);
});

const confirm = (cookie: string, room: string, proposalId: string) =>
  call(`/api/conversations/${room}/proposals/${proposalId}/confirm`, { method: "POST", cookie });

async function negotiated() {
  const cookie = await login("seller_1");
  const room = await newRoom(cookie);
  await sellerSays(cookie, room, "Puerta de herrería para Mariana, 20 mil, 8 mil para empezar y el resto al instalarla");
  await settleAssistantTasks();
  const v1 = (await sellerRoom(cookie, room)).activeProposal!;
  const out = ConfirmProposalResponseSchema.parse(await (await confirm(cookie, room, v1.id)).json());
  const token = tokenOf(out.shareUrl);
  const counter = "¿me lo dejas en 6 mil de anticipo? <script>alert(1)</script>";
  await buyerSays(token, counter);
  await settleAssistantTasks();
  const v2 = (await buyerRoom(token)).activeProposal!;
  const out2 = ConfirmProposalResponseSchema.parse(await (await confirm(cookie, room, v2.id)).json());
  const hash = out2.conversation.activeProposal!.termsSha256;
  const acc = await call(`/api/public/tratos/${token}/accept`, { method: "POST", json: { buyerName: "Mariana López", termsSha256: hash, consent: true } });
  expect(acc.status).toBe(200);
  return { cookie, token, agreementId: out2.conversation.conversation.agreementId!, hash };
}

describe("export con conversación y versiones de propuesta", () => {
  it("prestador y comprador: ambas versiones, la aceptada, la contrapropuesta, etiqueta IA y escapado", async () => {
    const s = await negotiated();
    const seller = await (await call(`/api/agreements/${s.agreementId}/export`, { cookie: s.cookie })).text();
    const buyer = await (await call(`/api/public/tratos/${s.token}/export`)).text();
    for (const html of [seller, buyer]) {
      expect(html).toContain("Versiones de la propuesta");
      expect(html).toContain("Versión 1");
      expect(html).toContain("Versión 2");
      expect(html).toContain("Reemplazada por una versión posterior");
      expect(html).toContain("Aceptada por el comprador");
      expect(html).toContain("propuesta aceptada");
      expect(html).toContain(s.hash);
      expect(html).toContain("<h2>Conversación</h2>");
      expect(html).toContain("¿me lo dejas en 6 mil de anticipo?");
      expect(html).toContain("Comprador");
      expect(html).toContain("Prestador");
      expect(html).toContain("Trato (asistente IA)");
      expect(html).toContain("Asistente IA: propone, no decide");
      expect(html).toContain("(hora CDMX)");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html.match(/<script/g)).toHaveLength(1);
    }
  });

  it("acuerdo creado por formulario (sin sala previa) exporta sin error", async () => {
    const cookie = await login("seller_2");
    const created = await createAgreement(cookie);
    const res = await call(`/api/agreements/${created.agreement.id}/export`, { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sin versiones de propuesta registradas.");
    expect(html).toContain("Sin conversación registrada.");
    expect(await roomOf(cookie, created.agreement.id)).toBeTruthy();
  });
});
