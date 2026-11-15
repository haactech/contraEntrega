import { Hono } from "hono";
import { CreateAgreementInputSchema, ShareAgreementRequestSchema } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { parseJson } from "../lib/validate";
import { requireSeller } from "../middleware/session";
import { createAgreement, getSellerView, listAgreements, shareAgreement } from "../services/agreements";

export const agreementRoutes = new Hono<HonoEnv>();
agreementRoutes.use("*", requireSeller);

const sellerId = (c: { get: (k: "sellerId") => string | null }): string => c.get("sellerId") as string;

agreementRoutes.get("/", async (c) => c.json(await listAgreements(createDb(c.env.DB), sellerId(c))));

agreementRoutes.post("/", async (c) => {
  const input = await parseJson(c, CreateAgreementInputSchema);
  const view = await createAgreement(createDb(c.env.DB), c.env, sellerId(c), input, Date.now());
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
  );
  return c.json(res);
});
