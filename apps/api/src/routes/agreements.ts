import { Hono } from "hono";
import { CreateAgreementInputSchema, EVIDENCE_LIMITS, RequestReviewRequestSchema, ShareAgreementRequestSchema } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { viaOf } from "../lib/via";
import { parseJson } from "../lib/validate";
import { requireSeller } from "../middleware/session";
import { AppError } from "../lib/errors";
import { addEvidence, assertDeclaredSize, removeEvidence, requestReview } from "../services/evidence";
import { exportResponse, renderExport } from "../services/export";
import { createAgreement, getSellerView, listAgreements, loadOwned, shareAgreement } from "../services/agreements";

export const agreementRoutes = new Hono<HonoEnv>();
agreementRoutes.use("*", requireSeller);

const sellerId = (c: { get: (k: "sellerId") => string | null }): string => c.get("sellerId") as string;

agreementRoutes.get("/", async (c) => c.json(await listAgreements(createDb(c.env.DB), sellerId(c))));

agreementRoutes.post("/", async (c) => {
  const input = await parseJson(c, CreateAgreementInputSchema);
  const view = await createAgreement(createDb(c.env.DB), c.env, sellerId(c), input, Date.now(), { via: viaOf(c) });
  return c.json(view, 201);
});

agreementRoutes.get("/:id", async (c) =>
  c.json(await getSellerView(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), Date.now())),
);

agreementRoutes.post("/:id/share", async (c) => {
  const body = await parseJson(c, ShareAgreementRequestSchema, true);
  const res = await shareAgreement(
    createDb(c.env.DB),
    c.env,
    sellerId(c),
    c.req.param("id"),
    body.regenerate === true,
    Date.now(),
    { via: viaOf(c) },
  );
  return c.json(res);
});

agreementRoutes.post("/:id/evidence", async (c) => {
  assertDeclaredSize(c.req.header("content-length"));
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Envía la foto como multipart/form-data.");
  }
  const file = form.get(EVIDENCE_LIMITS.fieldName);
  if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "Falta el archivo de la foto.");
  const view = await addEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), file, Date.now());
  return c.json(view, 201);
});

agreementRoutes.delete("/:id/evidence/:evidenceId", async (c) => {
  await removeEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), c.req.param("evidenceId"), Date.now());
  return c.body(null, 204);
});

agreementRoutes.post("/:id/request-review", async (c) => {
  const body = await parseJson(c, RequestReviewRequestSchema, true);
  return c.json(await requestReview(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), body, Date.now()));
});

agreementRoutes.get("/:id/export", async (c) => {
  const b = await loadOwned(createDb(c.env.DB), sellerId(c), c.req.param("id"));
  return exportResponse(await renderExport(c.env, b, "seller", Date.now()));
});
