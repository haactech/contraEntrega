import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, login, createAgreement, seedMock } from "./helpers";

beforeAll(seedMock);

describe("restricciones D1", () => {
  it("índice parcial: una sola solicitud activa por hito, pero varias históricas", async () => {
    const cookie = await login("seller_5");
    const a = await createAgreement(cookie);
    const ms = await env.DB.prepare("SELECT id FROM milestones WHERE agreement_id = ? AND kind = 'ADVANCE'").bind(a.agreement.id).first<{ id: string }>();
    const ins = (id: string, status: string) =>
      env.DB.prepare(
        "INSERT INTO payment_requests (id, milestone_id, method, provider_bank_account_id, amount_cents, num_ref, status, created_at) VALUES (?, ?, 'CODI_QR', 'mock_ba_5', 100, '0000001', ?, 1)",
      ).bind(id, ms?.id, status).run();
    await ins("pr1", "FAILED");
    await ins("pr2", "EXPIRED_LOCAL");
    await ins("pr3", "AWAITING_PAYMENT");
    await expect(ins("pr4", "CREATING")).rejects.toThrow(/UNIQUE/);
    await expect(ins("pr5", "CREATION_UNKNOWN")).rejects.toThrow(/UNIQUE/);
    await ins("pr6", "PAID");
  });

  it("UNIQUE(agreement_id, seq) y UNIQUE(agreement_id, kind)", async () => {
    const cookie = await login("seller_5");
    const a = await createAgreement(cookie);
    await expect(
      env.DB.prepare("INSERT INTO agreement_events (id, agreement_id, seq, event_type, actor_type, payload_json, occurred_at) VALUES ('x', ?, 1, 'AGREEMENT_SHARED', 'SYSTEM', '{}', 1)").bind(a.agreement.id).run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      env.DB.prepare("INSERT INTO milestones (id, agreement_id, kind, amount_cents, status) VALUES ('m', ?, 'ADVANCE', 1, 'ELIGIBLE')").bind(a.agreement.id).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("eventos concurrentes (share regenerar en paralelo) conservan seq único y consecutivo", async () => {
    const cookie = await login("seller_5");
    const a = await createAgreement(cookie);
    await call(`/api/agreements/${a.agreement.id}/share`, { method: "POST", cookie, json: {} });
    const rs = await Promise.all(
      [1, 2, 3].map(() => call(`/api/agreements/${a.agreement.id}/share`, { method: "POST", cookie, json: { regenerate: true } })),
    );
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const seqs = (await env.DB.prepare("SELECT seq FROM agreement_events WHERE agreement_id = ? ORDER BY seq").bind(a.agreement.id).all<{ seq: number }>()).results.map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM buyer_access WHERE agreement_id = ? AND revoked_at IS NULL").bind(a.agreement.id).first<{ n: number }>();
    expect(active?.n).toBe(1);
  });
});
