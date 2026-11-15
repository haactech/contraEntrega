import { z } from "zod";
import { checkSplit } from "../money";
import { DateOnlySchema, PhoneSchema } from "./common";
import { TASK_LIMITS } from "../tasks";
import {
  AgreementSummarySchema,
  EvidenceViewSchema,
  SellerAgreementViewSchema,
  TaskViewSchema,
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

export const CleaningTaskInputSchema = z.object({
  title: z.string().trim().min(2, "El nombre de la tarea es muy corto.").max(80),
  description: z.string().trim().max(300).optional(),
});
export type CleaningTaskInput = z.infer<typeof CleaningTaskInputSchema>;

export const CreateCleaningAgreementInputSchema = z
  .object({
    serviceType: z.literal("CLEANING"),
    title: z.string().trim().min(3, "El título es muy corto.").max(120).default("Limpieza de departamento"),
    description: z.string().trim().max(2000).default(""),
    buyerName: z.string().trim().min(2, "Escribe el nombre del cliente.").max(80),
    buyerPhone: PhoneSchema.optional(),
    dueDate: DateOnlySchema.optional(),
    totalCents: z.number().int().min(1).max(200_000_000),
    tasks: z
      .array(CleaningTaskInputSchema)
      .min(TASK_LIMITS.minTasks, "Agrega al menos una tarea.")
      .max(TASK_LIMITS.maxTasks, `Máximo ${TASK_LIMITS.maxTasks} tareas.`),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.tasks.forEach((t, i) => {
      const key = t.title.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", i, "title"],
          message: "Hay tareas con el mismo nombre.",
        });
      }
      seen.add(key);
    });
  });
export type CreateCleaningAgreementInput = z.input<typeof CreateCleaningAgreementInputSchema>;
export type CreateCleaningAgreementData = z.output<typeof CreateCleaningAgreementInputSchema>;

const isCleaningPayload = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as { serviceType?: unknown }).serviceType === "CLEANING";

/** Dispatches on `serviceType` (generic when absent) so errors come from the right schema. */
export const CreateAnyAgreementInputSchema = z
  .custom<CreateCleaningAgreementInput | CreateAgreementInput>((v) => typeof v === "object" && v !== null, {
    message: "Cuerpo inválido.",
  })
  .superRefine((v, ctx) => {
    const r = isCleaningPayload(v)
      ? CreateCleaningAgreementInputSchema.safeParse(v)
      : CreateAgreementInputSchema.safeParse(v);
    if (!r.success) for (const issue of r.error.issues) ctx.addIssue(issue);
  })
  .transform((v): CreateCleaningAgreementData | CreateAgreementData =>
    isCleaningPayload(v) ? CreateCleaningAgreementInputSchema.parse(v) : CreateAgreementInputSchema.parse(v),
  );
export type CreateAnyAgreementInput = z.input<typeof CreateAnyAgreementInputSchema>;
export type CreateAnyAgreementData = z.output<typeof CreateAnyAgreementInputSchema>;

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

export const SubmitTaskRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type SubmitTaskRequest = z.infer<typeof SubmitTaskRequestSchema>;
export const SubmitTaskResponseSchema = TaskViewSchema;
export type SubmitTaskResponse = z.infer<typeof SubmitTaskResponseSchema>;

export const RequestAdjustmentRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(TASK_LIMITS.reasonMin, "Explica brevemente qué falta.")
    .max(TASK_LIMITS.reasonMax),
});
export type RequestAdjustmentRequest = z.infer<typeof RequestAdjustmentRequestSchema>;
export const RequestAdjustmentResponseSchema = TaskViewSchema;
export type RequestAdjustmentResponse = z.infer<typeof RequestAdjustmentResponseSchema>;
