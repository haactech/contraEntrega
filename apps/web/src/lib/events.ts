import type { EventType, EventView, MilestoneKind, MilestoneView } from "@trato/shared";
import { formatMxn } from "@trato/shared";

export type EventTone = "neutral" | "success" | "warn" | "danger";

export interface EventText {
  title: string;
  detail?: string;
  tone: EventTone;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function kindFromPayload(payload: Record<string, unknown>, milestones: readonly MilestoneView[]): MilestoneKind | null {
  const direct = str(payload["milestoneKind"]) ?? str(payload["kind"]);
  if (direct === "ADVANCE" || direct === "BALANCE") return direct;
  const id = str(payload["milestoneId"]);
  if (id) return milestones.find((m) => m.id === id)?.kind ?? null;
  return null;
}

function amountDetail(payload: Record<string, unknown>): string | null {
  const c = payload["amountCents"];
  return typeof c === "number" && Number.isSafeInteger(c) && c >= 0 ? formatMxn(c) : null;
}

const KIND_LABEL: Record<MilestoneKind, string> = { ADVANCE: "del anticipo", BALANCE: "del saldo" };

/**
 * Translates an event into human Spanish. Keeps the mandated distinctions:
 * "Acuerdo aceptado" is not "Anticipo recibido"; "Solicitud enviada" is not
 * "Pago confirmado"; "Trabajo recibido" is not "Saldo pagado".
 */
export function eventText(event: Pick<EventView, "type" | "payload">, milestones: readonly MilestoneView[] = []): EventText {
  const p = event.payload;
  const kind = kindFromPayload(p, milestones);
  const kindLabel = kind ? KIND_LABEL[kind] : null;
  const amount = amountDetail(p);
  const type: EventType = event.type;

  switch (type) {
    case "AGREEMENT_CREATED":
      return { title: "Trato creado", tone: "neutral" };
    case "AGREEMENT_SHARED":
      return { title: "Enlace compartido con el comprador", tone: "neutral" };
    case "LINK_REGENERATED":
      return { title: "Enlace regenerado", detail: "El enlace anterior ya no funciona.", tone: "neutral" };
    case "TERMS_ACCEPTED": {
      const name = str(p["buyerName"]);
      return {
        title: "Acuerdo aceptado",
        detail: name ? `Aceptado por ${name}. Esto no es un pago.` : "Esto no es un pago.",
        tone: "success",
      };
    }
    case "PAYMENT_REQUEST_CREATED":
      return {
        title: "Solicitud enviada",
        detail: [kindLabel ? `Cobro ${kindLabel}` : null, amount].filter(Boolean).join(" · ") || "Aún sin pago confirmado.",
        tone: "neutral",
      };
    case "PAYMENT_REQUEST_FAILED":
      return { title: "No se pudo generar la solicitud de pago", detail: "Se puede intentar de nuevo.", tone: "warn" };
    case "PAYMENT_REQUEST_EXPIRED":
      return { title: "La solicitud de pago venció", detail: "Se puede generar una nueva.", tone: "warn" };
    case "PAYMENT_CONFIRMED":
      return {
        title: kind === "ADVANCE" ? "Anticipo recibido" : kind === "BALANCE" ? "Saldo pagado" : "Pago confirmado",
        detail: amount ?? undefined,
        tone: "success",
      };
    case "PAYMENT_UNMATCHED":
      return {
        title: "Pago por revisar",
        detail: "Llegó un pago que no coincide con ninguna solicitud. Requiere revisión manual.",
        tone: "warn",
      };
    case "DUPLICATE_PAYMENT_DETECTED":
      return {
        title: "Posible pago duplicado",
        detail: "Requiere revisión manual. Trato no hace reembolsos.",
        tone: "warn",
      };
    case "EVIDENCE_ADDED":
      return { title: "Evidencia agregada", tone: "neutral" };
    case "EVIDENCE_REMOVED":
      return { title: "Evidencia eliminada antes de enviarla", tone: "neutral" };
    case "REVIEW_REQUESTED": {
      const note = str(p["note"]);
      return { title: "Entrega enviada a revisión", detail: note ?? undefined, tone: "neutral" };
    }
    case "DELIVERY_APPROVED":
      return {
        title: "Trabajo recibido",
        detail: "El comprador lo aprobó. El saldo se paga por separado.",
        tone: "success",
      };
    case "DELIVERY_DISPUTED": {
      const comment = str(p["comment"]);
      return { title: "Problema reportado", detail: comment ?? undefined, tone: "danger" };
    }
    case "AGREEMENT_COMPLETED":
      return { title: "Trato completado", tone: "success" };
    default: {
      const _never: never = type;
      return { title: String(_never), tone: "neutral" };
    }
  }
}
