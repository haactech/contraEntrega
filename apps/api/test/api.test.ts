import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { BuyerAgreementView, SellerAgreementView } from "@trato/shared";
import {
  PIN,
  call,
  createAgreement,
  login,
  newSharedAgreement,
  publicView,
  seedMock,
  share,
  tokenOf,
  validInput,
} from "./helpers";

beforeAll(seedMock);

describe("health y perfiles demo", () => {
  it("health responde ok y modo", async () => {
    const res = await call("/api/health");
    expect(await res.json()).toEqual({ ok: true, mode: "mock", assistant: { enabled: true, provider: "mock", model: "mock-rules" } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("lista los 5 perfiles sin datos bancarios completos", async () => {
    const res = await call("/api/demo/sellers");
    const body = (await res.json()) as { sellers: { displayName: string; account: { alias: string; last4: string } }[] };
    expect(body.sellers).toHaveLength(5);
    expect(body.sellers[0]?.account.last4).toBe("0001");
  });
});

describe("sesión", () => {
  it("PIN incorrecto -> 401 y sin cookie", async () => {
    const res = await call("/api/session", { method: "POST", json: { sellerId: "seller_1", pin: "0000" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("perfil inexistente da el mismo 401", async () => {
    const res = await call("/api/session", { method: "POST", json: { sellerId: "nope", pin: PIN } });
    expect(res.status).toBe(401);
  });

  it("PIN correcto -> cookie HttpOnly/SameSite y GET/DELETE /session", async () => {
    const res = await call("/api/session", { method: "POST", json: { sellerId: "seller_2", pin: PIN } });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/trato_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Max-Age=43200/i);
    expect(sc).not.toMatch(/Secure/i); // PUBLIC_APP_URL es localhost
    const cookie = sc.split(";")[0] as string;
    const me = await call("/api/session", { cookie });
    expect(((await me.json()) as { seller: { id: string } }).seller.id).toBe("seller_2");
    const out = await call("/api/session", { method: "DELETE", cookie });
    expect(out.status).toBe(204);
  });

  it("sin cookie o cookie manipulada -> 401", async () => {
    expect((await call("/api/session")).status).toBe(401);
    const cookie = await login();
    const tampered = `${cookie.slice(0, -2)}xx`;
    expect((await call("/api/agreements", { cookie: tampered })).status).toBe(401);
  });

  it("POST /session tiene rate limit (10/min por IP)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await call("/api/session", { method: "POST", ip: "203.0.113.9", json: { sellerId: "seller_1", pin: "bad" } });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("crear acuerdos", () => {
  it("crea DRAFT con 2 hitos, código TR-xxxx y evento", async () => {
    const cookie = await login();
    const v = await createAgreement(cookie);
    expect(v.agreement.status).toBe("DRAFT");
    expect(v.agreement.code).toMatch(/^TR-\d{4}$/);
    expect(v.agreement.buyerPhoneMasked).toBe("******4567");
    expect(v.milestones.map((m) => [m.kind, m.status, m.amountCents])).toEqual([
      ["ADVANCE", "PENDING_ACCEPTANCE", 400_000],
      ["BALANCE", "WAITING_DELIVERY", 600_000],
    ]);
    expect(v.events.map((e) => [e.seq, e.type])).toEqual([[1, "AGREEMENT_CREATED"]]);
    expect(v.nextAction).toBe("SHARE");
    expect(v.shareUrl).toBeNull();
    expect(v.agreement.termsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("los códigos son consecutivos", async () => {
    const cookie = await login();
    const a = await createAgreement(cookie);
    const b = await createAgreement(cookie);
    expect(Number(b.agreement.code.slice(3))).toBe(Number(a.agreement.code.slice(3)) + 1);
  });

  it.each([
    ["anticipo igual al total (saldo cero)", { totalCents: 1000, advanceCents: 1000 }],
    ["anticipo mayor al total (suma inválida)", { totalCents: 1000, advanceCents: 1500 }],
    ["anticipo cero", { totalCents: 1000, advanceCents: 0 }],
    ["anticipo negativo", { totalCents: 1000, advanceCents: -5 }],
    ["total cero", { totalCents: 0, advanceCents: 1 }],
    ["total negativo", { totalCents: -100, advanceCents: 1 }],
    ["total no entero", { totalCents: 1000.5, advanceCents: 10 }],
    ["total excede el máximo", { totalCents: 200_000_001, advanceCents: 1 }],
  ])("rechaza %s", async (_name, amounts) => {
    const cookie = await login();
    const res = await call("/api/agreements", { method: "POST", cookie, json: { ...validInput, ...amounts } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("rechaza JSON inválido y requiere sesión", async () => {
    const cookie = await login();
    const bad = await call("/api/agreements", { method: "POST", cookie, body: "{no" });
    expect(bad.status).toBe(400);
    const anon = await call("/api/agreements", { method: "POST", json: validInput });
    expect(anon.status).toBe(401);
  });

  it("lista ordenada por updated_at desc y aislada por vendedor", async () => {
    const c1 = await login("seller_3");
    const c2 = await login("seller_4");
    const a = await createAgreement(c1);
    const b = await createAgreement(c1);
    await createAgreement(c2);
    const res = await call("/api/agreements", { cookie: c1 });
    const list = ((await res.json()) as { agreements: { id: string }[] }).agreements;
    expect(list.map((x) => x.id)).toEqual([b.agreement.id, a.agreement.id]);
  });

  it("aislamiento: otro vendedor recibe 404 en GET y share", async () => {
    const owner = await login("seller_1");
    const other = await login("seller_2");
    const a = await createAgreement(owner);
    expect((await call(`/api/agreements/${a.agreement.id}`, { cookie: other })).status).toBe(404);
    expect((await call(`/api/agreements/${a.agreement.id}/share`, { method: "POST", cookie: other, json: {} })).status).toBe(404);
    expect((await call(`/api/agreements/${a.agreement.id}`, { cookie: owner })).status).toBe(200);
    expect((await call("/api/agreements/no-existe", { cookie: owner })).status).toBe(404);
  });
});

describe("share", () => {
  it("sella términos, emite token, status SHARED y whatsappUrl", async () => {
    const cookie = await login();
    const a = await createAgreement(cookie);
    const s = await share(cookie, a.agreement.id);
    expect(s.shareUrl).toMatch(/^http:\/\/localhost:8787\/t\/[A-Za-z0-9_-]{43}$/);
    expect(s.whatsappUrl.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(s.whatsappUrl)).toContain(s.shareUrl);
    expect(s.agreement.agreement.status).toBe("SHARED");
    expect(s.agreement.agreement.sharedAt).not.toBeNull();
    expect(s.agreement.agreement.termsSha256).toBe(a.agreement.termsSha256);
    expect(s.agreement.nextAction).toBe("WAIT_ACCEPTANCE");
    expect(s.agreement.events.map((e) => e.type)).toEqual(["AGREEMENT_CREATED", "AGREEMENT_SHARED"]);
    expect(s.agreement.events.map((e) => e.seq)).toEqual([1, 2]);
    const row = await env.DB.prepare("SELECT terms_json, terms_sha256 FROM agreements WHERE id = ?").bind(a.agreement.id).first<{ terms_json: string; terms_sha256: string }>();
    expect(JSON.parse(row?.terms_json ?? "{}").code).toBe(a.agreement.code);
  });

  it("compartir de nuevo devuelve el mismo enlace descifrado", async () => {
    const cookie = await login();
    const a = await createAgreement(cookie);
    const s1 = await share(cookie, a.agreement.id);
    const s2 = await share(cookie, a.agreement.id);
    expect(s2.shareUrl).toBe(s1.shareUrl);
    expect(s2.agreement.events).toHaveLength(2);
    const got = await call(`/api/agreements/${a.agreement.id}`, { cookie });
    expect(((await got.json()) as SellerAgreementView).shareUrl).toBe(s1.shareUrl);
  });

  it("regenerar revoca el token anterior (404) y registra LINK_REGENERATED", async () => {
    const { cookie, id, shared, token } = await newSharedAgreement();
    const regen = await share(cookie, id, true);
    const newToken = tokenOf(regen.shareUrl);
    expect(newToken).not.toBe(token);
    expect((await publicView(token)).status).toBe(404);
    expect((await publicView(newToken)).status).toBe(200);
    expect(regen.agreement.events.map((e) => e.type)).toEqual(["AGREEMENT_CREATED", "AGREEMENT_SHARED", "LINK_REGENERATED"]);
    expect(regen.agreement.agreement.version).toBeGreaterThan(shared.agreement.agreement.version);
    expect(regen.agreement.agreement.termsSha256).toBe(shared.agreement.agreement.termsSha256);
  });

  it("el token nunca se guarda en claro", async () => {
    const { token } = await newSharedAgreement();
    const rows = await env.DB.prepare("SELECT token_hash, token_ciphertext FROM buyer_access").all<{ token_hash: string; token_ciphertext: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      expect(r.token_hash).not.toContain(token);
      expect(r.token_ciphertext).not.toContain(token);
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // ninguna columna de ninguna tabla relevante contiene el token
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM agreements").all()).results,
      (await env.DB.prepare("SELECT * FROM agreement_events").all()).results,
      rows.results,
    ]);
    expect(dump).not.toContain(token);
  });
});

describe("vista pública", () => {
  it("devuelve BuyerAgreementView con headers y sin datos sensibles", async () => {
    const { token, created } = await newSharedAgreement();
    const res = await publicView(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"v\d+-w\d+"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const v = (await res.json()) as BuyerAgreementView & { shareUrl?: unknown };
    expect(v.payee).toEqual({ alias: "Cuenta demo 1", last4: "0001" });
    expect(v.seller.displayName).toBe("Herrería Don Chuy");
    expect(v.agreement.buyerPhoneMasked).toBe("******4567");
    expect(v.nextAction).toBe("ACCEPT");
    expect(v.activePaymentRequest).toBeNull();
    expect(v.shareUrl).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("5551234567");
    expect(v.agreement.id).toBe(created.agreement.id);
  });

  it("ETag + If-None-Match -> 304 hasta que cambia la versión", async () => {
    const { token } = await newSharedAgreement();
    const first = await publicView(token);
    const etag = first.headers.get("etag") as string;
    const same = await call(`/api/public/tratos/${token}`, { headers: { "If-None-Match": etag } });
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(etag);
    const v = (await first.json()) as BuyerAgreementView;
    const accept = await call(`/api/public/tratos/${token}/accept`, {
      method: "POST",
      json: { buyerName: "Ana Pérez", termsSha256: v.agreement.termsSha256, consent: true },
    });
    expect(accept.status).toBe(200);
    const after = await call(`/api/public/tratos/${token}`, { headers: { "If-None-Match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });

  it("filtra eventos ocultos al comprador pero no al vendedor", async () => {
    const { token, id } = await newSharedAgreement();
    await env.DB.prepare(
      "INSERT INTO agreement_events (id, agreement_id, seq, event_type, actor_type, payload_json, occurred_at) VALUES ('e-hidden', ?, 99, 'PAYMENT_UNMATCHED', 'PROVIDER', '{}', 1)",
    ).bind(id).run();
    const buyer = (await (await publicView(token)).json()) as BuyerAgreementView;
    expect(buyer.events.some((e) => e.type === "PAYMENT_UNMATCHED")).toBe(false);
    expect(buyer.events.length).toBe(2);
  });

  it("token inexistente y revocado dan el mismo 404", async () => {
    const { cookie, id, token } = await newSharedAgreement();
    await share(cookie, id, true);
    const revoked = await publicView(token);
    const unknown = await publicView("a".repeat(43));
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await revoked.json()).toEqual(await unknown.json());
  });
});

describe("accept", () => {
  const accept = (token: string, body: unknown, cookie?: string) =>
    call(`/api/public/tratos/${token}/accept`, { method: "POST", json: body, ...(cookie ? { cookie } : {}) });

  it("hash incorrecto -> 409 TERMS_MISMATCH y no cambia nada", async () => {
    const { token } = await newSharedAgreement();
    const res = await accept(token, { buyerName: "Ana Pérez", termsSha256: "0".repeat(64), consent: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TERMS_MISMATCH");
    const v = (await (await publicView(token)).json()) as BuyerAgreementView;
    expect(v.agreement.status).toBe("SHARED");
  });

  it("sin consentimiento -> 400", async () => {
    const { token } = await newSharedAgreement();
    const res = await accept(token, { buyerName: "Ana Pérez", termsSha256: "0".repeat(64), consent: false });
    expect(res.status).toBe(400);
  });

  it("aceptar correctamente: ACCEPTED, anticipo ELIGIBLE, evento con hash", async () => {
    const { token, shared } = await newSharedAgreement();
    const hash = shared.agreement.agreement.termsSha256;
    const res = await accept(token, { buyerName: "  Ana Pérez ", termsSha256: hash, consent: true });
    expect(res.status).toBe(200);
    const v = (await res.json()) as BuyerAgreementView;
    expect(v.agreement.status).toBe("ACCEPTED");
    expect(v.agreement.buyerAcceptedName).toBe("Ana Pérez");
    expect(v.agreement.buyerAcceptedAt).not.toBeNull();
    expect(v.milestones.find((m) => m.kind === "ADVANCE")?.status).toBe("ELIGIBLE");
    expect(v.milestones.find((m) => m.kind === "BALANCE")?.status).toBe("WAITING_DELIVERY");
    expect(v.nextAction).toBe("PAY_ADVANCE");
    const ev = v.events.at(-1);
    expect(ev?.type).toBe("TERMS_ACCEPTED");
    expect(ev?.actorType).toBe("BUYER");
    expect(ev?.payload).toMatchObject({ termsSha256: hash, termsVersion: 1 });
    // Aceptar no marca nada como pagado (invariante 5)
    expect(v.milestones.every((m) => m.status !== "PAID")).toBe(true);
  });

  it("aceptar dos veces -> 409 INVALID_STATE y un solo evento", async () => {
    const { token, shared, id } = await newSharedAgreement();
    const body = { buyerName: "Ana Pérez", termsSha256: shared.agreement.agreement.termsSha256, consent: true };
    expect((await accept(token, body)).status).toBe(200);
    const again = await accept(token, body);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("INVALID_STATE");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_events WHERE agreement_id = ? AND event_type = 'TERMS_ACCEPTED'").bind(id).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("aceptaciones concurrentes: solo una gana", async () => {
    const { token, shared, id } = await newSharedAgreement();
    const body = { buyerName: "Ana Pérez", termsSha256: shared.agreement.agreement.termsSha256, consent: true };
    const results = await Promise.all([accept(token, body), accept(token, body), accept(token, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_events WHERE agreement_id = ?").bind(id).first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it("el vendedor dueño no puede aceptar su propio trato (403)", async () => {
    const { cookie, token, shared } = await newSharedAgreement("seller_1");
    const res = await accept(token, { buyerName: "Yo mismo", termsSha256: shared.agreement.agreement.termsSha256, consent: true }, cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(((await (await publicView(token)).json()) as BuyerAgreementView).agreement.status).toBe("SHARED");
  });

  it("otro vendedor sí puede actuar como comprador (no es el dueño)", async () => {
    const { token, shared } = await newSharedAgreement("seller_1");
    const other = await login("seller_2");
    const res = await accept(token, { buyerName: "Otro", termsSha256: shared.agreement.agreement.termsSha256, consent: true }, other);
    expect(res.status).toBe(200);
  });

  it("no se puede aceptar un DRAFT sin enlace (404) ni regenerar tras aceptar cambia términos", async () => {
    const { cookie, id, token, shared } = await newSharedAgreement();
    await accept(token, { buyerName: "Ana Pérez", termsSha256: shared.agreement.agreement.termsSha256, consent: true });
    const regen = await share(cookie, id, true);
    expect(regen.agreement.agreement.status).toBe("ACCEPTED");
    expect(regen.agreement.agreement.termsSha256).toBe(shared.agreement.agreement.termsSha256);
    expect(regen.agreement.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
