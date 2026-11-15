import { AcceptAgreementRequestSchema, CreatePaymentRequestSchema, ReviewRequestSchema } from "@trato/shared";
import { AppError, notFound } from "../lib/errors";
import { loadBundle } from "../repos/agreements";
import { createForBuyer, refreshForBuyer } from "../services/payments";
import { acceptAgreement } from "../services/public";
import { submitReview } from "../services/review";
import { reviewTask } from "../services/tasks";
import { MCP_VIA, buyerAgreementOf, type McpHandlers } from "./context";
import { actionsFor, buyerOutput } from "./views";

type BuyerHandlers = Pick<
  McpHandlers,
  "buyer_get_agreement" | "buyer_accept" | "buyer_review" | "review_task" | "buyer_create_payment_request" | "buyer_refresh_payment"
>;

const via = { via: MCP_VIA } as const;

const parseOrThrow = <T>(r: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }): T => {
  if (!r.success) throw new AppError("VALIDATION_ERROR", r.error.issues[0]?.message ?? "Datos inválidos.");
  return r.data;
};

export const buyerHandlers: BuyerHandlers = {
  async buyer_get_agreement(ctx) {
    return buyerOutput(ctx.env, ctx.db, buyerAgreementOf(ctx), ctx.now);
  },

  async buyer_accept(ctx, input) {
    const agreementId = buyerAgreementOf(ctx);
    const body = parseOrThrow(
      AcceptAgreementRequestSchema.safeParse({ buyerName: input.buyerName, termsSha256: input.termsSha256, consent: input.consent }),
    );
    await acceptAgreement(ctx.db, ctx.env, agreementId, body, ctx.now, via);
    return buyerOutput(ctx.env, ctx.db, agreementId, ctx.now);
  },

  async buyer_review(ctx, input) {
    const agreementId = buyerAgreementOf(ctx);
    const body = parseOrThrow(
      ReviewRequestSchema.safeParse({
        decision: input.decision,
        buyerName: input.buyerName,
        ...(input.comment ? { comment: input.comment } : {}),
      }),
    );
    await submitReview(ctx.db, ctx.env, agreementId, body, ctx.now, via);
    return buyerOutput(ctx.env, ctx.db, agreementId, ctx.now);
  },

  async review_task(ctx, input) {
    // The registry already rejected the owner's own key (FORBIDDEN) before getting here.
    const agreementId = buyerAgreementOf(ctx);
    await reviewTask(ctx.db, ctx.env, agreementId, input.taskId, input.decision, input.reason, ctx.now, via);
    return buyerOutput(ctx.env, ctx.db, agreementId, ctx.now);
  },

  async buyer_create_payment_request(ctx, input) {
    const agreementId = buyerAgreementOf(ctx);
    const body = parseOrThrow(
      CreatePaymentRequestSchema.safeParse({ method: input.method, ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}) }),
    );
    const b = await loadBundle(ctx.db, agreementId);
    const milestone = b?.milestones.find((m) => m.kind === input.milestoneKind);
    if (!b || !milestone) throw notFound("Este enlace no existe o ya no está vigente.");
    // Amount and payee account come from the DB inside the service; nothing monetary is taken from the agent.
    const { view } = await createForBuyer(ctx.env, agreementId, milestone.id, body, null, via);
    const fresh = await loadBundle(ctx.db, agreementId);
    return { paymentRequest: view, allowedActions: fresh ? actionsFor(fresh, "BUYER", ctx.now) : [] };
  },

  async buyer_refresh_payment(ctx, input) {
    const agreementId = buyerAgreementOf(ctx);
    const view = await refreshForBuyer(ctx.env, agreementId, input.paymentRequestId, ctx.now);
    const b = await loadBundle(ctx.db, agreementId);
    return { paymentRequest: view, allowedActions: b ? actionsFor(b, "BUYER", ctx.now) : [] };
  },
};
