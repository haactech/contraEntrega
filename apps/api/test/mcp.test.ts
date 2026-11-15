import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MCP_TOOLS, MCP_TOOL_NAMES, toJsonSchema, type AllowedAction } from "@trato/shared";
import { setGatewayForTests } from "../src/payments/gateway";
import { call, seedMock } from "./helpers";
import { CLABE } from "./payments-helpers";
import { pngBytes, simulate } from "./evidence-helpers";
import { MCP_HEADERS, actionsOf, events, newApiKey, rpc, tokenFromUrl, tool, type ToolOutcome } from "./mcp-helpers";

beforeAll(seedMock);
beforeEach(() => setGatewayForTests(null));
afterEach(() => setGatewayForTests(null));

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const TERMS = {
  title: "Puerta de herrería",
  description: "Puerta de 2 m con pintura.",
  acceptanceCriteria: "Instalada, pintada y funcionando.",
  buyerName: "Ana Pérez",
  buyerPhone: "5551234567",
  totalMxn: 10000,
  advanceMxn: 4000,
};

const has = (o: ToolOutcome, a: AllowedAction): boolean => actionsOf(o).includes(a);

describe("MCP: protocolo", () => {
  it("initialize responde con serverInfo y capacidad de tools", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { result: { serverInfo: { name: string }; capabilities: { tools: unknown }; protocolVersion: string } };
    expect(body.result.serverInfo.name).toBe("trato");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list expone exactamente MCP_TOOLS con inputSchema generado desde shared", async () => {
    const res = await rpc("tools/list", {});
    const body = (await res.json()) as { result: { tools: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean } }[] } };
    const tools = body.result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(14);
    for (const t of tools) {
      const def = MCP_TOOLS.find((x) => x.name === t.name)!;
      expect(t.description).toBe(def.description);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema).toMatchObject(toJsonSchema(def.inputSchema));
      expect(t.annotations.readOnlyHint).toBe(def.readOnly);
    }
    const add = tools.find((t) => t.name === "add_evidence")!;
    expect((add.inputSchema.properties as Record<string, unknown>).imageBase64).toBeDefined();
    expect(add.inputSchema.required).toEqual(expect.arrayContaining(["agreementId", "imageBase64", "mediaType"]));
    // Nothing can mark a payment as paid or change amounts/accounts.
    expect(tools.map((t) => t.name).join(",")).not.toMatch(/paid|confirm_payment|bank|amount/i);
  });

  it("herramienta inexistente -> error JSON-RPC", async () => {
    const res = await rpc("tools/call", { name: "mark_paid", arguments: {} });
    const body = (await res.json()) as { error?: { code: number; message: string }; result?: unknown };
    expect(body.error).toBeDefined();
    expect(body.error?.message).toContain("mark_paid");
  });

  it("método HTTP, content-type y tamaño", async () => {
    expect((await call("/mcp", { method: "GET", headers: MCP_HEADERS })).status).toBe(405);
    const bad = await call("/mcp", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } });
    expect(bad.status).toBe(415);
    const junk = await call("/mcp", { method: "POST", body: "{no", headers: { "content-type": "application/json" } });
    expect(junk.status).toBe(400);
    const big = await call("/mcp", { method: "POST", body: "x".repeat(8 * 1024 * 1024 + 10), headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
  });

  it("sin Accept también responde JSON", async () => {
    const res = await call("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(res.status).toBe(200);
  });
});

