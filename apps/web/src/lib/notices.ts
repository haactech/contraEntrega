import type { ActorType, ConversationView, EventType, FeedItem, FeedMessage } from "@trato/shared";
import { formatMxn } from "@trato/shared";
import { buyerAgreement, sellerAgreement, type DockKind } from "./conversation";

/**
 * In-UI "something changed" notices. Polling refreshes the screen silently; these turn the
 * changes made by the *other* party (or the payment provider) into one clear, viewer-oriented
 * line, e.g. «Mariana pidió un ajuste en “Limpiar baño”», with the card to look at.
 * Pure functions: the room/pages decide how to show them.
 */

export type NoticeTone = "info" | "success" | "warn" | "danger";

export interface StateNotice {
  /** Stable id (source event/message id) so the same change is never announced twice. */
  id: string;
  title: string;
  detail?: string;
  tone: NoticeTone;
  /** Dock card to bring into view with «Ver»; `"feed"` = scroll the chat to the latest message. */
  target: DockKind | "feed" | null;
  /** Cleaning: the task the change is about (opened by «Ver»). */
  taskId?: string;
}

export type Viewer = "SELLER" | "BUYER";

export interface NoticeEvent {
  id: string;
  type: EventType;
  actorType: ActorType;
  payload: Record<string, unknown>;
}

export interface NoticeContext {
  viewer: Viewer;
  /** Name of the other party as the viewer knows them («Mariana», «Rosa»). */
  otherName: string;
  cleaning: boolean;
}

const MAX_NOTICES = 3;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function amount(p: Record<string, unknown>): string | null {
  const c = p["amountCents"];
  return typeof c === "number" && Number.isSafeInteger(c) && c >= 0 ? formatMxn(c) : null;
}

function quoted(p: Record<string, unknown>): string {
  const t = str(p["taskTitle"]);
  return t ? `“${t}”` : "una tarea";
}

