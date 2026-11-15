import {
  CreateAgreementInputSchema,
  EVIDENCE_LIMITS,
  RequestReviewRequestSchema,
  mcpTermsToCreateInput,
} from "@trato/shared";
import { AppError } from "../lib/errors";
import { loadBundle } from "../repos/agreements";
import { createAgreement, listAgreements, loadOwned, shareAgreement } from "../services/agreements";
import { addEvidence, requestReview } from "../services/evidence";
import { renderExport } from "../services/export";
import { submitTask } from "../services/tasks";
import { actionsFor, sellerOutput } from "./views";
import { MCP_VIA, sellerActor, type McpContext, type McpHandlers } from "./context";

type SellerHandlers = Pick<
  McpHandlers,
  "list_agreements" | "get_agreement" | "create_agreement" | "share_agreement" | "add_evidence" | "request_review" | "submit_task" | "export_agreement"
>;

/** Seller tools always run with a verified api key (the registry rejects anonymous callers first). */
function seller(ctx: McpContext): { sellerId: string; opts: { via: typeof MCP_VIA; actorRef: string } } {
  if (!ctx.apiKey) throw new AppError("UNAUTHORIZED", "Se requiere una llave de API.");
  return { sellerId: ctx.apiKey.sellerId, opts: { via: MCP_VIA, actorRef: sellerActor(ctx.apiKey) } };
}

/** Strict base64 -> bytes. The schema already checked the alphabet; this guards the padding/length. */
function decodeBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Base64 inválido: envía solo los datos de la imagen, sin prefijo data:.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const sellerHandlers: SellerHandlers = {
  async list_agreements(ctx, input) {
    const { sellerId } = seller(ctx);
    const { agreements } = await listAgreements(ctx.db, sellerId);
    const picked = agreements.filter((a) => !input.status || a.status === input.status).slice(0, input.limit ?? 50);
    const withActions = await Promise.all(
      picked.map(async (a) => {
        const b = await loadBundle(ctx.db, a.id);
        return { ...a, allowedActions: b ? actionsFor(b, "SELLER", ctx.now) : [] };
      }),
    );
    return { agreements: withActions, allowedActions: [] };
  },

  async get_agreement(ctx, input) {
    return sellerOutput(ctx.env, ctx.db, seller(ctx).sellerId, input.agreementId, ctx.now);
  },

  async create_agreement(ctx, input) {
    const { sellerId, opts } = seller(ctx);
    // Same business rules as the HTTP route (advance < total, limits, ...).
    const parsed = CreateAgreementInputSchema.safeParse(mcpTermsToCreateInput(input));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Datos inválidos.");
    const created = await createAgreement(ctx.db, ctx.env, sellerId, parsed.data, ctx.now, opts);
    return sellerOutput(ctx.env, ctx.db, sellerId, created.agreement.id, ctx.now);
  },

  async share_agreement(ctx, input) {
    const { sellerId, opts } = seller(ctx);
    const res = await shareAgreement(ctx.db, ctx.env, sellerId, input.agreementId, input.regenerate === true, ctx.now, opts);
    const out = await sellerOutput(ctx.env, ctx.db, sellerId, input.agreementId, ctx.now);
    return { ...out, shareUrl: res.shareUrl, whatsappUrl: res.whatsappUrl };
  },

  async add_evidence(ctx, input) {
    const { sellerId, opts } = seller(ctx);
    const bytes = decodeBase64(input.imageBase64);
    if (bytes.byteLength > EVIDENCE_LIMITS.maxBytes) {
      throw new AppError("VALIDATION_ERROR", "La foto pesa más de 5 MB. Comprímela e inténtalo de nuevo.");
    }
    // Same service as the HTTP upload: size, magic bytes (declared type is ignored), limits, R2 + event.
    const file = new File([bytes], "evidencia", { type: input.mediaType });
    const evidence = await addEvidence(ctx.db, ctx.env, sellerId, input.agreementId, file, ctx.now, opts);
    const b = await loadOwned(ctx.db, sellerId, input.agreementId);
    const balance = b.milestones.find((m) => m.kind === "BALANCE");
    return {
      evidence,
      unsubmittedCount: balance ? b.evidence.filter((e) => e.milestoneId === balance.id && !e.submitted).length : 0,
      allowedActions: actionsFor(b, "SELLER", ctx.now),
    };
  },

  async request_review(ctx, input) {
    const { sellerId, opts } = seller(ctx);
    const body = RequestReviewRequestSchema.parse(input.note ? { note: input.note } : {});
    await requestReview(ctx.db, ctx.env, sellerId, input.agreementId, body, ctx.now, opts);
    return sellerOutput(ctx.env, ctx.db, sellerId, input.agreementId, ctx.now);
  },

  async submit_task(ctx, input) {
    const { sellerId, opts } = seller(ctx);
    await submitTask(ctx.db, ctx.env, sellerId, input.agreementId, input.taskId, input.note, ctx.now, opts);
    return sellerOutput(ctx.env, ctx.db, sellerId, input.agreementId, ctx.now);
  },

  async export_agreement(ctx, input) {
    const { sellerId } = seller(ctx);
    const b = await loadOwned(ctx.db, sellerId, input.agreementId);
    const { html } = await renderExport(ctx.env, b, "seller", ctx.now);
    return { filename: `trato-${b.agreement.code}.html`, mimeType: "text/html" as const, html, allowedActions: actionsFor(b, "SELLER", ctx.now) };
  },
};
