import { z } from "zod";
import type { MilestoneKind } from "./enums";

/** Pey API contract (verified against docs/pey-openapi.json) used by the backend gateway. */

export const PEY_LIMITS = {
  conceptMaxLength: 40,
  metadataMaxKeys: 50,
  metadataKeyMaxLength: 40,
  metadataValueMaxLength: 500,
  qrExpirationSeconds: 86_400,
  pnExpirationSeconds: 600,
  minExpirationSeconds: 360,
  numRefMaxDigits: 7,
} as const;

const NumRefSchema = z.string().regex(/^[0-9]{1,7}$/);

export const PeyMetadataInputSchema = z
  .record(
    z.string().max(PEY_LIMITS.metadataKeyMaxLength),
    z.union([z.string().max(PEY_LIMITS.metadataValueMaxLength), z.number(), z.boolean(), z.null()]),
  )
  .refine((m) => Object.keys(m).length <= PEY_LIMITS.metadataMaxKeys, "Demasiadas claves de metadata.");

// ---- POST /codi/qr --------------------------------------------------------

export const PeyCreateQrRequestSchema = z.object({
  amount: z.number().min(0),
  concept: z.string().max(PEY_LIMITS.conceptMaxLength).optional(),
  expiration: z.number().int().min(0).optional(),
  numRef: NumRefSchema.optional(),
  generateImage: z.boolean().optional(),
  bankAccountId: z.string().min(1).optional(),
  metadata: PeyMetadataInputSchema.optional(),
});
export type PeyCreateQrRequest = z.infer<typeof PeyCreateQrRequestSchema>;

export const PeyCreateQrResponseSchema = z
  .object({
    id: z.string().min(1),
    qrString: z.string().min(1),
    qrImage: z.string().nullable().optional(),
  })
  .passthrough();
export type PeyCreateQrResponse = z.infer<typeof PeyCreateQrResponseSchema>;

// ---- POST /codi/pn --------------------------------------------------------

export const PeyCreatePnRequestSchema = z.object({
  amount: z.number().gt(0).max(1_000_000),
  phoneNumber: z.string().regex(/^[0-9]{10}$/),
  concept: z.string().max(PEY_LIMITS.conceptMaxLength).optional(),
  expiration: z.number().int().min(PEY_LIMITS.minExpirationSeconds).optional(),
  numRef: NumRefSchema.optional(),
  bankAccountId: z.string().min(1).optional(),
  metadata: PeyMetadataInputSchema.optional(),
});
export type PeyCreatePnRequest = z.infer<typeof PeyCreatePnRequestSchema>;

export const PeyCreatePnResponseSchema = z
  .object({
    transactionId: z.string().min(1),
    codiId: z.string().optional(),
  })
  .passthrough();
export type PeyCreatePnResponse = z.infer<typeof PeyCreatePnResponseSchema>;

// ---- GET /bank-account/{id} ----------------------------------------------

export const PEY_CODI_STATUSES = ["PENDING", "PROCESSING", "ACTIVE", "ERROR"] as const;
export const PeyBankAccountSchema = z
  .object({
    id: z.string(),
    alias: z.string().optional(),
    name: z.string().optional(),
    clabe: z.string().optional(),
    entity: z.enum(["BUSINESS", "PERSON"]).optional(),
    taxId: z.string().optional(),
    codiStatus: z.enum(PEY_CODI_STATUSES),
    errorMessage: z.string().optional(),
    dateCreated: z.number().optional(),
  })
  .passthrough();
export type PeyBankAccount = z.infer<typeof PeyBankAccountSchema>;

export const PeyCodiStatusSchema = z.enum(PEY_CODI_STATUSES);
export type PeyCodiStatus = z.infer<typeof PeyCodiStatusSchema>;

// ---- POST /bank-account ---------------------------------------------------

export const PeyRegisterBankAccountRequestSchema = z.object({
  alias: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  clabe: z.string().regex(/^[0-9]{18}$/),
  entity: z.enum(["BUSINESS", "PERSON"]),
});
export type PeyRegisterBankAccountRequest = z.infer<typeof PeyRegisterBankAccountRequestSchema>;

export const PeyRegisterBankAccountResponseSchema = z
  .object({ id: z.string().min(1), codiStatus: PeyCodiStatusSchema })
  .passthrough();
export type PeyRegisterBankAccountResponse = z.infer<typeof PeyRegisterBankAccountResponseSchema>;

// ---- Transactions ---------------------------------------------------------

export const PeyAmountBreakdownSchema = z
  .object({
    base: z.number().optional(),
    tip: z.number().optional(),
    fee: z.number().optional(),
  })
  .passthrough();
export type PeyAmountBreakdown = z.infer<typeof PeyAmountBreakdownSchema>;

/** Metadata returned by pey. externalMetadata values are always strings. */
export const PeyTransactionMetadataSchema = z
  .object({
    clabe: z.string().optional(),
    bankCode: z.union([z.number(), z.string()]).optional(),
    accountType: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
    trackingKey: z.string().optional(),
    externalMetadata: z.record(z.string()).optional(),
  })
  .passthrough();
export type PeyTransactionMetadata = z.infer<typeof PeyTransactionMetadataSchema>;

export const PEY_TRANSACTION_STATUSES = ["PENDING", "PAID"] as const;
export const PeyTransactionSchema = z
  .object({
    id: z.string(),
    status: z.enum(PEY_TRANSACTION_STATUSES),
    amount: z.number(),
    amountBreakdown: PeyAmountBreakdownSchema.optional(),
    currency: z.string().optional(),
    paymentMethod: z.string().optional(),
    payableType: z.string().optional(),
    payableId: z.string().optional(),
    description: z.string().optional(),
    dateCreated: z.number().optional(),
    datePaid: z.number().optional(),
    metadata: PeyTransactionMetadataSchema.optional(),
  })
  .passthrough();