function truncate(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One event → a notice for this viewer, or null when it isn't worth interrupting for. */
export function noticeForEvent(e: NoticeEvent, ctx: NoticeContext): StateNotice | null {
  // The viewer already knows what they did themselves.
  if (e.actorType === ctx.viewer) return null;
  const p = e.payload;
  const who = ctx.otherName;
  const base = { id: e.id };

  if (ctx.viewer === "SELLER") {
    switch (e.type) {
      case "TERMS_ACCEPTED":
        return {
          ...base,
          tone: "success",
          title: `${who} aceptó el trato`,
          detail: ctx.cleaning ? "Ya puedes empezar: sube la foto de cada tarea al terminarla." : "Esto todavía no es un pago.",
          target: ctx.cleaning ? "checklist" : null,
        };
      case "TASK_APPROVED":
        return { ...base, tone: "success", title: `${who} aprobó ${quoted(p)}`, target: "checklist" };
      case "TASK_ADJUSTMENT_REQUESTED": {
        const c = str(p["comment"]);
        return {
          ...base,
          tone: "warn",
          title: `${who} pidió un ajuste en ${quoted(p)}`,
          detail: c ? `“${truncate(c)}”. Sube una foto nueva y vuelve a enviarla.` : "Sube una foto nueva y vuelve a enviarla.",
          target: "checklist",
        };
      }
      case "ALL_TASKS_APPROVED":
        return {
          ...base,
          tone: "success",
          title: `${who} aprobó todo el trabajo`,
          detail: "Ahora puede pagar. Te avisamos cuando se confirme el pago.",
          target: "checklist",
        };
      case "PAYMENT_REQUEST_CREATED":
        return {
          ...base,
          tone: "info",
          title: `${who} está por pagar`,
          detail: "Generó la solicitud de pago; aún no hay pago confirmado.",
          target: null,
        };
      case "DELIVERY_APPROVED":
        return {
          ...base,
          tone: "success",
          title: `${who} aprobó la entrega`,
          detail: "Falta que pague el saldo.",
          target: null,
        };
      case "DELIVERY_DISPUTED": {
        const c = str(p["comment"]);
        return {
          ...base,
          tone: "danger",
          title: `${who} reportó un problema`,
          detail: c ? `“${truncate(c)}”` : undefined,
          target: "dispute",
        };
      }
      default:
        break;
    }
  } else {
    switch (e.type) {
      case "TERMS_REVISED":
        return {
          ...base,
          tone: "info",
          title: `${who} confirmó la nueva versión`,
          detail: "Revísala; si estás de acuerdo, ya puedes aceptarla.",
          target: "proposal",
        };
      case "TASK_SUBMITTED": {
        const rev = p["revision"];
        const resub = typeof rev === "number" && rev > 1;
        return {
          ...base,
          tone: "info",
          title: `Lista para revisar: ${quoted(p)}`,
          detail: resub ? `${who} hizo el ajuste y volvió a enviarla.` : `${who} subió la foto. Apruébala o pide un ajuste.`,
          target: "checklist",
        };
      }
      case "ALL_TASKS_APPROVED":
        return {
          ...base,
          tone: "success",
          title: "Aprobaste todo el trabajo",
          detail: "Ya puedes pagar.",
          target: "payment",
        };
      case "REVIEW_REQUESTED":
        return {
          ...base,
          tone: "info",
          title: `${who} terminó el trabajo`,
          detail: "Revisa las fotos: confirma que todo está bien o reporta un problema.",
          target: "delivery",
        };
      default:
        break;
    }
  }

  // Both viewers.
  switch (e.type) {
    case "PAYMENT_CONFIRMED": {
      const kind = str(p["milestoneKind"]) ?? str(p["kind"]);
      const label = ctx.cleaning ? "Pago confirmado" : kind === "ADVANCE" ? "Anticipo confirmado" : kind === "BALANCE" ? "Saldo confirmado" : "Pago confirmado";
      const a = amount(p);
      return { ...base, tone: "success", title: a ? `${label}: ${a}` : label, detail: "pey confirmó el pago.", target: null };
    }
    case "PAYMENT_REQUEST_EXPIRED":
      return {
        ...base,
        tone: "warn",
        title: "La solicitud de pago venció",
        detail: ctx.viewer === "BUYER" ? "Puedes generar una nueva." : undefined,
        target: ctx.viewer === "BUYER" ? "payment" : null,
      };
    case "PAYMENT_UNMATCHED":
    case "DUPLICATE_PAYMENT_DETECTED":
      return { ...base, tone: "warn", title: "Hay un pago por revisar", detail: "Requiere revisión manual.", target: null };
    case "AGREEMENT_COMPLETED":
      return { ...base, tone: "success", title: "Trato completado", target: "completed" };
    default:
      return null;
  }
}

/**
 * Notices for a batch of new events: collapses redundant pairs (last task approved + «todo
 * aprobado»; pago confirmado + trato completado) and caps the list.
 */
export function noticesForEvents(events: readonly NoticeEvent[], ctx: NoticeContext): StateNotice[] {
  const types = new Set(events.map((e) => e.type));
  const out: StateNotice[] = [];
  for (const e of events) {
    if (e.type === "TASK_APPROVED" && types.has("ALL_TASKS_APPROVED")) continue;
    const n = noticeForEvent(e, ctx);
    const taskId = str(e.payload["taskId"]);
    if (n) out.push(taskId ? { ...n, taskId } : n);
  }
  const paid = out.find((n) => n.title.startsWith("Pago confirmado") || n.title.startsWith("Saldo confirmado"));
  const done = out.find((n) => n.title === "Trato completado");
  if (paid && done) {
    done.detail = `${paid.title}. ${ctx.cleaning ? "Todas las tareas aprobadas y pagadas." : "Todo quedó registrado."}`;
    out.splice(out.indexOf(paid), 1);
  }
  return cap(out);
}

function cap(list: StateNotice[]): StateNotice[] {
  if (list.length <= MAX_NOTICES) return list;
  const head = list.slice(0, MAX_NOTICES - 1);
  const rest = list.length - head.length;
  head.push({ id: `more-${list[list.length - 1]!.id}`, tone: "info", title: `Y ${rest} cambios más`, detail: "Revisa el chat.", target: "feed" });
  return head;
}

/* ------------------------------------------------------------------ room (conversation) */

export function conversationNoticeContext(view: ConversationView): NoticeContext {
  const viewer: Viewer = view.role;
  const s = sellerAgreement(view);
  const b = buyerAgreement(view);
  const otherName =
    viewer === "SELLER"
      ? (s?.agreement.buyerName ?? view.activeProposal?.terms.buyerName ?? "").trim() || "El cliente"
      : (b?.seller.displayName ?? "").trim() || "El prestador";
  return { viewer, otherName, cleaning: view.agreement?.serviceType === "CLEANING" };
}

const isHuman = (m: FeedMessage) => m.authorType === "SELLER" || m.authorType === "BUYER";

/** Latest human message before `index` in the (ordered) feed. */
function lastHumanBefore(feed: readonly FeedItem[], index: number): FeedMessage | null {
  for (let i = index - 1; i >= 0; i--) {
    const it = feed[i]!;
    if (it.type === "message" && isHuman(it)) return it;
  }
  return null;
}

/**
 * What changed between two polls of the same room, from the viewer's side: new events by the
 * other party/provider, a new proposal version triggered by the other party (seller), and new
 * messages from the other person. Returns [] on the first load.
 */
export function conversationNotices(prev: ConversationView | null, next: ConversationView): StateNotice[] {
  if (!prev || prev.conversation.id !== next.conversation.id || prev.role !== next.role) return [];
  const seen = new Set(prev.feed.map((i) => `${i.type}:${i.id}`));
  const ctx = conversationNoticeContext(next);
  const fresh = next.feed.map((it, idx) => ({ it, idx })).filter(({ it }) => !seen.has(`${it.type}:${it.id}`));
  if (fresh.length === 0) return [];

  const events: NoticeEvent[] = fresh
    .filter(({ it }) => it.type === "event")
    .map(({ it }) => {
      const e = it as Extract<FeedItem, { type: "event" }>;
      return { id: e.id, type: e.eventType, actorType: e.actorType, payload: e.payload };
    });
  const out = noticesForEvents(events, ctx);

  const other = ctx.viewer === "SELLER" ? "BUYER" : "SELLER";
  let proposalNotice = false;
  if (ctx.viewer === "SELLER") {
    const prevMax = Math.max(0, ...prev.feed.flatMap((i) => (i.type === "message" && i.proposal ? [i.proposal.version] : [])));
    for (const { it, idx } of fresh) {
      if (it.type !== "message" || !it.proposal || it.proposal.version <= prevMax) continue;
      if (it.proposal.status !== "OPEN") continue;
      if (lastHumanBefore(next.feed, idx)?.authorType !== other) continue;
      out.unshift({
        id: it.id,
        tone: "info",
        title: `${ctx.otherName} pidió un cambio: propuesta v${it.proposal.version}`,
        detail: "Revísala y confírmala para que pueda aceptarla.",
        target: "proposal",
      });
      proposalNotice = true;
    }
  }

  if (!proposalNotice) {
    const msgs = fresh.flatMap(({ it }) => (it.type === "message" && it.authorType === other && it.kind === "TEXT" ? [it] : []));
    const last = msgs[msgs.length - 1];
    if (last) {
      out.push({
        id: last.id,
        tone: "info",
        title: msgs.length > 1 ? `${msgs.length} mensajes nuevos de ${last.authorName || ctx.otherName}` : `Mensaje de ${last.authorName || ctx.otherName}`,
        detail: `“${truncate(last.text)}”`,
        target: "feed",
      });
    }
  }
  return cap(out);
}

/* ------------------------------------------------------------------ agreement pages */

/** New events between two polls of an agreement view (seller detail page). [] on first load. */
export function eventNotices(
  prevEvents: readonly NoticeEvent[] | null,
  nextEvents: readonly NoticeEvent[],
  ctx: NoticeContext,
): StateNotice[] {
  if (!prevEvents) return [];
  const seen = new Set(prevEvents.map((e) => e.id));
  return noticesForEvents(nextEvents.filter((e) => !seen.has(e.id)), ctx);
}
