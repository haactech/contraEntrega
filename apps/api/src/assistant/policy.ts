import type { AgreementStatus } from "@trato/shared";

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** `@Trato` anywhere, or the message starts with «Trato,» / «Trato:» (case and accent insensitive). */
export function mentionsAssistant(text: string): boolean {
  const t = fold(text);
  return /(^|[^\w])@trato\b/.test(t) || /^\s*trato\s*[,:]/.test(t);
}

/**
 * Spec v0.3 §2. During negotiation (no agreement, or DRAFT | SHARED) the assistant answers every
 * human message; once the terms are accepted only when it is mentioned.
 */
export function shouldAssistantRespond(agreementStatus: AgreementStatus | null, text: string): boolean {
  if (agreementStatus === null || agreementStatus === "DRAFT" || agreementStatus === "SHARED") return true;
  return mentionsAssistant(text);
}