export type PeyTransaction = z.infer<typeof PeyTransactionSchema>;

export const PeyQrTransactionsResponseSchema = z
  .object({
    items: z.array(PeyTransactionSchema),
    nextToken: z.string().nullable().optional(),
  })
  .passthrough();
export type PeyQrTransactionsResponse = z.infer<typeof PeyQrTransactionsResponseSchema>;

// ---- Errors ---------------------------------------------------------------

export const PeyErrorResponseSchema = z.object({
  error: z
    .object({
      message: z.string(),
      type: z.string().optional(),
      requestId: z.string().optional(),
    })
    .passthrough(),
});
export type PeyErrorResponse = z.infer<typeof PeyErrorResponseSchema>;

// ---- Webhooks -------------------------------------------------------------

const WebhookTimestampSchema = z.union([z.number(), z.string()]);

const PeyWebhookBaseShape = {
  amount: z.number(),
  apiKeyId: z.string().optional(),
  concept: z.string().optional(),
  datePaid: WebhookTimestampSchema.optional(),
  numRef: z.union([z.string(), z.number()]).optional(),
  transactionId: z.string().min(1),
  metadata: PeyTransactionMetadataSchema.optional(),
};

export const PeyQrPaymentReceivedSchema = z
  .object({
    type: z.literal("codi.qr.payment_received"),
    ...PeyWebhookBaseShape,
    bankAccountId: z.string().optional(),
    codiQrId: z.string().min(1),
  })
  .passthrough();
export type PeyQrPaymentReceived = z.infer<typeof PeyQrPaymentReceivedSchema>;

export const PeyPnPaymentReceivedSchema = z
  .object({
    type: z.literal("codi.pn.payment_received"),
    ...PeyWebhookBaseShape,
    bankAccountId: z.string().optional(),
  })
  .passthrough();
export type PeyPnPaymentReceived = z.infer<typeof PeyPnPaymentReceivedSchema>;

export const PeyBankAccountUpdatedSchema = z
  .object({
    type: z.literal("bank.account.updated"),
    bankAccountId: z.string().min(1),
    codiStatus: PeyCodiStatusSchema,
    clabe: z.string().optional(),
    name: z.string().optional(),
    entity: z.string().optional(),
    ownerType: z.string().optional(),
    ownerId: z.string().optional(),
    taxId: z.string().optional(),
  })
  .passthrough();
export type PeyBankAccountUpdated = z.infer<typeof PeyBankAccountUpdatedSchema>;

export const PeyWebhookEventSchema = z.discriminatedUnion("type", [
  PeyQrPaymentReceivedSchema,
  PeyPnPaymentReceivedSchema,
  PeyBankAccountUpdatedSchema,
]);
export type PeyWebhookEvent = z.infer<typeof PeyWebhookEventSchema>;

/** Safe accessor for the external metadata echoed by pey (strings). */
export function getExternalMetadata(event: PeyWebhookEvent): Record<string, string> {
  if (event.type === "bank.account.updated") return {};
  return event.metadata?.externalMetadata ?? {};
}

/** Copy of the webhook payload safe to persist: drops clabe, name, taxId and metadata.clabe. */
export function redactPeyWebhookPayload(event: PeyWebhookEvent): Record<string, unknown> {
  const { clabe: _c, name: _n, taxId: _t, ...rest } = event as Record<string, unknown>;
  const out: Record<string, unknown> = rest;
  const md = out["metadata"];
  if (md && typeof md === "object" && !Array.isArray(md)) {
    const { clabe: _mc, ...mdRest } = md as Record<string, unknown>;
    out["metadata"] = mdRest;
  }
  return out;
}

// ---- Helpers --------------------------------------------------------------

export interface PeyMetadataInput {
  agreementId: string;
  milestoneId: string;
  paymentRequestId: string;
}

/** Metadata attached to every QR/PN: all scalars, keys <= 40, values <= 500. */
export function buildPeyMetadata(input: PeyMetadataInput): Record<string, string> {
  const metadata: Record<string, string> = {
    agreementId: input.agreementId,
    milestoneId: input.milestoneId,
    paymentRequestId: input.paymentRequestId,
    app: "trato",
  };
  for (const [k, v] of Object.entries(metadata)) {
    if (k.length === 0 || k.length > PEY_LIMITS.metadataKeyMaxLength) {
      throw new RangeError(`Clave de metadata inválida: ${k}`);
    }
    if (typeof v !== "string" || v.length === 0 || v.length > PEY_LIMITS.metadataValueMaxLength) {
      throw new RangeError(`Valor de metadata inválido para ${k}`);
    }
  }
  return metadata;
}

const CONCEPT_SUFFIX: Record<MilestoneKind, string> = {
  ADVANCE: "anticipo",
  BALANCE: "saldo",
};

/** "Trato TR-0007 anticipo" (<= 40 chars, no personal data). */
export function buildConcept(code: string, kind: MilestoneKind): string {
  if (!/^TR-\d{4,9}$/.test(code)) throw new RangeError(`Código de trato inválido: ${code}`);
  const concept = `Trato ${code} ${CONCEPT_SUFFIX[kind]}`;
  if (concept.length > PEY_LIMITS.conceptMaxLength) {
    throw new RangeError("El concepto excede 40 caracteres.");
  }
  return concept;
}

/** 7-digit zero-padded numRef from a sequential counter. */
export function formatNumRef(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 9_999_999) {
    throw new RangeError(`numRef fuera de rango: ${counter}`);
  }
  return String(counter).padStart(PEY_LIMITS.numRefMaxDigits, "0");
}
