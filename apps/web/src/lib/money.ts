/**
 * Converts what a person types in an MXN input ("1,234.50", "$800", "99.9") to
 * integer cents using string arithmetic only (no float drift).
 * Returns null for empty or invalid input (more than 2 decimals, letters, negatives).
 */
export function parseMxnToCents(input: string): number | null {
  const cleaned = input.replace(/[\s$,]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned) && !/^\.\d{1,2}$/.test(cleaned)) return null;
  const [wholeRaw = "", fracRaw = ""] = cleaned.split(".");
  const whole = wholeRaw === "" ? 0 : Number(wholeRaw);
  const cents = whole * 100 + Number(fracRaw.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Integer cents -> plain editable string ("1234.50"), for filling an input. */
export function centsToInputValue(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** `pct` percent of `totalCents`, rounded to the nearest cent, using integers only. */
export function percentOfCents(totalCents: number, pct: number): number {
  return Math.round((totalCents * pct) / 100);
}
