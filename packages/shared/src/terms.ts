import { splitTotal } from "./money";

export const CURRENT_TERMS_VERSION = 1;

export interface TermsInput {
  code: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  buyerName: string;
  dueDate?: string | null | undefined;
  totalCents: number;
  advanceCents: number;
  sellerDisplayName: string;
  payeeAlias: string;
  payeeLast4: string;
  termsVersion?: number | undefined;
}

export interface TermsSnapshot {
  code: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  buyerName: string;
  dueDate: string | null;
  totalCents: number;
  advanceCents: number;
  balanceCents: number;
  sellerDisplayName: string;
  payeeAlias: string;
  payeeLast4: string;
  termsVersion: number;
}

/** Canonical terms object that is sealed (hashed) when the agreement is shared. */
export function buildTermsSnapshot(input: TermsInput): TermsSnapshot {
  const split = splitTotal(input.totalCents, input.advanceCents);
  return {
    code: input.code,
    title: input.title.trim(),
    description: input.description.trim(),
    acceptanceCriteria: input.acceptanceCriteria.trim(),
    buyerName: input.buyerName.trim(),
    dueDate: input.dueDate ? input.dueDate : null,
    totalCents: split.totalCents,
    advanceCents: split.advanceCents,
    balanceCents: split.balanceCents,
    sellerDisplayName: input.sellerDisplayName.trim(),
    payeeAlias: input.payeeAlias,
    payeeLast4: input.payeeLast4,
    termsVersion: input.termsVersion ?? CURRENT_TERMS_VERSION,
  };
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: número no finito.");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: tipo no soportado (${typeof value}).`);
  }
}

/** SHA-256 hex digest via WebCrypto (Workers, browsers, Node 22). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Convenience: hash of the canonical JSON of the terms. */
export async function hashTerms(terms: TermsSnapshot): Promise<string> {
  return sha256Hex(canonicalJson(terms));
}
