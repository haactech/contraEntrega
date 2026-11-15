import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formatMxn, type PaymentRequestView } from "@trato/shared";
import { setGatewayForTests } from "../src/payments/gateway";
import { escapeHtml } from "../src/lib/html";
import { call, createAgreement, login, seedMock, share, tokenOf, validInput } from "./helpers";
import { createPr } from "./payments-helpers";
import { addPhoto, requestReviewCall, reviewCall, simulate } from "./evidence-helpers";

beforeAll(seedMock);
beforeEach(() => setGatewayForTests(null));
afterEach(() => setGatewayForTests(null));

const XSS = "<script>alert(1)</script>";

async function scenario() {
  const cookie = await login("seller_2");
  const created = await createAgreement(cookie, { ...validInput, title: `Portón ${XSS}`, description: `desc ${XSS}`, buyerName: `Ana ${XSS}` });
  const id = created.agreement.id;
  const shared = await share(cookie, id);
  const token = tokenOf(shared.shareUrl);
  const view = (await (await call(`/api/public/tratos/${token}`)).json()) as { agreement: { termsSha256: string }; milestones: { id: string; kind: string }[] };
  const accept = await call(`/api/public/tratos/${token}/accept`, {
    method: "POST",
    json: { buyerName: `Ana ${XSS}`, termsSha256: view.agreement.termsSha256, consent: true },
  });
  expect(accept.status).toBe(200);
  const advanceId = view.milestones.find((m) => m.kind === "ADVANCE")!.id;
  const pr = (await (await createPr(token, advanceId)).json()) as PaymentRequestView;
  await simulate(pr.id);
  const ev = await addPhoto(cookie, id, 3);
  await call(`/api/agreements/${id}/evidence/${(await addPhoto(cookie, id, 4)).id}`, { method: "DELETE", cookie });
  await requestReviewCall(cookie, id, `nota ${XSS}`);
  await reviewCall(token, { decision: "DISPUTE", buyerName: `Ana ${XSS}`, comment: `roto ${XSS}` });
  await env.DB.prepare(
    "INSERT INTO agreement_events (id, agreement_id, seq, event_type, actor_type, payload_json, occurred_at) VALUES (?, ?, 900, 'PAYMENT_UNMATCHED', 'PROVIDER', '{}', 1)",
  ).bind(crypto.randomUUID(), id).run();
  return { cookie, id, token, ev, view };
}

describe("escapeHtml", () => {
  it("escapa los 5 caracteres especiales", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("export imprimible", () => {
  it("vendedor: HTML con hash, avisos, montos, hitos, pago, evidencia, revisión; escapa <script>", async () => {
    const s = await scenario();
    const res = await call(`/api/agreements/${s.id}/export`, { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}='/);
    const html = await res.text();

    expect(html).toContain(s.view.agreement.termsSha256);
    expect(html).toContain("El dinero llega directamente al prestador. Esta plataforma no retiene fondos ni garantiza devoluciones.");
    expect(html).toContain("Este registro no sustituye una pericial, una firma electrónica avanzada ni una resolución judicial.");
    expect(html).toContain("Imprimir / Guardar PDF");
    expect(html).toContain("window.print()");
    expect(html).toContain("@media print");
    expect(html).toContain(formatMxn(1_000_000));
    expect(html).toContain(formatMxn(400_000));
    expect(html).toContain("•••• 0002");
    expect(html).toContain("Cuenta demo 2");
    expect(html).toContain(s.ev.sha256);
    expect(html).toContain(s.ev.url.split("?")[0]);
    expect(html).toContain("Problema reportado");
    expect(html).toContain("Pagado");
    expect(html).toContain("Pago por revisar"); // seller sees unmatched
    expect(html).toContain("Evidencia eliminada antes de enviarla");
    // Escaping: only the single trusted inline print script remains.
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/<script/g)).toHaveLength(1);
    // No bank/phone data.
    expect(html).not.toContain("5551234567");
    expect(html).not.toContain("4567");
    expect(html).not.toMatch(/\d{18}/);
  });

  it("comprador: filtra PAYMENT_UNMATCHED y EVIDENCE_REMOVED y no ve evidencia sin enviar", async () => {
    const s = await scenario();
    const res = await call(`/api/public/tratos/${s.token}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toContain("Pago por revisar");
    expect(html).not.toContain("Evidencia eliminada");
    expect(html).toContain(s.view.agreement.termsSha256);
    expect(html).toContain("Entrega enviada a revisión");
    expect(html).not.toContain(XSS);
    expect(html).not.toContain("5551234567");
    expect(html).not.toMatch(/\d{18}/);
  });

  it("sin sesión -> 401; vendedor ajeno -> 404; token inválido -> 404", async () => {
    const s = await scenario();
    expect((await call(`/api/agreements/${s.id}/export`)).status).toBe(401);
    expect((await call(`/api/agreements/${s.id}/export`, { cookie: await login("seller_3") })).status).toBe(404);
    expect((await call(`/api/public/tratos/nope/export`)).status).toBe(404);
  });
});
