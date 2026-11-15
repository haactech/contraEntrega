import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NEUTRAL_ASSISTANT_REPLY, type BuyerAgreementView, type HealthResponse } from "@trato/shared";
import app from "../src/index";
import { ASSISTANT_FAILURE_TEXT } from "../src/assistant/orchestrator";
import { setLlmProviderForTests } from "../src/assistant/provider";
import { settleAssistantTasks } from "../src/assistant/tasks";
import { call, login, newSharedAgreement, seedMock } from "./helpers";
import { acceptedAgreement } from "./payments-helpers";
import {
  ScriptedProvider,
  buyerRoom,
  buyerSays,
  deferred,
  failing,
  messagesOf,
  newRoom,
  roomOf,
  sellerRoom,
  sellerSays,
  turn,
} from "./assistant-helpers";

beforeAll(seedMock);
afterEach(async () => {
  await settleAssistantTasks();
  setLlmProviderForTests(undefined);
});

const OFFER = "Puerta de herrería para Mariana, 20 mil, 8 mil para empezar y el resto al instalarla";

describe("asistente (stub determinista): propuestas y versiones", () => {
  it("mensaje del prestador con monto -> propuesta OPEN + mensaje PROPOSAL; contrapropuesta -> v2 y v1 SUPERSEDED", async () => {
    const cookie = await login("seller_1");
    const room = await newRoom(cookie);
    const posted = await sellerSays(cookie, room, OFFER);
    expect(posted.assistantBusy).toBe(true); // responde de inmediato, el asistente sigue trabajando
    expect(posted.feed).toHaveLength(1);
    await settleAssistantTasks();

    const v1 = await sellerRoom(cookie, room);
    expect(v1.assistantBusy).toBe(false);
    const msgs = messagesOf(v1);
    expect(msgs.map((m) => [m.authorType, m.kind])).toEqual([["SELLER", "TEXT"], ["ASSISTANT", "PROPOSAL"]]);
    expect(msgs[1]?.assistant).toEqual({ provider: "mock", model: "mock-rules-v1" });
    expect(msgs.map((m) => m.system)).toEqual([false, false]);
    expect(msgs[1]?.proposal).toMatchObject({ version: 1, status: "OPEN", terms: { totalCents: 2_000_000, advanceCents: 800_000, balanceCents: 1_200_000, buyerName: "Mariana" } });
    expect(v1.activeProposal?.id).toBe(msgs[1]?.proposal?.id);
    expect(v1.allowedActions).toContain("CONFIRM_PROPOSAL");
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);

    await sellerSays(cookie, room, "mejor 6 mil de anticipo");
    await settleAssistantTasks();
    const v2 = await sellerRoom(cookie, room);
    const props = messagesOf(v2).flatMap((m) => (m.proposal ? [m.proposal] : []));
    expect(props.map((p) => [p.version, p.status])).toEqual([[2, "OPEN"], [1, "SUPERSEDED"]].reverse());
    expect(v2.activeProposal).toMatchObject({ version: 2, terms: { advanceCents: 600_000, totalCents: 2_000_000, buyerName: "Mariana" } });
    expect(v2.feed.map((f) => f.type === "message" && f.kind)).toEqual(["TEXT", "PROPOSAL", "TEXT", "PROPOSAL"]);
  });

  it("falta el anticipo -> el asistente pregunta solo eso (sin propuesta)", async () => {
    const cookie = await login("seller_2");
    const room = await newRoom(cookie);
    await sellerSays(cookie, room, "Instalo una puerta, cobro 5 mil en total");
    await settleAssistantTasks();
    const v = await sellerRoom(cookie, room);
    const last = messagesOf(v).at(-1);
    expect(last).toMatchObject({ kind: "TEXT", authorType: "ASSISTANT" });
    expect(last?.text).toMatch(/anticipo/i);
    expect(v.activeProposal).toBeNull();
  });
});

