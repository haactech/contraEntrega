import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BuyerAgreementView, ConfirmProposalResponse, PaymentRequestView, SellerAgreementView } from "@trato/shared";
import { setLlmProviderForTests } from "../src/assistant/provider";
import { settleAssistantTasks } from "../src/assistant/tasks";
import { ScriptedProvider, buyerSays, newRoom, sellerRoom, sellerSays, turn } from "./assistant-helpers";
import { setGatewayForTests } from "../src/payments/gateway";
import { call, login, seedMock } from "./helpers";
import { FakeGateway } from "./pey-fakes";
import { requestReviewCall, reviewCall, upload, pngBytes } from "./evidence-helpers";
import { agreementStatus, createPr, eventCount, milestoneStatus, postWebhook, prRow, qrPayload } from "./payments-helpers";
import { events, newApiKey, tool } from "./mcp-helpers";
import {
  acceptCleaning,
  acceptedCleaning,
  adjustCall,
  approveCall,
  cleaningInput,
  count,
  createCleaning,
  getBuyer,
  getSeller,
  photo,
  sharedCleaning,
  submitAndApprove,
  submitTaskCall,
  uploadTask,
} from "./cleaning-helpers";

let gw: FakeGateway;
beforeAll(seedMock);
beforeEach(() => {
  gw = new FakeGateway();
  setGatewayForTests(gw);
});
afterEach(() => setGatewayForTests(null));

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

describe("crear limpieza", () => {
  it("un hito BALANCE, sin anticipo, tareas, hash que congela el checklist", async () => {
    const cookie = await login();
    const v = await createCleaning(cookie);
    expect(v.serviceType).toBe("CLEANING");
    expect(v.paymentStrategy).toBe("ON_COMPLETION");
    expect(v.milestones).toHaveLength(1);
    expect(v.milestones[0]).toMatchObject({ kind: "BALANCE", amountCents: 70_000, status: "WAITING_DELIVERY" });
    expect(v.tasks).toHaveLength(4);
    expect(v.taskProgress).toEqual({ approved: 0, total: 4 });
    expect(v.agreement.acceptanceCriteria).toContain("1) Limpiar baño");
    expect(v.conversationId).toBeTruthy();
    const terms = JSON.parse((await env.DB.prepare("SELECT terms_json FROM agreements WHERE id = ?").bind(v.agreement.id).first<{ terms_json: string }>())!.terms_json);
    expect(terms.serviceType).toBe("CLEANING");
    expect(terms.tasks).toHaveLength(4);
    expect(terms.advanceCents).toBe(0);
    expect(v.nextAction).toBe("SHARE");
  });

  it("valida: tareas vacías, duplicadas y más de 8", async () => {
    const cookie = await login();
    expect((await call("/api/agreements", { method: "POST", cookie, json: cleaningInput({ tasks: [] }) })).status).toBe(400);
    expect((await call("/api/agreements", { method: "POST", cookie, json: cleaningInput({ tasks: [{ title: "Baño" }, { title: "baño" }] }) })).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => ({ title: `Tarea ${i}` }));
    expect((await call("/api/agreements", { method: "POST", cookie, json: cleaningInput({ tasks: nine }) })).status).toBe(400);
  });

  it("lista del prestador trae serviceType y progreso", async () => {
    const cookie = await login("seller_3");
    await createCleaning(cookie);
    const list = (await json<{ agreements: { serviceType: string; taskProgress: unknown }[] }>(await call("/api/agreements", { cookie }))).agreements;
    expect(list.find((a) => a.serviceType === "CLEANING")?.taskProgress).toEqual({ approved: 0, total: 4 });
  });
});

