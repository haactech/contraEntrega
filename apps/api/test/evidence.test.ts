import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, type BuyerAgreementView, type EvidenceView, type PaymentRequestView } from "@trato/shared";
import { setGatewayForTests } from "../src/payments/gateway";
import { evidenceUrlExpiry, evidenceWindow, EVIDENCE_WINDOW_MS } from "../src/lib/url-window";
import { call, seedMock } from "./helpers";
import { acceptedAgreement, agreementStatus, createPr, eventCount, milestoneStatus, prRow } from "./payments-helpers";
import {
  addPhoto,
  buyerView,
  paidAdvance,
  pngBytes,
  r2Exists,
  requestReviewCall,
  reviewCall,
  sellerView,
  simulate,
  upload,
} from "./evidence-helpers";

beforeAll(seedMock);
beforeEach(() => setGatewayForTests(null)); // real MockPeyGateway
afterEach(() => setGatewayForTests(null));

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const errCode = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

describe("evidencias", () => {
  it("antes del anticipo pagado -> 409; después -> 201 con R2, fila y evento", async () => {
    const a = await acceptedAgreement();
    const early = await upload(a.cookie, a.id, pngBytes());
    expect(early.status).toBe(409);

    const p = await paidAdvance("seller_2");
    const res = await upload(p.cookie, p.id, pngBytes(100));
    expect(res.status).toBe(201);
    const ev = await json<EvidenceView>(res);
    expect(ev.mimeType).toBe("image/png");
    expect(ev.submitted).toBe(false);
    expect(ev.sizeBytes).toBe(108);
    expect(ev.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.url).toContain(`/api/files/evidence/${ev.id}?exp=`);
    const row = await env.DB.prepare("SELECT r2_key, delivery_round, submitted FROM evidence WHERE id = ?").bind(ev.id).first<{ r2_key: string; delivery_round: number; submitted: number }>();
    expect(row?.r2_key).toBe(`agreements/${p.id}/${ev.id}.png`);
    expect(row?.submitted).toBe(0);
    expect(await r2Exists(row!.r2_key)).toBe(true);
    expect(await eventCount(p.id, "EVIDENCE_ADDED")).toBe(1);
  });

  it("4a foto de la ronda -> 409", async () => {
    const p = await paidAdvance("seller_3");
    for (let i = 1; i <= 3; i++) await addPhoto(p.cookie, p.id, i);
    const res = await upload(p.cookie, p.id, pngBytes(40, 9));
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("INVALID_STATE");
  });

  it("archivo no imagen con mime falso -> 400; vacío -> 400", async () => {
    const p = await paidAdvance("seller_4");
    const text = new TextEncoder().encode("<html>no soy una imagen</html>");
    const res = await upload(p.cookie, p.id, text, { type: "image/png", name: "x.png" });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("VALIDATION_ERROR");
    expect((await upload(p.cookie, p.id, new Uint8Array(0))).status).toBe(400);
  });

  it("más de 5 MB -> 400 (por Content-Length y por tamaño real)", async () => {
    const p = await paidAdvance("seller_5");
    const big = pngBytes(5 * 1024 * 1024 + 10);
    expect((await upload(p.cookie, p.id, big)).status).toBe(400);
    const fd = new FormData();
    fd.append("file", new File([pngBytes()], "a.png"));
    const lying = await call(`/api/agreements/${p.id}/evidence`, { method: "POST", cookie: p.cookie, body: fd, headers: { "content-length": String(6 * 1024 * 1024) } });
    expect(lying.status).toBe(400);
  });

  it("acepta JPEG y WebP por magic bytes", async () => {
    const p = await paidAdvance("seller_1");
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
    expect((await json<EvidenceView>(await upload(p.cookie, p.id, jpg, { type: "application/octet-stream" }))).mimeType).toBe("image/jpeg");
    expect((await json<EvidenceView>(await upload(p.cookie, p.id, webp))).mimeType).toBe("image/webp");
  });

  it("comprador (sin sesión) o vendedor ajeno no pueden subir", async () => {
    const p = await paidAdvance("seller_2");
    expect((await upload("", p.id, pngBytes())).status).toBe(401);
    const { login } = await import("./helpers");
    const other = await login("seller_3");
    expect((await upload(other, p.id, pngBytes())).status).toBe(404);
  });

  it("DELETE: no enviada -> 204 (R2 + fila + evento oculto al comprador); enviada -> 409", async () => {
    const p = await paidAdvance("seller_3");
    const ev = await addPhoto(p.cookie, p.id, 2);
    const key = `agreements/${p.id}/${ev.id}.png`;
    const del = await call(`/api/agreements/${p.id}/evidence/${ev.id}`, { method: "DELETE", cookie: p.cookie });
    expect(del.status).toBe(204);
    expect(await r2Exists(key)).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence WHERE id = ?").bind(ev.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await eventCount(p.id, "EVIDENCE_REMOVED")).toBe(1);
    const bv = await buyerView(p.token);
    expect(bv.events.some((e) => e.type === "EVIDENCE_REMOVED")).toBe(false);

    const ev2 = await addPhoto(p.cookie, p.id, 3);
    expect((await requestReviewCall(p.cookie, p.id)).status).toBe(200);
    const del2 = await call(`/api/agreements/${p.id}/evidence/${ev2.id}`, { method: "DELETE", cookie: p.cookie });
    expect(del2.status).toBe(409);
  });
});