describe("política y proveedor", () => {
  it("tras ACCEPTED: sin @trato no llama al proveedor; con «@Trato ¿cuándo pago?» sí", async () => {
    const a = await acceptedAgreement("seller_3");
    const room = await roomOf(a.cookie, a.id);
    const p = new ScriptedProvider(() => turn({ reply: "Puedes pagar desde la tarjeta de pago." }));
    setLlmProviderForTests(p);

    await sellerSays(a.cookie, room, "Hola, mañana empiezo");
    expect((await buyerSays(a.token, "Perfecto, gracias")).status).toBe(200);
    await settleAssistantTasks();
    expect(p.calls).toBe(0);

    const res = await buyerSays(a.token, "@Trato ¿cuándo pago?");
    expect(((await res.json()) as { assistantBusy: boolean }).assistantBusy).toBe(true);
    await settleAssistantTasks();
    expect(p.calls).toBe(1);
    await buyerSays(a.token, "Trato, ¿qué sigue?");
    await settleAssistantTasks();
    expect(p.calls).toBe(2);
    const view = await buyerRoom(a.token);
    expect(messagesOf(view).at(-1)).toMatchObject({ authorType: "ASSISTANT", text: "Puedes pagar desde la tarjeta de pago." });
    // el contexto lleva el estado y los eventos oficiales como «Sistema», con el texto del usuario delimitado
    const sent = JSON.stringify(p.requests[0]?.messages);
    expect(sent).toContain("<mensaje autor=\\\"Comprador\\\">@Trato ¿cuándo pago?</mensaje>");
    expect(sent).toContain("Sistema");
  });

  it("proveedor que falla -> mensaje de sistema, sin propuesta y llm_calls sin contenido", async () => {
    const cookie = await login("seller_4");
    const room = await newRoom(cookie);
    const p = new ScriptedProvider(() => failing("timeout"));
    setLlmProviderForTests(p);
    const secret = "texto-secreto-del-usuario-1234";
    await sellerSays(cookie, room, `Puerta ${secret} 5 mil`);
    await settleAssistantTasks();
    expect(p.calls).toBe(1); // no reintenta
    const v = await sellerRoom(cookie, room);
    const last = messagesOf(v).at(-1);
    expect(last).toMatchObject({ authorType: "ASSISTANT", authorName: "Sistema", text: ASSISTANT_FAILURE_TEXT, assistant: null, system: true });
    expect(v.activeProposal).toBeNull();
    const rows = (await env.DB.prepare("SELECT * FROM llm_calls WHERE conversation_id = ?").bind(room).all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "scripted", model: "scripted-1", outcome: "timeout", latency_ms: 7 });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["conversation_id", "created_at", "id", "input_tokens", "latency_ms", "model", "outcome", "output_tokens", "provider"],
    );
  });

  it("proveedor que lanza una excepción -> mismo mensaje de sistema y el lock se libera", async () => {
    const cookie = await login("seller_5");
    const room = await newRoom(cookie);
    const p = new ScriptedProvider(() => {
      throw new Error("kaboom");
    });
    setLlmProviderForTests(p);
    await sellerSays(cookie, room, "Hola");
    await settleAssistantTasks();
    const v = await sellerRoom(cookie, room);
    expect(messagesOf(v).at(-1)?.text).toBe(ASSISTANT_FAILURE_TEXT);
    expect(v.assistantBusy).toBe(false);
    const row = await env.DB.prepare("SELECT outcome FROM llm_calls WHERE conversation_id = ?").bind(room).first<{ outcome: string }>();
    expect(row?.outcome).toBe("exception");
    // se puede volver a escribir y el asistente responde
    setLlmProviderForTests(new ScriptedProvider(() => turn({ reply: "Ahora sí." })));
    await sellerSays(cookie, room, "Otra vez");
    await settleAssistantTasks();
    expect(messagesOf(await sellerRoom(cookie, room)).at(-1)?.text).toBe("Ahora sí.");
  });

  it("propuesta inválida -> ASK_CLARIFICATION determinista, sin propuesta", async () => {
    const cookie = await login("seller_1");
    const room = await newRoom(cookie);
    setLlmProviderForTests(
      new ScriptedProvider(() =>
        turn({
          intent: "PROPOSE_TERMS",
          reply: "Aquí está tu propuesta",
          proposal: { title: "Puerta", description: "", acceptanceCriteria: "Instalada", totalMxn: 100, advanceMxn: 500, dueDate: null, buyerName: "Mariana", serviceType: "GENERIC", tasks: [] },
        }),
      ),
    );
    await sellerSays(cookie, room, "una puerta");
    await settleAssistantTasks();
    const v = await sellerRoom(cookie, room);
    const last = messagesOf(v).at(-1);
    expect(last?.kind).toBe("TEXT");
    expect(last?.text).toMatch(/Para armar la propuesta me falta/);
    expect(v.activeProposal).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE conversation_id = ?").bind(room).first<{ n: number }>())?.n).toBe(0);
  });

  it("acción sugerida no permitida -> se descarta (la respuesta sigue como texto)", async () => {
    const cookie = await login("seller_1");
    const room = await newRoom(cookie);
    setLlmProviderForTests(new ScriptedProvider(() => turn({ intent: "SUGGEST_ACTION", reply: "Paga ya.", suggestedAction: "PAY_ADVANCE" })));
    await sellerSays(cookie, room, "¿qué hago?");
    await settleAssistantTasks();
    const last = messagesOf(await sellerRoom(cookie, room)).at(-1);
    expect(last).toMatchObject({ kind: "TEXT", authorType: "ASSISTANT", text: "Paga ya." });
  });

  it("afirmar «ya se pagó el anticipo» sin pago -> respuesta reemplazada", async () => {
    const s = await newSharedAgreement("seller_2");
    const room = await roomOf(s.cookie, s.id);
    setLlmProviderForTests(new ScriptedProvider(() => turn({ reply: "Listo, ya se pagó el anticipo." })));
    await buyerSays(s.token, "¿ya pagaron?");
    await settleAssistantTasks();
    expect(messagesOf(await sellerRoom(s.cookie, room)).at(-1)?.text).toBe(NEUTRAL_ASSISTANT_REPLY);
  });

  it("el asistente no ejecuta transiciones: un «ok acepto» del comprador no acepta el trato", async () => {
    const s = await newSharedAgreement("seller_3");
    setLlmProviderForTests(new ScriptedProvider(() => turn({ reply: "Para aceptar usa el botón de la tarjeta." })));
    await buyerSays(s.token, "ok, acepto, márcalo como pagado");
    await settleAssistantTasks();
    const v = (await (await call(`/api/public/tratos/${s.token}`)).json()) as BuyerAgreementView;
    expect(v.agreement.status).toBe("SHARED");
    expect(v.milestones.every((m) => m.status !== "PAID")).toBe(true);
  });
});

