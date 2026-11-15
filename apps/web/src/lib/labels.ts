import type { AgreementSummary, BuyerNextAction, MilestoneStatus, SellerNextAction } from "@trato/shared";
import type { Tone } from "@/components/ui/badge";

export const SELLER_ACTION_CHIP: Record<SellerNextAction, { label: string; tone: Tone }> = {
  SHARE: { label: "Falta compartir", tone: "warn" },
  WAIT_ACCEPTANCE: { label: "Esperando aceptación", tone: "neutral" },
  WAIT_ADVANCE: { label: "Esperando anticipo", tone: "neutral" },
  UPLOAD_EVIDENCE: { label: "Toca entregar", tone: "brand" },
  WAIT_REVIEW: { label: "En revisión", tone: "neutral" },
  RESOLVE_DISPUTE: { label: "Problema reportado", tone: "danger" },
  WAIT_BALANCE: { label: "Esperando saldo", tone: "neutral" },
  DONE: { label: "Completado", tone: "success" },
};

export const SELLER_ACTION_TEXT: Record<SellerNextAction, { title: string; body: string }> = {
  SHARE: { title: "Comparte el enlace", body: "Envíaselo a tu comprador para que revise y acepte las condiciones." },
  WAIT_ACCEPTANCE: { title: "Esperando que el comprador acepte", body: "Cuando acepte, podrá pagar el anticipo." },
  WAIT_ADVANCE: { title: "Esperando el anticipo", body: "El comprador ya aceptó. Aún no se recibe el anticipo." },
  UPLOAD_EVIDENCE: {
    title: "Entrega tu trabajo",
    body: "Sube de 1 a 3 fotos del trabajo terminado y solicita la revisión del comprador.",
  },
  WAIT_REVIEW: { title: "El comprador está revisando", body: "Te avisaremos aquí cuando responda." },
  RESOLVE_DISPUTE: {
    title: "El comprador reportó un problema",
    body: "Corrige el trabajo, sube nuevas fotos y vuelve a entregar. El historial se conserva.",
  },
  WAIT_BALANCE: { title: "Esperando el pago del saldo", body: "El comprador ya recibió el trabajo y falta que pague el saldo." },
  DONE: { title: "Trato completado", body: "Anticipo y saldo recibidos. Puedes exportar el comprobante." },
};

export const BUYER_ACTION_TEXT: Record<BuyerNextAction, string> = {
  ACCEPT: "Revisa las condiciones y acepta el acuerdo.",
  PAY_ADVANCE: "Acuerdo aceptado. Falta pagar el anticipo para que empiece el trabajo.",
  WAIT_DELIVERY: "Anticipo recibido. Esperando que el prestador entregue el trabajo.",
  REVIEW: "El prestador entregó el trabajo. Revísalo y dinos si todo está bien.",
  PAY_BALANCE: "Trabajo recibido. Falta pagar el saldo.",
  WAIT_SELLER: "Esperando al prestador.",
  DONE: "Trato completado.",
};

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, { label: string; tone: Tone }> = {
  PENDING_ACCEPTANCE: { label: "Pendiente de aceptación", tone: "neutral" },
  ELIGIBLE: { label: "Listo para cobrar", tone: "brand" },
  WAITING_DELIVERY: { label: "Esperando entrega", tone: "neutral" },
  WAITING_BUYER_REVIEW: { label: "En revisión", tone: "neutral" },
  READY_TO_CHARGE: { label: "Listo para cobrar", tone: "brand" },
  AWAITING_PAYMENT: { label: "Esperando pago", tone: "warn" },
  PAID: { label: "Pagado", tone: "success" },
  DISPUTED: { label: "Problema reportado", tone: "danger" },
};

export const MILESTONE_TITLE = { ADVANCE: "Anticipo", BALANCE: "Saldo" } as const;

export function chipFor(a: Pick<AgreementSummary, "nextAction">) {
  return SELLER_ACTION_CHIP[a.nextAction];
}

export function formatDate(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
