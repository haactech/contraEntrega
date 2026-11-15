import { Hono } from "hono";
import { AcceptAgreementRequestSchema, PostMessageInputSchema, ReviewRequestSchema, CreatePaymentRequestSchema, IDEMPOTENCY_KEY_HEADER } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { viaOf } from "../lib/via";
import { parseJson } from "../lib/validate";
import { publicKey, rateLimit } from "../middleware/ratelimit";
import { forbidOwnerSeller, resolveToken } from "../middleware/session";
import { expireStalePaymentRequests } from "../payments/expire";
import { createForBuyer, parseIdempotencyKey, refreshForBuyer } from "../services/payments";
import { evidenceWindow } from "../lib/url-window";
import { loadBundle } from "../repos/agreements";
import { exportResponse, renderExport } from "../services/export";
import { notFound } from "../lib/errors";
import { submitReview } from "../services/review";
import { respondWithView } from "./conversations";
import { conversationForAgreement, postBuyerMessage } from "../services/conversations";
import { runInBackground } from "../assistant/tasks";
import { acceptAgreement, agreementVersion, etagFor, getBuyerView } from "../services/public";

export const publicRoutes = new Hono<HonoEnv>();

publicRoutes.use("/tratos/:token", resolveToken);
publicRoutes.use("/tratos/:token/*", resolveToken);

publicRoutes.get("/tratos/:token", rateLimit("RL_PUBLIC_READ", publicKey("r")), async (c) => {
  const db = createDb(c.env.DB);
  const { agreementId } = c.get("access");
  // Lazy local expiry (no provider call); bumps the version so the ETag below is already fresh.
  await expireStalePaymentRequests(c.env, agreementId, Date.now());
  const now = Date.now();
  const win = evidenceWindow(now);
  const version = await agreementVersion(db, agreementId);
  const etag = version === null ? null : etagFor(version, win);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (etag) {
    c.header("ETag", etag);
    const inm = c.req.header("If-None-Match");
    if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return c.body(null, 304);
  }
  const view = await getBuyerView(db, c.env, agreementId, now);
  // Version may have advanced between the two reads: tag the response with the view's own version.
  c.header("ETag", etagFor(view.agreement.version, win));
  return c.json(view);
});

publicRoutes.post(
  "/tratos/:token/accept",
  rateLimit("RL_PUBLIC_WRITE", publicKey("w")),
  forbidOwnerSeller,
  async (c) => {
    const input = await parseJson(c, AcceptAgreementRequestSchema);
    const view = await acceptAgreement(createDb(c.env.DB), c.env, c.get("access").agreementId, input, Date.now(), { via: viaOf(c) });
    return c.json(view);
  },
);

publicRoutes.post(
  "/tratos/:token/milestones/:milestoneId/payment-requests",
  rateLimit("RL_PUBLIC_WRITE", publicKey("w")),
  async (c) => {
    // Unknown body fields (e.g. amount / bankAccountId) are stripped by the schema: never trusted.
    const input = await parseJson(c, CreatePaymentRequestSchema);
    const key = parseIdempotencyKey(c.req.header(IDEMPOTENCY_KEY_HEADER));
    const { view, created } = await createForBuyer(
      c.env,
      c.get("access").agreementId,
      c.req.param("milestoneId") ?? "",
      input,
      key,
      { via: viaOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return c.json(view, created ? 201 : 200);
  },
);

publicRoutes.post(
  "/tratos/:token/payment-requests/:id/refresh",
  rateLimit("RL_PUBLIC_READ", publicKey("rf")),
  async (c) => {
    const view = await refreshForBuyer(c.env, c.get("access").agreementId, c.req.param("id") ?? "", Date.now());
    c.header("Cache-Control", "no-store");
    return c.json(view);
  },
);

publicRoutes.post(
  "/tratos/:token/review",
  rateLimit("RL_PUBLIC_WRITE", publicKey("w")),
  forbidOwnerSeller,
  async (c) => {
    const input = await parseJson(c, ReviewRequestSchema);
    const view = await submitReview(createDb(c.env.DB), c.env, c.get("access").agreementId, input, Date.now(), { via: viaOf(c) });
    c.header("Cache-Control", "no-store");
    return c.json(view);
  },
);

publicRoutes.get("/tratos/:token/export", rateLimit("RL_PUBLIC_READ", publicKey("x")), async (c) => {
  const b = await loadBundle(createDb(c.env.DB), c.get("access").agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  return exportResponse(await renderExport(c.env, b, "buyer", Date.now()));
});

publicRoutes.get("/tratos/:token/conversation", rateLimit("RL_PUBLIC_READ", publicKey("c")), async (c) => {
  const conv = await conversationForAgreement(c.env, createDb(c.env.DB), c.get("access").agreementId, Date.now());
  return respondWithView(c, conv.id, "BUYER", { "Referrer-Policy": "no-referrer" });
});

publicRoutes.post(
  "/tratos/:token/messages",
  rateLimit("RL_PUBLIC_WRITE", publicKey("w")),
  forbidOwnerSeller,
  async (c) => {
    const input = await parseJson(c, PostMessageInputSchema);
    const { view, background } = await postBuyerMessage(c.env, createDb(c.env.DB), c.get("access").agreementId, input.text, Date.now());
    if (background) runInBackground(c, background());
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.json(view);
  },
);
