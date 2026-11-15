import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CreateAgreementInputSchema, type BuyerAgreementView } from "@trato/shared";
import { createDb } from "../src/db/client";
import { AppError } from "../src/lib/errors";
import { reviseTerms } from "../src/services/agreements";
import { call, newSharedAgreement, publicView, seedMock, validInput } from "./helpers";

beforeAll(seedMock);

const revised = (over: Partial<typeof validInput>) => CreateAgreementInputSchema.parse({ ...validInput, ...over });

describe("reviseTerms", () => {
  it("SHARED: terms_version++, hash nuevo, hitos actualizados y evento TERMS_REVISED", async () => {
    const s = await newSharedAgreement();
    const before = (await (await publicView(s.token)).json()) as BuyerAgreementView;
    const view = await reviseTerms(createDb(env.DB), env, "seller_1", s.id, revised({ totalCents: 900_000, advanceCents: 300_000 }), Date.now(), { via: "chat" });
    expect(view.agreement.termsVersion).toBe(2);
    expect(view.agreement.termsSha256).not.toBe(before.agreement.termsSha256);
    expect(view.agreement.totalCents).toBe(900_000);
    expect(view.agreement.status).toBe("SHARED");
    expect(view.milestones.map((m) => m.amountCents)).toEqual([300_000, 600_000]);
    expect(view.milestones.every((m) => m.status === "PENDING_ACCEPTANCE" || m.status === "WAITING_DELIVERY")).toBe(true);
    const ev = view.events.find((e) => e.type === "TERMS_REVISED");
    expect(ev?.payload).toMatchObject({ termsVersion: 2, termsSha256: view.agreement.termsSha256, totalCents: 900_000, advanceCents: 300_000, via: "chat" });
    // el comprador ve el nuevo hash y el mismo enlace sigue válido
    const after = (await (await publicView(s.token)).json()) as BuyerAgreementView;
    expect(after.agreement.termsSha256).toBe(view.agreement.termsSha256);
    expect(after.events.some((e) => e.type === "TERMS_REVISED")).toBe(true);
  });

  it("aceptar con el hash viejo -> 409 TERMS_MISMATCH; con el nuevo -> ACCEPTED", async () => {
    const s = await newSharedAgreement();
    const old = (await (await publicView(s.token)).json()) as BuyerAgreementView;
    const v2 = await reviseTerms(createDb(env.DB), env, "seller_1", s.id, revised({ advanceCents: 300_000 }), Date.now());
    const bad = await call(`/api/public/tratos/${s.token}/accept`, { method: "POST", json: { buyerName: "Ana", termsSha256: old.agreement.termsSha256, consent: true } });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("TERMS_MISMATCH");
    const ok = await call(`/api/public/tratos/${s.token}/accept`, { method: "POST", json: { buyerName: "Ana", termsSha256: v2.agreement.termsSha256, consent: true } });
    expect(ok.status).toBe(200);
  });

  it("tras ACCEPTED -> 409 y nada cambia", async () => {
    const s = await newSharedAgreement();
    const v = (await (await publicView(s.token)).json()) as BuyerAgreementView;
    await call(`/api/public/tratos/${s.token}/accept`, { method: "POST", json: { buyerName: "Ana", termsSha256: v.agreement.termsSha256, consent: true } });
    const err = await reviseTerms(createDb(env.DB), env, "seller_1", s.id, revised({ totalCents: 900_000 }), Date.now()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(409);
    const after = (await (await publicView(s.token)).json()) as BuyerAgreementView;
    expect(after.agreement.termsVersion).toBe(1);
    expect(after.agreement.totalCents).toBe(1_000_000);
  });

  it("otro vendedor -> 404", async () => {
    const s = await newSharedAgreement();
    const err = await reviseTerms(createDb(env.DB), env, "seller_2", s.id, revised({}), Date.now()).catch((e: unknown) => e);
    expect((err as AppError).status).toBe(404);
  });

  it("con una solicitud de pago activa -> 409 (no se abandona)", async () => {
    const s = await newSharedAgreement();
    const m = await env.DB.prepare("SELECT id FROM milestones WHERE agreement_id = ? AND kind = 'ADVANCE'").bind(s.id).first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO payment_requests (id, milestone_id, method, provider_bank_account_id, amount_cents, num_ref, status, created_at) VALUES ('pr_rev', ?, 'CODI_QR', 'x', 400000, '1', 'AWAITING_PAYMENT', 1)",
    ).bind(m?.id).run();
    const err = await reviseTerms(createDb(env.DB), env, "seller_1", s.id, revised({}), Date.now()).catch((e: unknown) => e);
    expect((err as AppError).status).toBe(409);
  });
});