describe("aceptar y tareas", () => {
  it("aceptar lleva directo a IN_PROGRESS sin anticipo", async () => {
    const s = await sharedCleaning();
    const b0 = await getBuyer(s.token);
    expect(b0.nextAction).toBe("ACCEPT");
    const view = await acceptCleaning(s.token);
    expect(view.agreement.status).toBe("IN_PROGRESS");
    expect(view.milestones).toHaveLength(1);
    expect(view.milestones[0]!.status).toBe("WAITING_DELIVERY");
    expect(view.nextAction).toBe("WAIT_DELIVERY");
    expect((await getSeller(s.cookie, s.id)).nextAction).toBe("UPLOAD_EVIDENCE");
  });

  it("subir foto, enviar, el comprador ve la evidencia solo ya enviada", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    const ev = await photo(c.cookie, c.id, t.id);
    expect(ev).toMatchObject({ taskId: t.id, kind: "AFTER", revisionNumber: 1, submitted: false });
    expect((await getBuyer(c.token)).tasks![0]!.evidence).toHaveLength(0); // draft hidden
    expect((await getSeller(c.cookie, c.id)).tasks![0]!.evidence).toHaveLength(1);

    const sub = await submitTaskCall(c.cookie, c.id, t.id);
    expect(sub.status).toBe(200);
    const bv = await getBuyer(c.token);
    expect(bv.tasks![0]).toMatchObject({ status: "IN_REVIEW" });
    expect(bv.tasks![0]!.evidence).toHaveLength(1);
    expect(bv.nextAction).toBe("REVIEW");
    // signed url is fetchable
    const file = await call(new URL(bv.tasks![0]!.evidence[0]!.url, "http://localhost:8787").pathname + new URL(bv.tasks![0]!.evidence[0]!.url, "http://localhost:8787").search);
    expect(file.status).toBe(200);
    expect(await eventCount(c.id, "TASK_SUBMITTED")).toBe(1);
  });

  it("no se puede enviar sin foto AFTER; BEFORE no cuenta; máx 3 AFTER", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[1]!;
    expect((await submitTaskCall(c.cookie, c.id, t.id)).status).toBe(409);
    expect((await uploadTask(c.cookie, c.id, t.id, 1, "BEFORE")).status).toBe(201);
    expect((await submitTaskCall(c.cookie, c.id, t.id)).status).toBe(409);
    expect((await uploadTask(c.cookie, c.id, t.id, 2, "NOPE")).status).toBe(400);
    for (let i = 0; i < 3; i++) await photo(c.cookie, c.id, t.id, 10 + i);
    expect((await uploadTask(c.cookie, c.id, t.id, 99)).status).toBe(409);
  });

  it("borrar foto no enviada ok; enviada 409; archivo no imagen 400", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    const ev = await photo(c.cookie, c.id, t.id);
    const bad = new FormData();
    bad.append("file", new File([new TextEncoder().encode("hola mundo, no soy imagen")], "x.png", { type: "image/png" }));
    expect((await call(`/api/agreements/${c.id}/tasks/${t.id}/evidence`, { method: "POST", cookie: c.cookie, body: bad })).status).toBe(400);
    const del = await call(`/api/agreements/${c.id}/tasks/${t.id}/evidence/${ev.id}`, { method: "DELETE", cookie: c.cookie });
    expect(del.status).toBe(204);
    const ev2 = await photo(c.cookie, c.id, t.id, 5);
    await submitTaskCall(c.cookie, c.id, t.id);
    expect((await call(`/api/agreements/${c.id}/tasks/${t.id}/evidence/${ev2.id}`, { method: "DELETE", cookie: c.cookie })).status).toBe(409);
  });

  it("otro prestador no toca mis tareas (404)", async () => {
    const c = await acceptedCleaning("seller_1");
    const other = await login("seller_2");
    expect((await uploadTask(other, c.id, c.tasks[0]!.id)).status).toBe(404);
    expect((await submitTaskCall(other, c.id, c.tasks[0]!.id)).status).toBe(404);
  });

  it("el ajuste exige motivo, conserva la evidencia vieja y sube la revisión; reenvío y aprobación", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    await photo(c.cookie, c.id, t.id, 1);
    await submitTaskCall(c.cookie, c.id, t.id);

    expect((await adjustCall(c.token, t.id, "")).status).toBe(400);
    expect((await adjustCall(c.token, t.id, "no")).status).toBe(400);
    const adj = await adjustCall(c.token, t.id, "Falta el espejo");
    expect(adj.status).toBe(200);
    const after = await getSeller(c.cookie, c.id);
    expect(after.tasks![0]).toMatchObject({ status: "NEEDS_ADJUSTMENT", revision: 2 });
    expect(after.tasks![0]!.reviews[0]).toMatchObject({ decision: "REQUEST_ADJUSTMENT", comment: "Falta el espejo", revisionNumber: 1 });
    expect(after.tasks![0]!.evidence).toHaveLength(1); // old photo kept
    const ev = (await events(c.id)).find((e) => e.event_type === "TASK_ADJUSTMENT_REQUESTED")!;
    expect(ev.payload).toMatchObject({ taskId: t.id, taskTitle: "Limpiar baño", revision: 1, comment: "Falta el espejo" });

    // resubmit needs a NEW photo for revision 2
    expect((await submitTaskCall(c.cookie, c.id, t.id)).status).toBe(409);
    const ev2 = await photo(c.cookie, c.id, t.id, 2);
    expect(ev2.revisionNumber).toBe(2);
    expect((await submitTaskCall(c.cookie, c.id, t.id)).status).toBe(200);
    expect((await approveCall(c.token, t.id)).status).toBe(200);
    const done = await getSeller(c.cookie, c.id);
    expect(done.tasks![0]).toMatchObject({ status: "APPROVED", revision: 2 });
    expect(done.tasks![0]!.reviews).toHaveLength(2);
    expect(done.taskProgress).toEqual({ approved: 1, total: 4 });
    expect(await count("SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?", t.id)).toBe(2);
  });

  it("doble aprobación: la segunda es 409 y solo hay una revisión/evento", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    await photo(c.cookie, c.id, t.id);
    await submitTaskCall(c.cookie, c.id, t.id);
    const rs = await Promise.all([approveCall(c.token, t.id), approveCall(c.token, t.id), adjustCall(c.token, t.id, "motivo largo")]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?", t.id)).toBe(1);
  });

  it("aprobar una tarea no enviada -> 409", async () => {
    const c = await acceptedCleaning();
    const r = await approveCall(c.token, c.tasks[0]!.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("INVALID_STATE");
  });
});

