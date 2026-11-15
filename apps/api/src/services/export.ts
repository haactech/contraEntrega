import { BUYER_HIDDEN_EVENT_TYPES, formatMxn, type EventType } from "@trato/shared";
import type { AppEnv } from "../env";
import { toBase64Url } from "../lib/crypto";
import { escapeHtml as h } from "../lib/html";
import type { AgreementBundle } from "../repos/agreements";
import { eventViews, evidenceView, reviewView } from "./views";

export type ExportAudience = "seller" | "buyer";

const PRINT_SCRIPT = `document.getElementById("print-btn").addEventListener("click",function(){window.print()});`;

const MX_TZ = "America/Mexico_City";
const fmtDate = (ms: number | string | null): string => {
  if (ms === null) return "—";
  const d = new Date(ms);
  return `${d.toLocaleString("es-MX", { timeZone: MX_TZ, dateStyle: "long", timeStyle: "short" })} (hora CDMX)`;
};

const AGREEMENT_STATUS: Record<string, string> = {
  DRAFT: "Borrador",
  SHARED: "Compartido, pendiente de aceptación",
  ACCEPTED: "Aceptado, pendiente de anticipo",
  IN_PROGRESS: "En curso",
  DISPUTED: "En disputa",
  COMPLETED: "Completado",
};
const MILESTONE_STATUS: Record<string, string> = {
  PENDING_ACCEPTANCE: "Pendiente de aceptación",
  ELIGIBLE: "Listo para cobrar",
  WAITING_DELIVERY: "Esperando entrega",
  WAITING_BUYER_REVIEW: "En revisión del comprador",
  READY_TO_CHARGE: "Aprobado, listo para cobrar",
  AWAITING_PAYMENT: "Esperando pago",
  DISPUTED: "En disputa",
  PAID: "Pagado",
};
const MILESTONE_KIND: Record<string, string> = { ADVANCE: "Anticipo", BALANCE: "Saldo contra entrega" };
const METHOD: Record<string, string> = { CODI_QR: "CoDi (código QR)", CODI_PN: "CoDi (solicitud push)" };
const ACTOR: Record<string, string> = { SELLER: "Prestador", BUYER: "Comprador", SYSTEM: "Sistema", PROVIDER: "Proveedor de pagos" };

