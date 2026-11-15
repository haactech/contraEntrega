import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES, ApiKeyViewSchema, CreateApiKeyResponseSchema, type ApiKeyView, type CreateApiKeyResponse } from "@trato/shared";
import { call, login, seedMock } from "./helpers";

beforeAll(seedMock);

const create = (cookie: string, label = "Mi agente") => call(API_ROUTES.apiKeys, { method: "POST", cookie, json: { label } });
const list = async (cookie: string): Promise<ApiKeyView[]> =>
  ((await (await call(API_ROUTES.apiKeys, { cookie })).json()) as { keys: ApiKeyView[] }).keys;

describe("api keys", () => {
  it("requiere sesión", async () => {
    expect((await call(API_ROUTES.apiKeys)).status).toBe(401);
    expect((await call(API_ROUTES.apiKeys, { method: "POST", json: { label: "x" } })).status).toBe(401);
  });

  it("crea: el secreto se muestra una vez y la base solo guarda el hash", async () => {
    const cookie = await login("seller_1");
    const res = await create(cookie, "Claude Desktop");
    expect(res.status).toBe(201);
    const body = CreateApiKeyResponseSchema.parse(await res.json());
    expect(body.secret).toMatch(/^trk_[A-Za-z0-9_-]{43}$/);
    expect(body.key.prefix).toBe(`${body.secret.slice(0, 8)}…`);
    expect(JSON.stringify(body.key)).not.toContain(body.secret);

    const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(body.key.id).first<Record<string, unknown>>();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.secret));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(row?.key_hash).toBe(hex);
    expect(JSON.stringify(row)).not.toContain(body.secret);
    expect(row?.label).toBe("Claude Desktop");

    const keys = await list(cookie);
    const mine = keys.find((k) => k.id === body.key.id);
    expect(mine).toBeDefined();
    ApiKeyViewSchema.parse(mine);
    expect(JSON.stringify(keys)).not.toContain(body.secret);
    expect(JSON.stringify(keys)).not.toContain("secret");
  });

  it("valida la etiqueta", async () => {
    const cookie = await login("seller_1");
    expect((await create(cookie, "  ")).status).toBe(400);
  });

  it("revoca (204, idempotente) y los otros prestadores no la ven ni la tocan (404)", async () => {
    const a = await login("seller_2");
    const b = await login("seller_3");
    const k = (await (await create(a)).json()) as CreateApiKeyResponse;
    expect((await list(b)).some((x) => x.id === k.key.id)).toBe(false);
    expect((await call(API_ROUTES.apiKey(k.key.id), { method: "DELETE", cookie: b })).status).toBe(404);
    expect((await list(a)).find((x) => x.id === k.key.id)?.revokedAt).toBeNull();

    const del = await call(API_ROUTES.apiKey(k.key.id), { method: "DELETE", cookie: a });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const first = (await list(a)).find((x) => x.id === k.key.id)?.revokedAt;
    expect(first).not.toBeNull();
    expect((await call(API_ROUTES.apiKey(k.key.id), { method: "DELETE", cookie: a })).status).toBe(204);
    expect((await list(a)).find((x) => x.id === k.key.id)?.revokedAt).toBe(first);
    expect((await call(API_ROUTES.apiKey("no-existe"), { method: "DELETE", cookie: a })).status).toBe(404);
  });

  it("máximo 5 llaves activas; revocar libera lugar", async () => {
    const cookie = await login("seller_4");
    const created: CreateApiKeyResponse[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await create(cookie, `k${i}`);
      expect(res.status).toBe(201);
      created.push((await res.json()) as CreateApiKeyResponse);
    }
    const sixth = await create(cookie, "k5");
    expect(sixth.status).toBe(409);
    await call(API_ROUTES.apiKey(created[0]!.key.id), { method: "DELETE", cookie });
    expect((await create(cookie, "k6")).status).toBe(201);
  });
});
