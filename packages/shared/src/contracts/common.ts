import { z } from "zod";

/** ISO-8601 UTC string (e.g. 2026-11-14T18:30:00.000Z). */
export const IsoDateTimeSchema = z.string().datetime();
/** Integer cents. */
export const CentsSchema = z.number().int().nonnegative().safe();
export const UuidSchema = z.string().min(1).max(64);
export const Last4Schema = z.string().regex(/^\d{4}$/);
export const PhoneSchema = z.string().regex(/^\d{10}$/, "El teléfono debe tener 10 dígitos.");
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** YYYY-MM-DD calendar date. */
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (usa AAAA-MM-DD).")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "Fecha inválida.");

export const AccountSummarySchema = z.object({
  alias: z.string(),
  last4: Last4Schema,
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