describe("invariante 3: el prestador no aprueba su propio trabajo", () => {
  it("web: 403 con la sesión del dueño", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    await photo(c.cookie, c.id, t.id);
    await submitTaskCall(c.cookie, c.id, t.id);
    expect((await approveCall(c.token, t.id, c.cookie)).status).toBe(403);
    expect((await adjustCall(c.token, t.id, "motivo largo", c.cookie)).status).toBe(403);
    expect((await getSeller(c.cookie, c.id)).tasks![0]!.status).toBe("IN_REVIEW");
  });

  it("MCP: la llave del dueño con su buyerToken -> FORBIDDEN; el comprador sin llave sí puede", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    await photo(c.cookie, c.id, t.id);
    const { secret } = await newApiKey("seller_1");
    const sub = await tool("submit_task", { agreementId: c.id, taskId: t.id }, secret);
    expect(sub.isError).toBe(false);
    expect((sub.data as unknown as SellerAgreementView).tasks![0]!.status).toBe("IN_REVIEW");
    expect((await events(c.id)).find((e) => e.event_type === "TASK_SUBMITTED")!.payload.via).toBe("mcp");

    const own = await tool("review_task", { buyerToken: c.token, taskId: t.id, decision: "APPROVE" }, secret);
    expect(own.errorCode).toBe("FORBIDDEN");
    const noReason = await tool("review_task", { buyerToken: c.token, taskId: t.id, decision: "REQUEST_ADJUSTMENT" });
    expect(noReason.errorCode).toBe("VALIDATION_ERROR");
    const ok = await tool("review_task", { buyerToken: c.token, taskId: t.id, decision: "APPROVE" });
    expect(ok.isError).toBe(false);
    expect((ok.data as unknown as BuyerAgreementView).taskProgress).toEqual({ approved: 1, total: 4 });
    const ev = (await events(c.id)).find((e) => e.event_type === "TASK_APPROVED")!;
    expect(ev.payload).toMatchObject({ via: "mcp", taskId: t.id });

    const got = await tool("get_agreement", { agreementId: c.id }, secret);
    expect((got.data as unknown as SellerAgreementView).tasks).toHaveLength(4);
  });
});

describe("rutas y herramientas genéricas rechazan CLEANING", () => {
  it("evidence / request-review / review -> INVALID_STATE", async () => {
    const c = await acceptedCleaning();
    expect((await upload(c.cookie, c.id, pngBytes())).status).toBe(409);
    expect((await requestReviewCall(c.cookie, c.id)).status).toBe(409);
    const r = await reviewCall(c.token, { decision: "APPROVE", buyerName: "Mariana López" });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("INVALID_STATE");
  });

  it("MCP genéricas -> INVALID_STATE", async () => {
    const c = await acceptedCleaning();
    const { secret } = await newApiKey("seller_1");
    expect((await tool("request_review", { agreementId: c.id }, secret)).errorCode).toBe("INVALID_STATE");
    expect((await tool("buyer_review", { buyerToken: c.token, decision: "APPROVE", buyerName: "Mariana López" })).errorCode).toBe("INVALID_STATE");
  });
});