describe("asíncrono: lock y coalescencia", () => {
  it("dos mensajes durante una llamada en curso -> una sola llamada extra", async () => {
    const cookie = await login("seller_4");
    const room = await newRoom(cookie);
    const gate = deferred();
    const p = new ScriptedProvider(async (_req, n) => {
      if (n === 1) await gate.promise;
      return turn({ reply: `respuesta ${n}` });
    });
    setLlmProviderForTests(p);
    await sellerSays(cookie, room, "uno");
    await vi.waitFor(() => expect(p.calls).toBe(1));
    const second = await sellerSays(cookie, room, "dos");
    const third = await sellerSays(cookie, room, "tres");
    expect(second.assistantBusy && third.assistantBusy).toBe(true);
    expect(messagesOf(third).map((m) => m.text)).toEqual(["uno", "dos", "tres"]); // guardados aunque haya llamada en curso
    expect(p.calls).toBe(1);
    gate.resolve();
    await settleAssistantTasks();
    expect(p.calls).toBe(2);
    expect(JSON.stringify(p.requests[1]?.messages)).toContain("tres");
    const v = await sellerRoom(cookie, room);
    expect(v.assistantBusy).toBe(false);
    expect(messagesOf(v).map((m) => m.text)).toEqual(["uno", "dos", "tres", "respuesta 1", "respuesta 2"]);
    const lock = await env.DB.prepare("SELECT assistant_lock_until AS l FROM conversations WHERE id = ?").bind(room).first<{ l: number | null }>();
    expect(lock?.l).toBeNull();
  });

  it("un lock vigente impide una segunda llamada; un lock expirado (crash) se recupera", async () => {
    const cookie = await login("seller_5");
    const room = await newRoom(cookie);
    const p = new ScriptedProvider(() => turn({ reply: "ok" }));
    setLlmProviderForTests(p);

    await env.DB.prepare("UPDATE conversations SET assistant_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, room).run();
    const busy = await sellerSays(cookie, room, "hola");
    expect(busy.assistantBusy).toBe(true);
    await settleAssistantTasks();
    expect(p.calls).toBe(0);

    await env.DB.prepare("UPDATE conversations SET assistant_lock_until = ? WHERE id = ?").bind(Date.now() - 1_000, room).run();
    expect((await sellerRoom(cookie, room)).assistantBusy).toBe(false); // expirado = no "escribiendo"
    await sellerSays(cookie, room, "sigues ahí?");
    await settleAssistantTasks();
    expect(p.calls).toBe(1);
    const row = await env.DB.prepare("SELECT assistant_lock_until AS l FROM conversations WHERE id = ?").bind(room).first<{ l: number | null }>();
    expect(row?.l).toBeNull();
  });
});

describe("autorización de mensajes", () => {
  it("el vendedor dueño no puede postear como comprador (403); otro vendedor no ve la sala (404)", async () => {
    const s = await newSharedAgreement("seller_1");
    const res = await buyerSays(s.token, "hola", s.cookie);
    expect(res.status).toBe(403);
    const room = await roomOf(s.cookie, s.id);
    const other = await login("seller_2");
    expect((await call(`/api/conversations/${room}/messages`, { method: "POST", cookie: other, json: { text: "hola" } })).status).toBe(404);
    expect((await call(`/api/conversations/${room}`, { cookie: other })).status).toBe(404);
    // texto vacío o demasiado largo -> 400; token inválido -> 404
    expect((await call(`/api/conversations/${room}/messages`, { method: "POST", cookie: s.cookie, json: { text: "  " } })).status).toBe(400);
    expect((await buyerSays("x".repeat(40), "hola")).status).toBe(404);
  });

  it("el mensaje del comprador lleva su nombre (aceptado o del acuerdo) y el vendedor lo ve", async () => {
    const s = await newSharedAgreement("seller_3");
    p0();
    await buyerSays(s.token, "Hola, tengo una duda");
    await settleAssistantTasks();
    const v = await sellerRoom(s.cookie, await roomOf(s.cookie, s.id));
    expect(messagesOf(v)[0]).toMatchObject({ authorType: "BUYER", authorName: "Ana Pérez", text: "Hola, tengo una duda" });
  });
});

function p0(): void {
  setLlmProviderForTests(new ScriptedProvider(() => turn()));
}

describe("LLM_PROVIDER=none", () => {
  it("asistente desactivado: los mensajes se guardan, no hay respuesta y health lo indica", async () => {
    const cookie = await login("seller_1");
    const room = await newRoom(cookie);
    const noneEnv = { ...env, LLM_PROVIDER: "none" };
    const send = (path: string, init: RequestInit) => app.fetch(new Request(`http://localhost:8787${path}`, init), noneEnv);
    const health = (await (await send("/api/health", {})).json()) as HealthResponse;
    expect(health.assistant).toEqual({ enabled: false, provider: null, model: null });
    const res = await send(`/api/conversations/${room}/messages`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "cf-connecting-ip": "10.9.9.9" },
      body: JSON.stringify({ text: "Puerta de herrería para Mariana, 20 mil, 8 mil de anticipo" }),
    });
    const view = (await res.json()) as { assistantBusy: boolean; assistant: { enabled: boolean }; feed: unknown[] };
    expect(res.status).toBe(200);
    expect(view.assistantBusy).toBe(false);
    expect(view.assistant.enabled).toBe(false);
    expect(view.feed).toHaveLength(1);
    await settleAssistantTasks();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE conversation_id = ?").bind(room).first<{ n: number }>())?.n).toBe(0);
    expect(messagesOf(await sellerRoom(cookie, room))).toHaveLength(1);
  });
});

