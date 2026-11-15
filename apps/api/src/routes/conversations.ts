import { Hono } from "hono";
import type { Context } from "hono";
import { PostMessageInputSchema, type ConversationView, type ListConversationsResponse } from "@trato/shared";
import { createDb } from "../db/client";
import type { HonoEnv } from "../env";
import { requireSeller } from "../middleware/session";
import { conversationEtag, etagOfView, buildConversationView, listConversationSummaries } from "../services/conversation-view";
import { confirmProposal, createConversation, loadOwnedConversation, postSellerMessage } from "../services/conversations";
import { runInBackground } from "../assistant/tasks";
import { viaOf } from "../lib/via";
import { parseJson } from "../lib/validate";

export const conversationRoutes = new Hono<HonoEnv>();
conversationRoutes.use("*", requireSeller);

const sellerId = (c: { get: (k: "sellerId") => string | null }): string => c.get("sellerId") as string;

/** `If-None-Match` matches (weak validators allowed). */
export const etagMatches = (header: string | undefined, etag: string): boolean =>
  header !== undefined && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);

/** Shared by seller and buyer GET: 304 when nothing changed, else the view tagged with its own versions. */
export async function respondWithView(
  c: Context<HonoEnv>,
  conversationId: string,
  role: "SELLER" | "BUYER",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const db = createDb(c.env.DB);
  const now = Date.now();
  c.header("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extraHeaders)) c.header(k, v);
  // Lazy local expiry of payment requests happens inside the view; check the cheap fingerprint first.
  const etag = await conversationEtag(c.env, db, conversationId, now);
  if (etag) {
    c.header("ETag", etag);
    if (etagMatches(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  }
  const view: ConversationView = await buildConversationView(c.env, db, conversationId, role, now);
  c.header("ETag", etagOfView(view, now));
  return c.json(view);
}

conversationRoutes.post("/", async (c) => {
  const view = await createConversation(c.env, createDb(c.env.DB), sellerId(c), Date.now());
  c.header("Cache-Control", "no-store");
  return c.json(view, 201);
});

conversationRoutes.get("/", async (c) => {
  const conversations = await listConversationSummaries(createDb(c.env.DB), c.env.DB, sellerId(c));
  c.header("Cache-Control", "no-store");
  return c.json({ conversations } satisfies ListConversationsResponse);
});

conversationRoutes.get("/:id", async (c) => {
  const conv = await loadOwnedConversation(createDb(c.env.DB), sellerId(c), c.req.param("id"));
  return respondWithView(c, conv.id, "SELLER");
});

conversationRoutes.post("/:id/messages", async (c) => {
  const input = await parseJson(c, PostMessageInputSchema);
  const { view, background } = await postSellerMessage(c.env, createDb(c.env.DB), sellerId(c), c.req.param("id"), input.text, Date.now());
  if (background) runInBackground(c, background());
  c.header("Cache-Control", "no-store");
  return c.json(view);
});

conversationRoutes.post("/:id/proposals/:proposalId/confirm", async (c) => {
  const res = await confirmProposal(
    c.env,
    createDb(c.env.DB),
    sellerId(c),
    c.req.param("id"),
    c.req.param("proposalId"),
    Date.now(),
    viaOf(c) ?? "chat",
  );
  c.header("Cache-Control", "no-store");
  return c.json(res);
});
