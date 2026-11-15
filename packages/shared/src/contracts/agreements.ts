import { z } from "zod";
import { checkSplit } from "../money";
import { DateOnlySchema, PhoneSchema } from "./common";
import {
  AgreementSummarySchema,
  EvidenceViewSchema,
  SellerAgreementViewSchema,
} from "./views";

export const CreateAgreementInputSchema = z
  .object({
    title: z.string().trim().min(3, "El título es muy corto.").max(120),
    description: z.string().trim().max(2000).default(""),
    acceptanceCriteria: z.string().trim().min(3, "Describe los criterios de entrega.").max(1000),
    buyerName: z.string().trim().min(2, "Escribe el nombre del comprador.").max(80),
    buyerPhone: PhoneSchema.optional(),
    dueDate: DateOnlySchema.optional(),
    totalCents: z.number().int().min(2).max(200_000_000),
    advanceCents: z.number().int().min(1).max(100_000_000),
  })
  .superRefine((v, ctx) => {
    const r = checkSplit(v.totalCents, v.advanceCents);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["advanceCents"], message: r.message });
  });
export type CreateAgreementInput = z.input<typeof CreateAgreementInputSchema>;
export type CreateAgreementData = z.output<typeof CreateAgreementInputSchema>;

export const ListAgreementsResponseSchema = z.object({
  agreements: z.array(AgreementSummarySchema),
});
export type ListAgreementsResponse = z.infer<typeof ListAgreementsResponseSchema>;

export const ShareAgreementRequestSchema = z.object({
  regenerate: z.boolean().optional(),
});
export type ShareAgreementRequest = z.infer<typeof ShareAgreementRequestSchema>;

export const ShareAgreementResponseSchema = z.object({
  shareUrl: z.string(),
  whatsappUrl: z.string(),
  agreement: SellerAgreementViewSchema,
});
export type ShareAgreementResponse = z.infer<typeof ShareAgreementResponseSchema>;

export const EVIDENCE_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPerRound: 3,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  /** Multipart field name. */
  fieldName: "file",
} as const;

export const UploadEvidenceResponseSchema = EvidenceViewSchema;
export type UploadEvidenceResponse = z.infer<typeof UploadEvidenceResponseSchema>;

export const RequestReviewRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type RequestReviewRequest = z.infer<typeof RequestReviewRequestSchema>;
export const RequestReviewResponseSchema = SellerAgreementViewSchema;
export type RequestReviewResponse = z.infer<typeof RequestReviewResponseSchema>;
