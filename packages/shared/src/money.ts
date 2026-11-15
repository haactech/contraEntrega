/** Money helpers. All internal amounts are integer cents (MXN). */

export const MONEY_LIMITS = {
  minTotalCents: 2,
  maxTotalCents: 200_000_000,
  minAdvanceCents: 1,
  maxAdvanceCents: 100_000_000,
  minBalanceCents: 1,
  maxBalanceCents: 100_000_000,
} as const;

/** Cents -> MXN number for pey (cents / 100). */
export function centsToMxn(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Importe en centavos inválido: ${cents}`);
  }
  return cents / 100;
}

/** MXN number (from pey) -> integer cents. Rejects NaN, infinities and negatives. */
export function mxnToCents(mxn: number): number {
  if (typeof mxn !== "number" || !Number.isFinite(mxn) || mxn < 0) {
    throw new RangeError(`Importe en MXN inválido: ${mxn}`);
  }
  const cents = Math.round(mxn * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Importe en MXN fuera de rango: ${mxn}`);
  }
  return cents;
}

/** "$1,234.56" */
export function formatMxn(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Importe en centavos inválido: ${cents}`);
  }
  // Format from integer parts to avoid any float drift.
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const wholeStr = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(whole);
  return `$${wholeStr}.${String(frac).padStart(2, "0")}`;
}

export type SplitResult =
  | { ok: true; totalCents: number; advanceCents: number; balanceCents: number }
  | { ok: false; message: string };

/** Non-throwing validation of a total/advance split (used by Zod refinements). */
export function checkSplit(totalCents: number, advanceCents: number): SplitResult {
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(advanceCents)) {
    return { ok: false, message: "Los importes deben ser enteros en centavos." };
  }
  if (totalCents < MONEY_LIMITS.minTotalCents) {
    return { ok: false, message: "El total debe ser de al menos $0.02." };
  }
  if (totalCents > MONEY_LIMITS.maxTotalCents) {
    return { ok: false, message: "El total no puede superar $2,000,000.00." };
  }
  if (advanceCents < MONEY_LIMITS.minAdvanceCents) {
    return { ok: false, message: "El anticipo debe ser de al menos $0.01." };
  }
  if (advanceCents > MONEY_LIMITS.maxAdvanceCents) {
    return { ok: false, message: "El anticipo no puede superar $1,000,000.00." };
  }
  const balanceCents = totalCents - advanceCents;
  if (balanceCents < MONEY_LIMITS.minBalanceCents) {
    return { ok: false, message: "El anticipo debe ser menor al total." };
  }
  if (balanceCents > MONEY_LIMITS.maxBalanceCents) {
    return { ok: false, message: "El saldo no puede superar $1,000,000.00." };
  }
  return { ok: true, totalCents, advanceCents, balanceCents };
}

/** Throws RangeError (Spanish message) when invariants are violated. */
export function splitTotal(
  totalCents: number,
  advanceCents: number,
): { totalCents: number; advanceCents: number; balanceCents: number } {
  const r = checkSplit(totalCents, advanceCents);
  if (!r.ok) throw new RangeError(r.message);
  return { totalCents: r.totalCents, advanceCents: r.advanceCents, balanceCents: r.balanceCents };
}
