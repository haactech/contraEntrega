import { z } from "zod";
import { PaymentMethodSchema, ReviewDecisionSchema } from "../enums";
import { PhoneSchema, Sha256HexSchema } from "./common";
import { BuyerAgreementViewSchema, PaymentRequestViewSchema } from "./views";

export const PublicAgreementResponseSchema = BuyerAgreementViewSchema;
export type PublicAgreementResponse = z.infer<typeof PublicAgreementResponseSchema>;

export const AcceptAgreementRequestSchema = z.object({
  buyerName: z.string().trim().min(2, "Escribe tu nombre.").max(80),
  termsSha256: Sha256HexSchema,
  consent: z.literal(true, {
    errorMap: () => ({ message: "Debes aceptar las condiciones para continuar." }),
  }),
});
export type AcceptAgreementRequest = z.infer<typeof AcceptAgreementRequestSchema>;

export const CreatePaymentRequestSchema = z
  .object({
    method: PaymentMethodSchema,
    phoneNumber: PhoneSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === "CODI_PN" && !v.phoneNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phoneNumber"],
        message: "Escribe tu teléfono de 10 dígitos para enviar la solicitud.",
      });
    }
  });
export type CreatePaymentRequestInput = z.infer<typeof CreatePaymentRequestSchema>;

export const PaymentRequestResponseSchema = PaymentRequestViewSchema;
export type PaymentRequestResponse = z.infer<typeof PaymentRequestResponseSchema>;

export const ReviewRequestSchema = z
  .object({
    decision: ReviewDecisionSchema,
    comment: z.string().trim().max(1000).optional(),
    buyerName: z.string().trim().min(2, "Escribe tu nombre.").max(80),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "DISPUTE" && (v.comment ?? "").length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "Cuéntanos el problema (mínimo 5 caracteres).",
      });
    }
  });
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewResponseSchema = BuyerAgreementViewSchema;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
export const AcceptAgreementResponseSchema = BuyerAgreementViewSchema;
export type AcceptAgreementResponse = z.infer<typeof AcceptAgreementResponseSchema>;
