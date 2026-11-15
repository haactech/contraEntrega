import { afterEach, describe, expect, it, vi } from "vitest";
import { LivePeyGateway } from "../src/payments/live";

const gw = new LivePeyGateway("https://pey.test/", "SECRET_KEY");
const respond = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

describe("LivePeyGateway", () => {
  it("envia Bearer y valida la respuesta; ok", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ id: "Q1", qrString: "{}" }, 201));
    const r = await gw.createQr({ amount: 10, bankAccountId: "b" });
    expect(r).toEqual({ kind: "ok", data: { id: "Q1", qrString: "{}" } });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://pey.test/codi/qr");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer SECRET_KEY");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("4xx -> rejected con el error de pey", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ error: { message: "bad clabe", type: "INVALID_CLABE", requestId: "r1" } }, 400));
    const r = await gw.createQr({ amount: 10 });
    expect(r).toEqual({ kind: "rejected", status: 400, peyError: { message: "bad clabe", type: "INVALID_CLABE", requestId: "r1" } });
  });

  it("5xx, 503, 429, timeout, red y respuesta no parseable -> ambiguous", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const status of [500, 503, 429]) {
      spy.mockResolvedValueOnce(respond("oops", status));
      expect((await gw.createQr({ amount: 1 })).kind).toBe("ambiguous");
    }
    spy.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await gw.createQr({ amount: 1 })).toEqual({ kind: "ambiguous", reason: "timeout" });
    spy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await gw.createQr({ amount: 1 })).toEqual({ kind: "ambiguous", reason: "network_error" });
    spy.mockResolvedValueOnce(respond("<html>", 200));
    expect(await gw.createQr({ amount: 1 })).toEqual({ kind: "ambiguous", reason: "unparseable_response" });
    spy.mockResolvedValueOnce(respond({ unexpected: true }, 200));
    expect((await gw.getTransaction("T")).kind).toBe("ambiguous");
  });

  it("getQrTransactions sigue nextToken", async () => {
    const item = (id: string) => ({ id, status: "PAID", amount: 1 });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond({ items: [item("a")], nextToken: "n1" }))
      .mockResolvedValueOnce(respond({ items: [item("b")], nextToken: null }));
    const r = await gw.getQrTransactions("QR/1");
    expect(r.kind === "ok" && r.data.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(spy.mock.calls[1]![0]).toBe("https://pey.test/transaction/codi/qr/QR%2F1?nextToken=n1");
  });
});