describe("pago único al terminar", () => {
  it("con tareas sin aprobar no se puede pedir pago; aprobando todas -> READY_TO_CHARGE y ALL_TASKS_APPROVED", async () => {
    const c = await acceptedCleaning();
    expect((await createPr(c.token, c.balanceId)).status).toBe(409);
    for (const [i, t] of c.tasks.entries()) {
      expect(await milestoneStatus(c.balanceId)).toBe("WAITING_DELIVERY");
      expect((await createPr(c.token, c.balanceId)).status).toBe(409);
      await submitAndApprove(c, t.id, i + 1);
    }
    expect(await milestoneStatus(c.balanceId)).toBe("READY_TO_CHARGE");
    expect(await eventCount(c.id, "ALL_TASKS_APPROVED")).toBe(1);
    expect(await eventCount(c.id, "TASK_APPROVED")).toBe(4);
    const bv = await getBuyer(c.token);
    expect(bv.nextAction).toBe("PAY_BALANCE");
    expect(bv.taskProgress).toEqual({ approved: 4, total: 4 });
    expect(await agreementStatus(c.id)).toBe("IN_PROGRESS");
    expect((await getSeller(c.cookie, c.id)).nextAction).toBe("WAIT_BALANCE");
  });

  it("flujo completo: pago por webhook -> COMPLETED; 3 webhooks idénticos = 1 confirmación; metadata taskSetVersion", async () => {
    const c = await acceptedCleaning("seller_2");
    for (const [i, t] of c.tasks.entries()) await submitAndApprove(c, t.id, i + 1);
    const res = await createPr(c.token, c.balanceId);
    expect(res.status).toBe(201);
    const pr = await json<PaymentRequestView>(res);
    expect(pr).toMatchObject({ milestoneKind: "BALANCE", amountCents: 70_000 });
    const tsv = gw.qrCalls[0]!.metadata as Record<string, string>;
    expect(tsv.taskSetVersion).toBe((await getBuyer(c.token)).agreement.termsSha256.slice(0, 12));
    expect(await milestoneStatus(c.balanceId)).toBe("AWAITING_PAYMENT");
    expect((await getBuyer(c.token)).nextAction).toBe("PAY_BALANCE");

    const row = await prRow(pr.id);
    const payload = qrPayload(row);
    for (let i = 0; i < 3; i++) expect((await postWebhook(payload, { webhookId: "msg_clean_1" })).status).toBe(200);
    expect(await agreementStatus(c.id)).toBe("COMPLETED");
    expect(await milestoneStatus(c.balanceId)).toBe("PAID");
    expect(await eventCount(c.id, "PAYMENT_CONFIRMED")).toBe(1);
    expect(await eventCount(c.id, "AGREEMENT_COMPLETED")).toBe(1);
    expect((await getBuyer(c.token)).nextAction).toBe("DONE");
  });

  it("webhook con monto o cuenta incorrectos no paga", async () => {
    const c = await acceptedCleaning("seller_3");
    for (const [i, t] of c.tasks.entries()) await submitAndApprove(c, t.id, i + 1);
    const pr = await json<PaymentRequestView>(await createPr(c.token, c.balanceId));
    const row = await prRow(pr.id);
    await postWebhook(qrPayload(row, { amountMxn: 1 }), { webhookId: "msg_clean_amt" });
    await postWebhook(qrPayload(row, { bankAccountId: "otra_cuenta" }), { webhookId: "msg_clean_acct" });
    expect(await milestoneStatus(c.balanceId)).toBe("AWAITING_PAYMENT");
    expect(await agreementStatus(c.id)).toBe("IN_PROGRESS");
    expect(await eventCount(c.id, "PAYMENT_CONFIRMED")).toBe(0);
  });
});

