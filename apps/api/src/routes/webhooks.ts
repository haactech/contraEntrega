import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { getGateway } from "../payments/gateway";
import { WEBHOOK_MAX_BYTES, handlePeyWebhook } from "../payments/webhook";

export const webhookRoutes = new Hono<HonoEnv>();

/** Pey webhook: no rate limit (the provider retries), but the body size is capped. */
webhookRoutes.post("/pey", async (c) => {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > WEBHOOK_MAX_BYTES) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Cuerpo demasiado grande." } }, 413);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > WEBHOOK_MAX_BYTES) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Cuerpo demasiado grande." } }, 413);
  }
  const out = await handlePeyWebhook(c.env, getGateway(c.env), raw, c.req.raw.headers, Date.now());
  return c.json(out.body, out.httpStatus as 200);
});