describe("MCP: autenticación", () => {
  it("herramientas de prestador sin llave -> UNAUTHORIZED claro", async () => {
    for (const [name, args] of [
      ["list_agreements", {}],
      ["get_agreement", { agreementId: "x" }],
      ["create_agreement", TERMS],
    ] as const) {
      const r = await tool(name, { ...args });
      expect(r.isError).toBe(true);
      expect(r.errorCode).toBe("UNAUTHORIZED");
      expect(r.text).toContain("llave de API");
    }
  });

  it("llave inválida o revocada -> 401; revocar la deja fuera aunque antes funcionaba", async () => {
    const k = await newApiKey("seller_1");
    expect((await tool("list_agreements", {}, k.secret)).isError).toBe(false);
    expect((await rpc("tools/list", {}, { key: "trk_inventada" })).status).toBe(401);
    expect((await rpc("tools/list", {}, { key: "otra-cosa" })).status).toBe(401);
    expect((await call(`/api/api-keys/${encodeURIComponent(k.id)}`, { method: "DELETE", cookie: k.cookie })).status).toBe(204);
    const res = await rpc("tools/list", {}, { key: k.secret });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("last_used_at se actualiza como mucho una vez por minuto", async () => {
    const k = await newApiKey("seller_5");
    const read = async () => (await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").bind(k.id).first<{ last_used_at: number | null }>())?.last_used_at;
    expect(await read()).toBeNull();
    await tool("list_agreements", {}, k.secret);
    const first = await read();
    expect(first).toBeGreaterThan(0);
    await tool("list_agreements", {}, k.secret);
    expect(await read()).toBe(first);
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now() - 61_000, k.id).run();
    await tool("list_agreements", {}, k.secret);
    expect(await read()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("aislamiento: otro prestador no ve ni toca tratos ajenos (NOT_FOUND)", async () => {
    const a = await newApiKey("seller_1");
    const b = await newApiKey("seller_2");
    const created = await tool("create_agreement", TERMS, a.secret);
    const id = (created.data.agreement as { id: string }).id;
    const r = await tool("get_agreement", { agreementId: id }, b.secret);
    expect(r.errorCode).toBe("NOT_FOUND");
    expect(((await tool("list_agreements", {}, b.secret)).data.agreements as { id: string }[]).some((x) => x.id === id)).toBe(false);
  });

  it("invariante 3: la llave del dueño no actúa como comprador de su propio trato", async () => {
    const k = await newApiKey("seller_3");
    const created = await tool("create_agreement", TERMS, k.secret);
    const shared = await tool("share_agreement", { agreementId: (created.data.agreement as { id: string }).id }, k.secret);
    const token = tokenFromUrl(shared.data.shareUrl as string);
    for (const [name, args] of [
      ["buyer_get_agreement", {}],
      ["buyer_review", { decision: "APPROVE", buyerName: "Yo mismo" }],
      ["buyer_accept", { buyerName: "Yo mismo", termsSha256: "a".repeat(64), consent: true }],
    ] as const) {
      const r = await tool(name, { buyerToken: token, ...args }, k.secret);
      expect(r.isError).toBe(true);
      expect(r.errorCode).toBe("FORBIDDEN");
    }
    // Sin llave, ese mismo token sí funciona (es el enlace del comprador).
    expect((await tool("buyer_get_agreement", { buyerToken: token })).isError).toBe(false);
    // Otro prestador (otra llave) sí puede actuar con ese enlace? No es el dueño: no se bloquea.
    const other = await newApiKey("seller_4");
    expect((await tool("buyer_get_agreement", { buyerToken: token }, other.secret)).isError).toBe(false);
  });

  it("buyerToken desconocido -> NOT_FOUND; entrada inválida -> VALIDATION_ERROR", async () => {
    expect((await tool("buyer_get_agreement", { buyerToken: "no-existe-este-token" })).errorCode).toBe("NOT_FOUND");
    expect((await tool("buyer_get_agreement", { buyerToken: "x" })).errorCode).toBe("VALIDATION_ERROR");
    const k = await newApiKey("seller_1");
    expect((await tool("create_agreement", { ...TERMS, advanceMxn: 20000 }, k.secret)).errorCode).toBe("VALIDATION_ERROR");
  });
});

describe("MCP: recorrido completo", () => {
  it("liberar dinero con evidencias, de punta a punta", async () => {
    const k = await newApiKey("seller_1", "agente");
    const outputs: string[] = [];
    const keep = (o: ToolOutcome): ToolOutcome => {
      outputs.push(o.text);
      return o;
    };

    // Prestador crea y comparte.
    const created = keep(await tool("create_agreement", TERMS, k.secret));
    expect(created.isError).toBe(false);
    const agreement = created.data.agreement as { id: string; status: string; totalCents: number };
    expect(agreement.status).toBe("DRAFT");
    expect(agreement.totalCents).toBe(1_000_000);
    expect(has(created, "SHARE_LINK")).toBe(true);
    const id = agreement.id;

    const listed = keep(await tool("list_agreements", { status: "DRAFT" }, k.secret));
    expect((listed.data.agreements as { id: string; allowedActions: string[] }[]).find((a) => a.id === id)?.allowedActions).toContain("SHARE_LINK");

    const shared = keep(await tool("share_agreement", { agreementId: id }, k.secret));
    expect((shared.data.agreement as { status: string }).status).toBe("SHARED");
    expect(shared.data.whatsappUrl).toContain("wa.me");
    const token = tokenFromUrl(shared.data.shareUrl as string);

    // Comprador (sin llave) revisa y acepta.
    const view = keep(await tool("buyer_get_agreement", { buyerToken: token }));
    expect(has(view, "ACCEPT_TERMS")).toBe(true);
    const sha = (view.data.agreement as { termsSha256: string }).termsSha256;
    const wrong = keep(await tool("buyer_accept", { buyerToken: token, buyerName: "Ana Pérez", termsSha256: "0".repeat(64), consent: true }));
    expect(wrong.isError).toBe(true);
    expect(wrong.errorCode).toBe("TERMS_MISMATCH");
    const accepted = keep(await tool("buyer_accept", { buyerToken: token, buyerName: "Ana Pérez", termsSha256: sha, consent: true }));
    expect(accepted.isError).toBe(false);
    expect(has(accepted, "PAY_ADVANCE")).toBe(true);
    expect(has(accepted, "ACCEPT_TERMS")).toBe(false);

    // Anticipo por CoDi QR; el pago solo lo confirma el proveedor (mock).
    const advPr = keep(await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "ADVANCE", method: "CODI_QR" }));
    expect(advPr.isError).toBe(false);
    const advPrId = (advPr.data.paymentRequest as { id: string; amountCents: number }).id;
    expect((advPr.data.paymentRequest as { amountCents: number }).amountCents).toBe(400_000);
    // Antes de pagar no se puede subir evidencia.
    const early = keep(await tool("add_evidence", { agreementId: id, imageBase64: b64(pngBytes(64)), mediaType: "image/png" }, k.secret));
    expect(early.errorCode).toBe("INVALID_STATE");
    expect((await simulate(advPrId)).status).toBe(200);
    const refreshed = keep(await tool("buyer_refresh_payment", { buyerToken: token, paymentRequestId: advPrId }));
    expect((refreshed.data.paymentRequest as { status: string }).status).toBe("PAID");

    const afterAdvance = keep(await tool("get_agreement", { agreementId: id }, k.secret));
    expect(has(afterAdvance, "UPLOAD_EVIDENCE")).toBe(true);
    expect(has(afterAdvance, "REQUEST_REVIEW")).toBe(false);

    // Evidencia (PNG válido) y solicitud de revisión.
    const ev = keep(await tool("add_evidence", { agreementId: id, imageBase64: b64(pngBytes(64, 3)), mediaType: "image/png", note: "Puerta instalada" }, k.secret));
    expect(ev.isError).toBe(false);
    expect(ev.data.unsubmittedCount).toBe(1);
    expect((ev.data.evidence as { mimeType: string; submitted: boolean }).mimeType).toBe("image/png");
    expect(has(ev, "REQUEST_REVIEW")).toBe(true);
    const buyerBefore = keep(await tool("buyer_get_agreement", { buyerToken: token }));
    expect((buyerBefore.data.evidence as unknown[]).length).toBe(0); // borrador oculto al comprador

    const reqd = keep(await tool("request_review", { agreementId: id, note: "Listo para revisar" }, k.secret));
    expect((reqd.data.agreement as { status: string }).status).toBe("IN_PROGRESS");
    expect(has(reqd, "REQUEST_REVIEW")).toBe(false);

    // El agente del comprador revisa la evidencia y aprueba.
    const review = keep(await tool("buyer_get_agreement", { buyerToken: token }));
    expect((review.data.evidence as unknown[]).length).toBe(1);
    expect(has(review, "APPROVE_DELIVERY")).toBe(true);
    expect(has(review, "DISPUTE_DELIVERY")).toBe(true);
    const dispute = keep(await tool("buyer_review", { buyerToken: token, decision: "DISPUTE", buyerName: "Ana Pérez" }));
    expect(dispute.errorCode).toBe("VALIDATION_ERROR"); // la disputa exige comentario
    const approved = keep(await tool("buyer_review", { buyerToken: token, decision: "APPROVE", buyerName: "Ana Pérez" }));
    expect(approved.isError).toBe(false);
    expect(has(approved, "PAY_BALANCE")).toBe(true);
    expect(has(approved, "APPROVE_DELIVERY")).toBe(false);

    // Saldo por CoDi QR (el mock no concilia PN por simulación).
    const balPr = keep(await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "BALANCE", method: "CODI_QR" }));
    expect(balPr.isError).toBe(false);
    const balPrId = (balPr.data.paymentRequest as { id: string; amountCents: number }).id;
    expect((balPr.data.paymentRequest as { amountCents: number }).amountCents).toBe(600_000);
    expect((await simulate(balPrId)).status).toBe(200);
    const paid = keep(await tool("buyer_refresh_payment", { buyerToken: token, paymentRequestId: balPrId }));
    expect((paid.data.paymentRequest as { status: string }).status).toBe("PAID");

    // Misma cuenta interna del prestador en ambos cobros (leída de la BD, no del agente).
    const accounts = await env.DB.prepare("SELECT provider_bank_account_id FROM payment_requests WHERE id IN (?, ?)").bind(advPrId, balPrId).all<{ provider_bank_account_id: string }>();
    expect(accounts.results).toHaveLength(2);
    expect(new Set(accounts.results.map((r) => r.provider_bank_account_id))).toEqual(new Set(["mock_ba_1"]));

    const done = keep(await tool("get_agreement", { agreementId: id }, k.secret));
    expect((done.data.agreement as { status: string }).status).toBe("COMPLETED");
    expect(has(done, "EXPORT")).toBe(true);
    expect(has(done, "UPLOAD_EVIDENCE")).toBe(false);
    const doneBuyer = keep(await tool("buyer_get_agreement", { buyerToken: token }));
    expect((doneBuyer.data.agreement as { status: string }).status).toBe("COMPLETED");
    expect(has(doneBuyer, "PAY_BALANCE")).toBe(false);

    const exported = keep(await tool("export_agreement", { agreementId: id }, k.secret));
    expect(exported.data.mimeType).toBe("text/html");
    expect(exported.data.html).toContain("<html");

    // Ninguna salida filtra CLABE, teléfonos completos, secretos ni la llave.
    const all = outputs.join("\n");
    expect(all).not.toContain(CLABE);
    expect(all).not.toMatch(/\d{18}/);
    expect(all).not.toContain("5551234567");
    expect(all).not.toContain(k.secret);
    expect(all).not.toMatch(/trk_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toMatch(/mock_ba_|pey_|SESSION_SECRET/);

    // Eventos: via "mcp" y actor de la llave.
    const evs = await events(id);
    const byType = (t: string) => evs.filter((e) => e.event_type === t);
    for (const t of ["AGREEMENT_CREATED", "AGREEMENT_SHARED", "TERMS_ACCEPTED", "EVIDENCE_ADDED", "REVIEW_REQUESTED", "DELIVERY_APPROVED"]) {
      const found = byType(t);
      expect(found.length, t).toBeGreaterThan(0);
      for (const e of found) expect(e.payload.via, t).toBe("mcp");
    }
    for (const t of ["AGREEMENT_CREATED", "EVIDENCE_ADDED", "REVIEW_REQUESTED"]) expect(byType(t)[0]?.actor_ref).toBe(`mcp:${k.id}`);
    const prEvents = evs.filter((e) => e.event_type.startsWith("PAYMENT_REQUEST"));
    expect(prEvents.length).toBeGreaterThan(0);
    for (const e of prEvents.filter((x) => x.event_type === "PAYMENT_REQUEST_CREATED")) expect(e.payload.via).toBe("mcp");
  });
});

describe("MCP: pagos", () => {
  it("CODI_PN exige teléfono y nunca lo devuelve completo; importes del agente se ignoran", async () => {
    const k = await newApiKey("seller_4");
    const created = await tool("create_agreement", TERMS, k.secret);
    const id = (created.data.agreement as { id: string }).id;
    const token = tokenFromUrl((await tool("share_agreement", { agreementId: id }, k.secret)).data.shareUrl as string);
    const view = await tool("buyer_get_agreement", { buyerToken: token });
    await tool("buyer_accept", { buyerToken: token, buyerName: "Ana Pérez", termsSha256: (view.data.agreement as { termsSha256: string }).termsSha256, consent: true });
    const noPhone = await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "ADVANCE", method: "CODI_PN" });
    expect(noPhone.errorCode).toBe("VALIDATION_ERROR");
    const pn = await tool("buyer_create_payment_request", {
      buyerToken: token,
      milestoneKind: "ADVANCE",
      method: "CODI_PN",
      phoneNumber: "5559876543",
      amountCents: 1,
      bankAccountId: "otra",
    });
    expect(pn.isError).toBe(false);
    expect((pn.data.paymentRequest as { amountCents: number }).amountCents).toBe(400_000);
    expect(pn.text).not.toContain("5559876543");
    // Repetir reutiliza la solicitud vigente (no duplica).
    const again = await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "ADVANCE", method: "CODI_PN", phoneNumber: "5559876543" });
    expect((again.data.paymentRequest as { id: string }).id).toBe((pn.data.paymentRequest as { id: string }).id);
    // El saldo aún no es cobrable.
    expect((await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "BALANCE", method: "CODI_QR" })).isError).toBe(true);
  });
});