const EVENT_TITLE: Record<EventType, string> = {
  AGREEMENT_CREATED: "Trato creado",
  AGREEMENT_SHARED: "Enlace compartido con el comprador",
  LINK_REGENERATED: "Enlace regenerado",
  TERMS_ACCEPTED: "Acuerdo aceptado (esto no es un pago)",
  PAYMENT_REQUEST_CREATED: "Solicitud de pago enviada (aún sin pago confirmado)",
  PAYMENT_REQUEST_FAILED: "No se pudo generar la solicitud de pago",
  PAYMENT_REQUEST_EXPIRED: "La solicitud de pago venció",
  PAYMENT_CONFIRMED: "Pago confirmado",
  PAYMENT_UNMATCHED: "Pago por revisar (no coincide con ninguna solicitud)",
  DUPLICATE_PAYMENT_DETECTED: "Posible pago duplicado, requiere revisión manual",
  EVIDENCE_ADDED: "Evidencia agregada",
  EVIDENCE_REMOVED: "Evidencia eliminada antes de enviarla",
  REVIEW_REQUESTED: "Entrega enviada a revisión",
  DELIVERY_APPROVED: "Trabajo recibido (el saldo se paga por separado)",
  DELIVERY_DISPUTED: "Problema reportado",
  AGREEMENT_COMPLETED: "Trato completado",
  TERMS_REVISED: "Términos actualizados antes de la aceptación",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseTerms(json: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? "{}");
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eventDetail(type: EventType, p: Record<string, unknown>): string {
  const parts: string[] = [];
  const kind = str(p["milestoneKind"]);
  if (kind) parts.push(MILESTONE_KIND[kind] ?? kind);
  const round = num(p["deliveryRound"]);
  if ((type === "EVIDENCE_ADDED" || type === "REVIEW_REQUESTED" || type === "DELIVERY_APPROVED" || type === "DELIVERY_DISPUTED") && round !== null) {
    parts.push(`entrega ${round + 1}`);
  }
  const cents = num(p["amountCents"]);
  if (cents !== null && cents >= 0) parts.push(formatMxn(cents));
  const buyer = str(p["buyerName"]);
  if (buyer) parts.push(`por ${buyer}`);
  const note = str(p["note"]);
  if (note) parts.push(`nota: «${note}»`);
  const comment = str(p["comment"]);
  if (comment) parts.push(`comentario: «${comment}»`);
  const sha = str(p["sha256"]);
  if (sha) parts.push(`SHA-256 ${sha}`);
  return parts.join(" · ");
}

const CSS = `
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:16px}
main{max-width:820px;margin:0 auto;background:#fff;padding:24px;border:1px solid #e2e8f0;border-radius:8px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px;padding-bottom:4px;border-bottom:2px solid #e2e8f0}
.muted{color:#475569}.code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;font-size:12px}
table{width:100%;border-collapse:collapse;margin:4px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{font-size:12px;color:#475569}
dl{display:grid;grid-template-columns:170px 1fr;gap:4px 12px;margin:0}dt{color:#475569}dd{margin:0}
.pre{white-space:pre-wrap}
.thumbs{display:flex;flex-wrap:wrap;gap:12px}.thumb{width:180px;font-size:11px;word-break:break-all}.thumb img{width:180px;height:140px;object-fit:cover;border:1px solid #cbd5e1;border-radius:4px;display:block;margin-bottom:4px}
.notice{margin-top:24px;padding:12px;border:1px solid #cbd5e1;background:#f1f5f9;border-radius:6px;font-size:13px}.notice p{margin:4px 0}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}
ol.timeline{padding-left:18px;margin:4px 0}ol.timeline li{margin-bottom:6px}
@media (max-width:560px){dl{grid-template-columns:1fr}}
@media print{body{background:#fff;padding:0}main{border:0;padding:0;max-width:none}.no-print{display:none}h2,tr,.thumb{break-inside:avoid}}
`;

const dl = (rows: [string, string][]): string =>
  `<dl>${rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;

/** Builds the printable, self-contained HTML record. Every user-provided string is escaped. */
export async function renderExport(
  env: AppEnv,
  b: AgreementBundle,
  audience: ExportAudience,
  now: number,
): Promise<{ html: string; csp: string }> {
  const a = b.agreement;
  const t = parseTerms(a.termsJson);
  const kinds = new Map(b.milestones.map((m) => [m.id, m.kind]));
  const milestones = [...b.milestones].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "ADVANCE" ? -1 : 1));
  const evidenceRows = b.evidence.filter((e) => audience === "seller" || e.submitted);
  const evidence = await Promise.all(evidenceRows.map((e) => evidenceView(env, e, now)));
  const reviews = b.reviews.map(reviewView);
  const hidden: readonly string[] = audience === "buyer" ? BUYER_HIDDEN_EVENT_TYPES : [];
  const events = eventViews(b.events.filter((e) => !hidden.includes(e.eventType)), false);
  const paid = b.paymentRequests.filter((p) => p.status === "PAID");

  const rounds = [...new Set(evidence.map((e) => e.deliveryRound))].sort((x, y) => x - y);
  const evidenceHtml =
    evidence.length === 0
      ? `<p class="muted">Sin evidencias registradas.</p>`
      : rounds
          .map((r) => {
            const items = evidence.filter((e) => e.deliveryRound === r);
            return `<h3>Entrega ${r + 1}</h3><div class="thumbs">${items
              .map(
                (e) =>
                  `<div class="thumb"><img src="${h(e.url)}" alt="Evidencia de la entrega ${r + 1}" loading="lazy">` +
                  `<div>${h(e.mimeType)} · ${Math.max(1, Math.round(e.sizeBytes / 1024))} KB${e.submitted ? "" : " · sin enviar"}</div>` +
                  `<div class="code">SHA-256: ${h(e.sha256)}</div><div class="muted">${h(fmtDate(e.createdAt))}</div></div>`,
              )
              .join("")}</div>`;
          })
          .join("");

  const body = `
<div class="bar no-print"><span class="muted">Registro del trato ${h(a.code)}</span><button type="button" id="print-btn">Imprimir / Guardar PDF</button></div>
<h1>${h(a.code)} · ${h(a.title)}</h1>
<p class="muted">Registro generado el ${h(fmtDate(now))} · Estado: ${h(AGREEMENT_STATUS[a.status] ?? a.status)}</p>

<h2>Partes</h2>
${dl([
  ["Prestador", `${h(b.seller.displayName)} (${h(b.seller.trade)})`],
  ["Comprador", h(a.buyerName)],
  ["Cuenta que recibe el pago", `${h(b.account.alias)} •••• ${h(b.account.clabeLast4)}`],
])}

<h2>Términos sellados</h2>
${dl([
  ["Código", h(str(t["code"]) ?? a.code)],
  ["Título", h(str(t["title"]) ?? a.title)],
  ["Descripción", `<span class="pre">${h(str(t["description"]) ?? a.description)}</span>`],
  ["Criterios de aceptación", `<span class="pre">${h(str(t["acceptanceCriteria"]) ?? a.acceptanceCriteria)}</span>`],
  ["Fecha de entrega", h(str(t["dueDate"]) ?? a.dueDate ?? "Sin fecha")],
  ["Total", h(formatMxn(num(t["totalCents"]) ?? a.totalCents))],
  ["Anticipo", h(formatMxn(num(t["advanceCents"]) ?? milestones.find((m) => m.kind === "ADVANCE")?.amountCents ?? 0))],
  ["Saldo", h(formatMxn(num(t["balanceCents"]) ?? milestones.find((m) => m.kind === "BALANCE")?.amountCents ?? 0))],
  ["Versión de los términos", h(a.termsVersion)],
  ["SHA-256 de los términos", `<span class="code">${h(a.termsSha256 ?? "")}</span>`],
  ["Aceptado por", a.buyerAcceptedName ? h(a.buyerAcceptedName) : "Aún sin aceptar"],
  ["Fecha de aceptación", h(fmtDate(a.buyerAcceptedAt))],
])}

<h2>Hitos</h2>
<table><thead><tr><th>Hito</th><th>Monto</th><th>Estado</th><th>Entrega</th><th>Aprobado</th><th>Pagado</th></tr></thead><tbody>
${milestones
  .map(
    (m) =>
      `<tr><td>${h(MILESTONE_KIND[m.kind] ?? m.kind)}</td><td>${h(formatMxn(m.amountCents))}</td><td>${h(MILESTONE_STATUS[m.status] ?? m.status)}</td><td>${m.kind === "BALANCE" ? h(m.deliveryRound + 1) : "—"}</td><td>${h(fmtDate(m.approvedAt))}</td><td>${h(fmtDate(m.paidAt))}</td></tr>`,
  )
  .join("")}
</tbody></table>

<h2>Pagos confirmados</h2>
${
  paid.length === 0
    ? `<p class="muted">Aún no hay pagos confirmados.</p>`
    : `<table><thead><tr><th>Hito</th><th>Fecha</th><th>Monto</th><th>Referencia</th><th>Método</th></tr></thead><tbody>${paid
        .map(
          (p) =>
            `<tr><td>${h(MILESTONE_KIND[kinds.get(p.milestoneId) ?? ""] ?? "")}</td><td>${h(fmtDate(p.paidAt))}</td><td>${h(formatMxn(p.amountCents))}</td><td>${h(p.numRef)}</td><td>${h(METHOD[p.method] ?? p.method)}</td></tr>`,
        )
        .join("")}</tbody></table>`
}

<h2>Evidencias</h2>
${evidenceHtml}

<h2>Revisiones del comprador</h2>
${
  reviews.length === 0
    ? `<p class="muted">Aún no hay revisiones.</p>`
    : `<table><thead><tr><th>Entrega</th><th>Decisión</th><th>Comentario</th><th>Comprador</th><th>Fecha</th></tr></thead><tbody>${reviews
        .map(
          (r) =>
            `<tr><td>${h(r.deliveryRound + 1)}</td><td>${r.decision === "APPROVE" ? "Aprobada" : "Problema reportado"}</td><td class="pre">${h(r.comment ?? "—")}</td><td>${h(r.buyerName)}</td><td>${h(fmtDate(r.createdAt))}</td></tr>`,
        )
        .join("")}</tbody></table>`
}

<h2>Historial completo</h2>
<ol class="timeline">
${events
  .map((e) => {
    const detail = eventDetail(e.type, e.payload);
    return `<li><strong>${h(EVENT_TITLE[e.type])}</strong> <span class="muted">— ${h(ACTOR[e.actorType] ?? e.actorType)}, ${h(fmtDate(e.occurredAt))}</span>${detail ? `<br><span class="muted">${h(detail)}</span>` : ""}</li>`;
  })
  .join("")}
</ol>

<div class="notice">
<p><strong>El dinero llega directamente al prestador. Esta plataforma no retiene fondos ni garantiza devoluciones.</strong></p>
<p>Este registro no sustituye una pericial, una firma electrónica avanzada ni una resolución judicial.</p>
</div>`;

  const scriptHash = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRINT_SCRIPT))))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const csp = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Registro del trato ${h(a.code)}</title><style>${CSS}</style></head>
<body><main>${body}</main><script>${PRINT_SCRIPT}</script></body></html>`;
  return { html, csp };
}

export function exportResponse(out: { html: string; csp: string }): Response {
  return new Response(out.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": out.csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
