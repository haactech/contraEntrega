import { Hono } from "hono";
import { AcceptAgreementRequestSchema } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { parseJson } from "../lib/validate";
import { publicKey, rateLimit } from "../middleware/ratelimit";
import { forbidOwnerSeller, resolveToken } from "../middleware/session";
import { acceptAgreement, agreementVersion, etagFor, getBuyerView } from "../services/public";

export const publicRoutes = new Hono<HonoEnv>();

publicRoutes.use("/tratos/:token", resolveToken);
publicRoutes.use("/tratos/:token/*", resolveToken);

publicRoutes.get("/tratos/:token", rateLimit("RL_PUBLIC_READ", publicKey("r")), async (c) => {
  const db = createDb(c.env.DB);
  const { agreementId } = c.get("access");
  const version = await agreementVersion(db, agreementId);
  const etag = version === null ? null : etagFor(version);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (etag) {
    c.header("ETag", etag);
    const inm = c.req.header("If-None-Match");
    if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return c.body(null, 304);
  }
  const view = await getBuyerView(db, c.env, agreementId, Date.now());
  // Version may have advanced between the two reads: tag the response with the view's own version.
  c.header("ETag", etagFor(view.agreement.version));
  return c.json(view);
});

publicRoutes.post(
  "/tratos/:token/accept",
  rateLimit("RL_PUBLIC_WRITE", publicKey("w")),
  forbidOwnerSeller,
  async (c) => {
    const input = await parseJson(c, AcceptAgreementRequestSchema);
    const view = await acceptAgreement(createDb(c.env.DB), c.env, c.get("access").agreementId, input, Date.now());
    return c.json(view);
  },
);
