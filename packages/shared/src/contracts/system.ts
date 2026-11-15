import { z } from "zod";
import { PaymentsModeSchema, WebhookProcessingStatusSchema } from "../enums";
import { SellerSummarySchema } from "./views";

export const HealthResponseSchema = z.object({ ok: z.literal(true), mode: PaymentsModeSchema });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DemoSellersResponseSchema = z.object({ sellers: z.array(SellerSummarySchema) });
export type DemoSellersResponse = z.infer<typeof DemoSellersResponseSchema>;

export const CreateSessionRequestSchema = z.object({
  sellerId: z.string().min(1),
  pin: z.string().min(1).max(64),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionResponseSchema = z.object({ seller: SellerSummarySchema });
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SimulatePaymentRequestSchema = z.object({ paymentRequestId: z.string().min(1) });
export type SimulatePaymentRequest = z.infer<typeof SimulatePaymentRequestSchema>;

export const SimulatePaymentResponseSchema = z.object({
  ok: z.literal(true),
  processingStatus: WebhookProcessingStatusSchema,
});
export type SimulatePaymentResponse = z.infer<typeof SimulatePaymentResponseSchema>;
