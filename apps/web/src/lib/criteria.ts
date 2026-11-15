/**
 * Splits the agreement's delivery criteria into a reading checklist: by newlines, semicolons or
 * commas (a period only splits when followed by whitespace and an uppercase letter or digit).
 * Leading bullets/numbering are stripped; blanks and duplicates are dropped.
 */
export function parseCriteria(text: string): string[] {
  const parts = text
    .replace(/\r\n?/g, "\n")
    .split(/[\n;,]+|\.(?=\s+[A-ZÁÉÍÓÚÑ0-9])/u)
    .map((p) =>
      p
        .trim()
        .replace(/^(?:[-*•–—]|\d+[.)])\s+/u, "")
        .replace(/[.\s]+$/u, "")
        .trim(),
    )
    .filter((p) => p.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}