describe("archivos firmados", () => {
  it("URL válida -> 200 con bytes y headers; firma alterada o vencida -> 403; inexistente -> 404", async () => {
    const p = await paidAdvance("seller_4");
    const bytes = pngBytes(64, 7);
    const ev = (await json<EvidenceView>(await upload(p.cookie, p.id, bytes)));
    const ok = await call(ev.url);
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("private, max-age=600");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-disposition")).toBe("inline");

    expect((await call(ev.url.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`))).status).toBe(403);
    expect((await call(`${API_ROUTES.evidenceFile(ev.id)}`)).status).toBe(403);
    // Another id with this id's signature is rejected.
    expect((await call(ev.url.replace(ev.id, "otro"))).status).toBe(403);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
      expect((await call(ev.url)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ventana de URLs y ETag", () => {
  it("exp = inicio de ventana + 30 min; el índice de ventana cambia cada 15 min", () => {
    const w = EVIDENCE_WINDOW_MS;
    expect(evidenceWindow(5 * w + 1)).toBe(5);
    expect(evidenceWindow(6 * w - 1)).toBe(5);
    expect(evidenceWindow(6 * w)).toBe(6);
    expect(evidenceUrlExpiry(5 * w + 1)).toBe(7 * w);
    expect(evidenceUrlExpiry(6 * w - 1)).toBe(7 * w);
    // Always at least 15 min of validity remain.
    for (const t of [0, 1, w - 1, w, 7 * w + 123]) expect(evidenceUrlExpiry(t) - t).toBeGreaterThanOrEqual(w);
  });

  it("el ETag cambia al cambiar de ventana y un 304 nunca sirve URLs vencidas", async () => {
    const p = await paidAdvance("seller_5");
    await addPhoto(p.cookie, p.id, 4);
    await requestReviewCall(p.cookie, p.id);
    const first = await call(`/api/public/tratos/${p.token}`);
    const etag = first.headers.get("etag") as string;
    expect(etag).toMatch(/^"v\d+-w\d+"$/);
    const v1 = await json<BuyerAgreementView>(first);
    expect(v1.evidence).toHaveLength(1);
    expect((await call(`/api/public/tratos/${p.token}`, { headers: { "If-None-Match": etag } })).status).toBe(304);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + EVIDENCE_WINDOW_MS);
      const later = await call(`/api/public/tratos/${p.token}`, { headers: { "If-None-Match": etag } });
      expect(later.status).toBe(200);
      expect(later.headers.get("etag")).not.toBe(etag);
      const v2 = await json<BuyerAgreementView>(later);
      expect(v2.evidence[0]?.url).not.toBe(v1.evidence[0]?.url);
      expect((await call(v2.evidence[0]!.url)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("solicitar revisión y revisión del comprador", () => {
  it("sin evidencia -> 409; con evidencia -> WAITING_BUYER_REVIEW y submitted", async () => {
    const p = await paidAdvance("seller_1");
    const none = await requestReviewCall(p.cookie, p.id);
    expect(none.status).toBe(409);
    await addPhoto(p.cookie, p.id, 1);
    await addPhoto(p.cookie, p.id, 2);
    const res = await requestReviewCall(p.cookie, p.id, "Listo para revisar");
    expect(res.status).toBe(200);
    const v = await json<Awaited<ReturnType<typeof sellerView>>>(res);
    expect(v.milestones.find((m) => m.kind === "BALANCE")?.status).toBe("WAITING_BUYER_REVIEW");
    expect(v.evidence.every((e) => e.submitted)).toBe(true);
    expect(v.nextAction).toBe("WAIT_REVIEW");
    const ev = v.events.find((e) => e.type === "REVIEW_REQUESTED");
    expect(ev?.payload).toEqual({ milestoneKind: "BALANCE", deliveryRound: 0, evidenceCount: 2, note: "Listo para revisar", redelivery: false });
    // Cannot upload / request again while in review.
    expect((await upload(p.cookie, p.id, pngBytes())).status).toBe(409);
    expect((await requestReviewCall(p.cookie, p.id)).status).toBe(409);
    // Buyer sees submitted evidence only, nextAction REVIEW.
    const bv = await buyerView(p.token);
    expect(bv.evidence).toHaveLength(2);
    expect(bv.nextAction).toBe("REVIEW");
  });

  it("el comprador no ve evidencia no enviada", async () => {
    const p = await paidAdvance("seller_2");
    await addPhoto(p.cookie, p.id, 1);
    expect((await buyerView(p.token)).evidence).toHaveLength(0);
    expect((await sellerView(p.cookie, p.id)).evidence).toHaveLength(1);
  });

  it("vendedor dueño intentando review por token -> 403", async () => {
    const p = await paidAdvance("seller_3");
    await addPhoto(p.cookie, p.id);
    await requestReviewCall(p.cookie, p.id);
    const res = await reviewCall(p.token, { decision: "APPROVE", buyerName: "Yo mismo" }, p.cookie);
    expect(res.status).toBe(403);
    expect(await milestoneStatus(p.balanceId)).toBe("WAITING_BUYER_REVIEW");
  });

  it("review fuera de estado -> 409", async () => {
    const p = await paidAdvance("seller_4");
    expect((await reviewCall(p.token, { decision: "APPROVE", buyerName: "Ana" })).status).toBe(409);
  });

  it("recorrido feliz completo: ... evidencia -> revisión -> aprobar -> QR saldo -> pago -> COMPLETED", async () => {
    const p = await paidAdvance("seller_5");
    await addPhoto(p.cookie, p.id);
    await requestReviewCall(p.cookie, p.id);
    // Balance cannot be charged before approval.
    expect((await createPr(p.token, p.balanceId)).status).toBe(409);

    const res = await reviewCall(p.token, { decision: "APPROVE", buyerName: "Ana Pérez", comment: "Todo bien" });
    expect(res.status).toBe(200);
    const bv = await json<BuyerAgreementView>(res);
    expect(bv.nextAction).toBe("PAY_BALANCE");
    expect(bv.reviews).toHaveLength(1);
    expect(bv.reviews[0]).toMatchObject({ decision: "APPROVE", comment: "Todo bien", buyerName: "Ana Pérez" });
    expect(await milestoneStatus(p.balanceId)).toBe("READY_TO_CHARGE");
    expect(await agreementStatus(p.id)).toBe("IN_PROGRESS");
    const m = await env.DB.prepare("SELECT approved_at, paid_at FROM milestones WHERE id = ?").bind(p.balanceId).first<{ approved_at: number | null; paid_at: number | null }>();
    expect(m?.approved_at).not.toBeNull();
    expect(m?.paid_at).toBeNull();
    const prs = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE milestone_id = ?").bind(p.balanceId).first<{ n: number }>();
    expect(prs?.n).toBe(0);
    const ap = bv.events.find((e) => e.type === "DELIVERY_APPROVED");
    expect(ap?.payload).toEqual({ milestoneKind: "BALANCE", deliveryRound: 0, buyerName: "Ana Pérez", comment: "Todo bien" });

    const created = await createPr(p.token, p.balanceId);
    expect(created.status).toBe(201);
    const balancePr = await json<PaymentRequestView>(created);
    expect(balancePr.id).not.toBe(p.advancePr.id);
    expect((await prRow(balancePr.id)).provider_bank_account_id).toBe((await prRow(p.advancePr.id)).provider_bank_account_id);
    expect((await simulate(balancePr.id)).status).toBe(200);
    expect(await agreementStatus(p.id)).toBe("COMPLETED");
    expect(await milestoneStatus(p.balanceId)).toBe("PAID");
    expect(await eventCount(p.id, "AGREEMENT_COMPLETED")).toBe(1);
    expect((await buyerView(p.token)).nextAction).toBe("DONE");
    expect((await sellerView(p.cookie, p.id)).nextAction).toBe("DONE");
  });

  it("DISPUTE sin comentario -> 400; DISPUTE bloquea el saldo y conserva historial; re-entrega y luego APPROVE", async () => {
    const p = await paidAdvance("seller_1");
    const e1 = await addPhoto(p.cookie, p.id, 1);
    await requestReviewCall(p.cookie, p.id);

    const noComment = await reviewCall(p.token, { decision: "DISPUTE", buyerName: "Ana Pérez" });
    expect(noComment.status).toBe(400);

    const d = await reviewCall(p.token, { decision: "DISPUTE", buyerName: "Ana Pérez", comment: "El portón no cierra bien" });
    expect(d.status).toBe(200);
    const bv = await json<BuyerAgreementView>(d);
    expect(bv.nextAction).toBe("WAIT_SELLER");
    expect(await agreementStatus(p.id)).toBe("DISPUTED");
    expect(await milestoneStatus(p.balanceId)).toBe("DISPUTED");
    expect((await createPr(p.token, p.balanceId)).status).toBe(409);
    expect(bv.events.find((e) => e.type === "DELIVERY_DISPUTED")?.payload).toEqual({
      milestoneKind: "BALANCE",
      deliveryRound: 0,
      buyerName: "Ana Pérez",
      comment: "El portón no cierra bien",
    });

    let sv = await sellerView(p.cookie, p.id);
    expect(sv.nextAction).toBe("RESOLVE_DISPUTE");
    expect(sv.reviews[0]?.comment).toBe("El portón no cierra bien");
    expect(sv.evidence.map((e) => e.id)).toEqual([e1.id]);
    expect(sv.paymentRequests.some((x) => x.status === "PAID" && x.milestoneKind === "ADVANCE")).toBe(true);
    expect(sv.agreement.termsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sv.events.some((e) => e.type === "TERMS_ACCEPTED")).toBe(true);

    // Re-delivery: new round, 3 more photos allowed, previous evidence preserved.
    const e2 = await addPhoto(p.cookie, p.id, 2);
    expect(e2.deliveryRound).toBe(1);
    await addPhoto(p.cookie, p.id, 3);
    await addPhoto(p.cookie, p.id, 4);
    expect((await upload(p.cookie, p.id, pngBytes(40, 5))).status).toBe(409);
    // Buyer does not see the new unsubmitted photos yet.
    expect((await buyerView(p.token)).evidence.map((e) => e.id)).toEqual([e1.id]);

    sv = await json<typeof sv>(await requestReviewCall(p.cookie, p.id, "Ajustado"));
    expect(sv.milestones.find((m) => m.kind === "BALANCE")).toMatchObject({ status: "WAITING_BUYER_REVIEW", deliveryRound: 1 });
    expect(await agreementStatus(p.id)).toBe("IN_PROGRESS");
    expect(sv.evidence).toHaveLength(4);
    expect(sv.reviews).toHaveLength(1);
    expect(sv.events.filter((e) => e.type === "REVIEW_REQUESTED").at(-1)?.payload).toMatchObject({ deliveryRound: 1, evidenceCount: 3, redelivery: true });

    const ok = await reviewCall(p.token, { decision: "APPROVE", buyerName: "Ana Pérez" });
    expect(ok.status).toBe(200);
    const after = await json<BuyerAgreementView>(ok);
    expect(after.reviews.map((r) => [r.deliveryRound, r.decision])).toEqual([[0, "DISPUTE"], [1, "APPROVE"]]);
    expect(await milestoneStatus(p.balanceId)).toBe("READY_TO_CHARGE");
    expect((await createPr(p.token, p.balanceId)).status).toBe(201);
  });
});