describe("exportación y feed", () => {
  it("el comprobante trae la sección Tareas con motivos y hashes", async () => {
    const c = await acceptedCleaning();
    const t = c.tasks[0]!;
    const ev = await photo(c.cookie, c.id, t.id);
    await submitTaskCall(c.cookie, c.id, t.id);
    await adjustCall(c.token, t.id, "Falta el espejo <b>x</b>");
    const html = await (await call(`/api/agreements/${c.id}/export`, { cookie: c.cookie })).text();
    expect(html).toContain("<h2>Tareas</h2>");
    expect(html).toContain("Limpiar baño");
    expect(html).toContain("Necesita ajuste");
    expect(html).toContain("Falta el espejo &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain(ev.sha256);
    expect(html).toContain("Ajuste solicitado");
    const buyerHtml = await (await call(`/api/public/tratos/${c.token}/export`)).text();
    expect(buyerHtml).toContain("<h2>Tareas</h2>");
  });
});

describe("chat: propuesta de limpieza -> acuerdo CLEANING", () => {
  const cleaningProposal = (tasks: string[], over: Record<string, unknown> = {}) => ({
    title: "Limpieza de departamento",
    description: "",
    acceptanceCriteria: "",
    totalMxn: 700,
    advanceMxn: 0,
    dueDate: null,
    buyerName: "Mariana",
    serviceType: "CLEANING" as const,
    tasks: tasks.map((title) => ({ title, description: null })),
    ...over,
  });

  afterEach(async () => {
    await settleAssistantTasks();
    setLlmProviderForTests(undefined);
  });

  it("confirmar crea el trato con tareas; la contraoferta con una tarea más reemplaza el checklist; los chips y el contexto son de limpieza", async () => {
    const cookie = await login("seller_4");
    const room = await newRoom(cookie);
    const provider = new ScriptedProvider((_req, n) =>
      turn({
        intent: n === 1 ? "PROPOSE_TERMS" : "REVISE_TERMS",
        reply: "Propuesta lista",
        proposal: cleaningProposal(n === 1 ? ["Limpiar baño", "Limpiar cocina"] : ["Limpiar baño", "Limpiar cocina", "Sacar la basura"]),
      }),
    );
    setLlmProviderForTests(provider);
    await sellerSays(cookie, room, "Limpieza del depa para Mariana, 700, baño y cocina");
    await settleAssistantTasks();
    const v1 = (await sellerRoom(cookie, room)).activeProposal!;
    expect(v1.terms).toMatchObject({ serviceType: "CLEANING", advanceCents: 0, totalCents: 70_000 });
    expect(v1.terms.tasks).toHaveLength(2);

    const res = await call(`/api/conversations/${room}/proposals/${v1.id}/confirm`, { method: "POST", cookie });
    expect(res.status).toBe(200);
    const out = (await res.json()) as ConfirmProposalResponse;
    const seller = out.conversation.agreement as SellerAgreementView;
    expect(seller.serviceType).toBe("CLEANING");
    expect(seller.tasks!.map((t) => t.title)).toEqual(["Limpiar baño", "Limpiar cocina"]);
    expect(seller.milestones).toHaveLength(1);
    expect(seller.agreement.acceptanceCriteria).toContain("Limpiar cocina");
    expect(seller.agreement.termsSha256).toBe(out.conversation.activeProposal!.termsSha256);
    const token = out.shareUrl.split("/t/")[1]!;

    // el comprador pide una tarea más -> propuesta v2 -> el prestador confirma -> tareas reemplazadas
    await buyerSays(token, "¿Le agregas sacar la basura?");
    await settleAssistantTasks();
    const v2 = (await sellerRoom(cookie, room)).activeProposal!;
    expect(v2.version).toBe(2);
    expect(v2.terms.tasks).toHaveLength(3);
    const rev = await call(`/api/conversations/${room}/proposals/${v2.id}/confirm`, { method: "POST", cookie });
    expect(rev.status).toBe(200);
    const after = (await getSeller(cookie, seller.agreement.id));
    expect(after.tasks!.map((t) => t.title)).toEqual(["Limpiar baño", "Limpiar cocina", "Sacar la basura"]);
    expect(after.agreement.termsVersion).toBe(2);
    expect(after.milestones).toHaveLength(1);
    expect(after.events.some((e) => e.type === "TERMS_REVISED")).toBe(true);

    // aceptado: chips de limpieza (sin UPLOAD_EVIDENCE/REQUEST_REVIEW) y contexto con el checklist
    await acceptCleaning(token);
    const sellerChips = (await sellerRoom(cookie, room)).allowedActions;
    expect(sellerChips).toContain("SUBMIT_TASK");
    expect(sellerChips).not.toContain("UPLOAD_EVIDENCE");
    expect(sellerChips).not.toContain("REQUEST_REVIEW");
    await sellerSays(cookie, room, "¿cómo vamos?");
    await settleAssistantTasks();
    const last = provider.requests.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain("Limpiar cocina");
    expect(JSON.stringify(last.messages)).toContain("CLEANING");
  });
});
