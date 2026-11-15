import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "../env";

/** Security headers for every /api response (spec §I). The token is in URLs: no referrer, no store. */
export const securityHeaders: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  if (!h.has("Content-Security-Policy")) {
    h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
};
