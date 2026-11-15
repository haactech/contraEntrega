import { Hono } from "hono";
import {
  CreateSessionRequestSchema,
  type DemoSellersResponse,
  type HealthResponse,
  type SessionResponse,
} from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { parseJson } from "../lib/validate";
import { clientIp, rateLimit } from "../middleware/ratelimit";
import { clearSessionCookie, issueSessionCookie, requireSeller } from "../middleware/session";
import { authenticate, currentSeller, listDemoSellers } from "../services/sessions";

export const systemRoutes = new Hono<HonoEnv>();

systemRoutes.get("/health", (c) => c.json({ ok: true, mode: c.env.PAYMENTS_MODE, assistant: { enabled: false, provider: null, model: null } } satisfies HealthResponse));

systemRoutes.get("/demo/sellers", async (c) => {
  const sellers = await listDemoSellers(createDb(c.env.DB));
  return c.json({ sellers } satisfies DemoSellersResponse);
});

systemRoutes.post("/session", rateLimit("RL_PUBLIC_WRITE", (c) => `session:${clientIp(c)}`), async (c) => {
  const body = await parseJson(c, CreateSessionRequestSchema);
  const seller = await authenticate(createDb(c.env.DB), c.env, body.sellerId, body.pin);
  await issueSessionCookie(c, seller.id);
  return c.json({ seller } satisfies SessionResponse);
});

systemRoutes.get("/session", requireSeller, async (c) => {
  const seller = await currentSeller(createDb(c.env.DB), c.get("sellerId") as string);
  return c.json({ seller } satisfies SessionResponse);
});

systemRoutes.delete("/session", (c) => {
  clearSessionCookie(c);
  return c.body(null, 204);
});
