import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { API_ROUTES } from "@trato/shared";
import { createDb } from "../db/client";
import { evidence } from "../db/schema";
import type { HonoEnv } from "../env";
import { verifySignedUrl } from "../lib/crypto";
import { AppError, notFound } from "../lib/errors";

export const fileRoutes = new Hono<HonoEnv>();

/** Evidence bytes, authorized only by a valid HMAC-signed, unexpired URL. */
fileRoutes.get("/evidence/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await verifySignedUrl(
    c.env.SESSION_SECRET,
    API_ROUTES.evidenceFile(id),
    c.req.query("exp"),
    c.req.query("sig"),
    Date.now(),
  );
  if (!ok) throw new AppError("FORBIDDEN", "El enlace de la foto no es válido o ya venció.");
  const rows = await createDb(c.env.DB).select().from(evidence).where(eq(evidence.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("No encontramos esta foto.");
  const obj = await c.env.EVIDENCE.get(row.r2Key);
  if (!obj) throw notFound("No encontramos esta foto.");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? row.mimeType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});
