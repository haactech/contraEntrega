import { Hono } from "hono";
import { CreateApiKeyInputSchema, type ListApiKeysResponse } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { parseJson } from "../lib/validate";
import { clientIp, rateLimit } from "../middleware/ratelimit";
import { requireSeller } from "../middleware/session";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-keys";

export const apiKeyRoutes = new Hono<HonoEnv>();
apiKeyRoutes.use("*", requireSeller);

const sellerId = (c: { get: (k: "sellerId") => string | null }): string => c.get("sellerId") as string;
const writeLimit = rateLimit("RL_PUBLIC_WRITE", (c) => `ak:${clientIp(c)}:${sellerId(c)}`);

apiKeyRoutes.get("/", async (c) => {
  const keys = await listApiKeys(createDb(c.env.DB), sellerId(c));
  return c.json({ keys } satisfies ListApiKeysResponse);
});

apiKeyRoutes.post("/", writeLimit, async (c) => {
  const input = await parseJson(c, CreateApiKeyInputSchema);
  const res = await createApiKey(c.env, sellerId(c), input.label, Date.now());
  c.header("Cache-Control", "no-store");
  return c.json(res, 201);
});

apiKeyRoutes.delete("/:id", writeLimit, async (c) => {
  await revokeApiKey(createDb(c.env.DB), sellerId(c), c.req.param("id"), Date.now());
  return c.body(null, 204);
});