describe("MCP: evidencia", () => {
  async function paidAgreement(sellerId: string) {
    const k = await newApiKey(sellerId);
    const created = await tool("create_agreement", TERMS, k.secret);
    const id = (created.data.agreement as { id: string }).id;
    const shared = await tool("share_agreement", { agreementId: id }, k.secret);
    const token = tokenFromUrl(shared.data.shareUrl as string);
    const view = await tool("buyer_get_agreement", { buyerToken: token });
    await tool("buyer_accept", { buyerToken: token, buyerName: "Ana Pérez", termsSha256: (view.data.agreement as { termsSha256: string }).termsSha256, consent: true });
    const pr = await tool("buyer_create_payment_request", { buyerToken: token, milestoneKind: "ADVANCE", method: "CODI_QR" });
    await simulate((pr.data.paymentRequest as { id: string }).id);
    return { k, id, token };
  }

  it("base64 que no es una imagen -> isError; tipo declarado falso no engaña", async () => {
    const { k, id } = await paidAgreement("seller_2");
    const text = btoa("<html>no soy una imagen</html>");
    const r = await tool("add_evidence", { agreementId: id, imageBase64: text, mediaType: "image/png" }, k.secret);
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe("VALIDATION_ERROR");
    const junk = await tool("add_evidence", { agreementId: id, imageBase64: "no es base64!!", mediaType: "image/png" }, k.secret);
    expect(junk.errorCode).toBe("VALIDATION_ERROR");
    const dataUri = await tool("add_evidence", { agreementId: id, imageBase64: `data:image/png;base64,${b64(pngBytes())}`, mediaType: "image/png" }, k.secret);
    expect(dataUri.errorCode).toBe("VALIDATION_ERROR");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence WHERE agreement_id = ?").bind(id).first<{ n: number }>())?.n).toBe(0);
  });

  it("imagen demasiado grande -> isError, y la 4a foto también", async () => {
    const { k, id } = await paidAgreement("seller_3");
    const big = pngBytes(5 * 1024 * 1024 + 10);
    const r = await tool("add_evidence", { agreementId: id, imageBase64: b64(big), mediaType: "image/png" }, k.secret);
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe("VALIDATION_ERROR");
    for (let i = 1; i <= 3; i++) {
      expect((await tool("add_evidence", { agreementId: id, imageBase64: b64(pngBytes(64, i)), mediaType: "image/png" }, k.secret)).isError).toBe(false);
    }
    const fourth = await tool("add_evidence", { agreementId: id, imageBase64: b64(pngBytes(64, 9)), mediaType: "image/png" }, k.secret);
    expect(fourth.errorCode).toBe("INVALID_STATE");
  });
});
