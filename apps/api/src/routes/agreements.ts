import { Hono } from "hono";
import { CreateAnyAgreementInputSchema, EVIDENCE_LIMITS, EvidenceKindSchema, RequestReviewRequestSchema, ShareAgreementRequestSchema, SubmitTaskRequestSchema } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { viaOf } from "../lib/via";
import { parseJson } from "../lib/validate";
import { requireSeller } from "../middleware/session";
import { AppError } from "../lib/errors";
import { addEvidence, assertDeclaredSize, removeEvidence, requestReview } from "../services/evidence";
import { addTaskEvidence, removeTaskEvidence, submitTask } from "../services/tasks";
import { exportResponse, renderExport } from "../services/export";
import { createAgreement, getSellerView, listAgreements, loadOwned, shareAgreement } from "../services/agreements";

export const agreementRoutes = new Hono<HonoEnv>();
agreementRoutes.use("*", requireSeller);

const sellerId = (c: { get: (k: "sellerId") => string | null }): string => c.get("sellerId") as string;

agreementRoutes.get("/", async (c) => c.json(await listAgreements(createDb(c.env.DB), sellerId(c))));

agreementRoutes.post("/", async (c) => {
  const input = await parseJson(c, CreateAnyAgreementInputSchema);
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
  const view = await addEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), file, Date.now(), { via: viaOf(c) });
  return c.json(view, 201);
});

agreementRoutes.delete("/:id/evidence/:evidenceId", async (c) => {
  await removeEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), c.req.param("evidenceId"), Date.now());
  return c.body(null, 204);
});

agreementRoutes.post("/:id/tasks/:taskId/evidence", async (c) => {
  assertDeclaredSize(c.req.header("content-length"));
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Envía la foto como multipart/form-data.");
  }
  const file = form.get(EVIDENCE_LIMITS.fieldName);
  if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "Falta el archivo de la foto.");
  const rawKind = form.get("kind");
  const kind = EvidenceKindSchema.safeParse(rawKind === null || rawKind === "" ? "AFTER" : rawKind);
  if (!kind.success) throw new AppError("VALIDATION_ERROR", "El tipo de foto debe ser BEFORE o AFTER.");
  const view = await addTaskEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), c.req.param("taskId"), file, kind.data, Date.now(), { via: viaOf(c) });
  return c.json(view, 201);
});

agreementRoutes.delete("/:id/tasks/:taskId/evidence/:evidenceId", async (c) => {
  await removeTaskEvidence(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), c.req.param("taskId"), c.req.param("evidenceId"), Date.now());
  return c.body(null, 204);
});

agreementRoutes.post("/:id/tasks/:taskId/submit", async (c) => {
  const body = await parseJson(c, SubmitTaskRequestSchema, true);
  const view = await submitTask(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), c.req.param("taskId"), body.note, Date.now(), { via: viaOf(c) });
  return c.json(view);
});

agreementRoutes.post("/:id/request-review", async (c) => {
  const body = await parseJson(c, RequestReviewRequestSchema, true);
  return c.json(await requestReview(createDb(c.env.DB), c.env, sellerId(c), c.req.param("id"), body, Date.now(), { via: viaOf(c) }));
});

agreementRoutes.get("/:id/export", async (c) => {
  const b = await loadOwned(createDb(c.env.DB), sellerId(c), c.req.param("id"));
  return exportResponse(await renderExport(c.env, b, "seller", Date.now()));
});
