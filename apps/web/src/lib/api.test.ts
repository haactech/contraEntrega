import { describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@trato/shared";
import { ApiError, createApiClient } from "./api";
import { friendlyError } from "./errors";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });

const SHA = "a".repeat(64);
const view = {
  agreement: {
    id: "a1", code: "TR-0001", title: "Reja", description: "", acceptanceCriteria: "ok", buyerName: "Ana",
    buyerPhoneMasked: null, dueDate: null, totalCents: 100000, status: "SHARED", termsSha256: SHA,
    termsVersion: 1, sharedAt: "2026-11-14T10:00:00.000Z", buyerAcceptedAt: null, buyerAcceptedName: null,
    completedAt: null, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", version: 3,
  },
  seller: { displayName: "Luis", trade: "Herrería" },
  payee: { alias: "Cuenta demo 1", last4: "1234" },
  milestones: [], paymentRequests: [], evidence: [], reviews: [], events: [],
  activePaymentRequest: null, nextAction: "ACCEPT",
};

describe("apiClient", () => {
  it("throws ApiError with the server code from the error envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ error: { code: "PAYMENT_PENDING_RECONCILIATION", message: "x" } }, { status: 409 }),
    );
    const api = createApiClient(fetchMock);
    const err = await api.refreshPaymentRequest("tok", "pr1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("PAYMENT_PENDING_RECONCILIATION");
    expect((err as ApiError).status).toBe(409);
    expect(friendlyError(err)).toBe("Estamos verificando un intento anterior, intenta en unos minutos.");
  });

  it("maps network failures to NETWORK", async () => {
    const api = createApiClient(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api.health().catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("NETWORK");
  });

  it("falls back to RATE_LIMITED on a non-envelope 429", async () => {
    const api = createApiClient(vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    const err = await api.health().catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("RATE_LIMITED");
  });

  it("rejects responses that do not match the shared schema", async () => {
    const api = createApiClient(vi.fn().mockResolvedValue(json({ ok: true, mode: "bogus" })));
    const err = await api.health().catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("BAD_RESPONSE");
  });

  it("sends credentials: include and parses a valid response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, mode: "mock", assistant: { enabled: false, provider: null, model: null } }));
    const api = createApiClient(fetchMock);
    await expect(api.health()).resolves.toEqual({ ok: true, mode: "mock", assistant: { enabled: false, provider: null, model: null } });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", method: "GET" });
  });

  it("returns notModified on 304 and sends If-None-Match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const api = createApiClient(fetchMock);
    const r = await api.getPublicAgreement("tok", '"v3"');
    expect(r).toEqual({ notModified: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('"v3"');
  });

  it("returns data and etag on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(view, { headers: { ETag: '"v3"', "Content-Type": "application/json" } }));
    const api = createApiClient(fetchMock);
    const r = await api.getPublicAgreement("tok");
    expect(r.notModified).toBe(false);
    if (!r.notModified) {
      expect(r.etag).toBe('"v3"');
      expect(r.data.agreement.code).toBe("TR-0001");
    }
  });

  it("sends the Idempotency-Key header when creating a payment request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const api = createApiClient(fetchMock);
    await api.createPaymentRequest("tok", "m1", { method: "CODI_QR" }, "key-123").catch(() => undefined);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]).toBe("key-123");
  });

  it("handles 204 on logout", async () => {
    const api = createApiClient(vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
