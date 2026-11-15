import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert } from "lucide-react";
import type { ConversationView, FeedEvent, FeedMessage, MilestoneView } from "@trato/shared";
import { cn } from "@/lib/cn";
import { eventText, type EventTone } from "@/lib/events";
import { formatDateTime } from "@/lib/labels";
import { groupFeed, type PendingMessage, type Role } from "@/lib/conversation";

export const ASSISTANT_LABEL = "Asistente IA · puede equivocarse; los estados oficiales están en las tarjetas";

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

function Avatar() {
  return (
    <span
      aria-hidden
      className="mt-5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-700 text-xs font-extrabold text-white"
    >
      Trato
    </span>
  );
}

function Bubble({
  own,
  assistant,
  children,
  time,
  extra,
}: {
  own: boolean;
  assistant: boolean;
  children: ReactNode;
  time?: string;
  extra?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "max-w-full whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-sm",
        own
          ? "rounded-br-md bg-brand-700 text-white"
          : assistant
            ? "rounded-bl-md border border-brand-100 bg-brand-50 text-slate-900"
            : "rounded-bl-md border border-slate-200 bg-white text-slate-900",
      )}
    >
      {children}
      {(time || extra) && (
        <span className={cn("mt-0.5 flex items-center justify-end gap-2 text-[11px]", own ? "text-brand-100" : "text-slate-500")}>
          {extra}
          {time}
        </span>
      )}
    </div>
  );
}

function MessageGroup({
  role,
  authorType,
  authorName,
  items,
}: {
  role: Role;
  authorType: FeedMessage["authorType"];
  authorName: string;
  items: FeedMessage[];
}) {
  const own = authorType === role;
  const assistant = authorType === "ASSISTANT";
  return (
    <li className={cn("flex gap-2", own ? "justify-end" : "justify-start")} data-author={authorType}>
      {assistant && <Avatar />}
      <div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1", own ? "items-end" : "items-start")}>
        {!own && (
          <p className="px-1 text-xs font-bold text-slate-700">
            {assistant ? "Trato" : authorName}
            {assistant && <span className="ml-1.5 font-medium text-slate-600">· {ASSISTANT_LABEL}</span>}
          </p>
        )}
        {items.map((m) => (
          <Bubble key={m.id} own={own} assistant={assistant} time={hhmm(m.occurredAt)}>
            {m.text}
          </Bubble>
        ))}
      </div>
    </li>
  );
}

const TONE_STYLE: Record<EventTone, string> = {
  neutral: "border-slate-200 bg-white text-slate-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
};

export function EventCard({ event, milestones }: { event: FeedEvent; milestones: readonly MilestoneView[] }) {
  const t = eventText({ type: event.eventType, payload: event.payload }, milestones);
  const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "danger" ? TriangleAlert : t.tone === "warn" ? AlertCircle : Info;
  return (
    <li className="flex justify-center">
      <div className={cn("flex max-w-[92%] items-start gap-2 rounded-xl border px-3 py-1.5 text-center text-sm", TONE_STYLE[t.tone])}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="text-left">
          <p className="font-bold leading-tight">{t.title}</p>
          {t.detail && <p className="text-[13px] leading-snug">{t.detail}</p>}
          <p className="text-[11px] opacity-70">{formatDateTime(event.occurredAt)}</p>
        </div>
      </div>
    </li>
  );
}

export function TypingIndicator() {
  return (
    <li className="flex gap-2" aria-label="Trato está escribiendo">
      <Avatar />
      <div className="flex flex-col items-start gap-1">
        <p className="px-1 text-xs font-bold text-slate-700">Trato</p>
        <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-brand-100 bg-brand-50 px-3.5 py-2 text-sm text-slate-700">
          <span className="flex gap-0.5" aria-hidden>
            <span className="size-1.5 animate-bounce rounded-full bg-brand-600 [animation-delay:-0.3s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-brand-600 [animation-delay:-0.15s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-brand-600" />
          </span>
          Trato está escribiendo…
        </div>
      </div>
    </li>
  );
}

function PendingBubble({ p, onRetry }: { p: PendingMessage; onRetry: (id: string) => void }) {
  return (
    <li className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        <Bubble
          own
          assistant={false}
          extra={
            p.status === "sending" ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Enviando…
              </span>
            ) : undefined
          }
        >
          <span className={cn(p.status === "failed" && "opacity-70")}>{p.text}</span>
        </Bubble>
        {p.status === "failed" && (
          <p role="alert" className="flex flex-wrap items-center justify-end gap-2 text-xs font-medium text-red-700">
            {p.error ?? "No se pudo enviar."}
            <button
              type="button"
              onClick={() => onRetry(p.clientId)}
              className="min-h-11 rounded-lg px-2 font-bold underline"
            >
              Reintentar
            </button>
          </p>
        )}
      </div>
    </li>
  );
}

/** The chat transcript: grouped bubbles, status cards for events, proposal cards, typing indicator. */
export function Feed({
  view,
  pending,
  onRetry,
  renderProposal,
  empty,
}: {
  view: ConversationView;
  pending: readonly PendingMessage[];
  onRetry: (clientId: string) => void;
  renderProposal: (m: FeedMessage) => ReactNode;
  empty: ReactNode;
}) {
  const entries = groupFeed(view.feed);
  const milestones = view.agreement?.milestones ?? [];
  const isEmpty = entries.length === 0 && pending.length === 0;
  return (
    <ol className="flex flex-col gap-2.5 py-3" aria-label="Conversación">
      {isEmpty && <li>{empty}</li>}
      {entries.map((e) => {
        switch (e.kind) {
          case "messages":
            return <MessageGroup key={e.key} role={view.role} authorType={e.authorType} authorName={e.authorName} items={e.items} />;
          case "proposal":
            return (
              <li key={e.key} className="flex flex-col gap-1">
                {e.item.authorType === "ASSISTANT" ? (
                  <p className="px-1 text-xs font-bold text-slate-700">
                    Trato <span className="font-medium text-slate-600">· {ASSISTANT_LABEL}</span>
                  </p>
                ) : (
                  <p className="px-1 text-xs font-bold text-slate-700">{e.item.authorName}</p>
                )}
                {e.item.text.trim() !== "" && (
                  <div className="max-w-[85%]">
                    <Bubble own={e.item.authorType === view.role} assistant={e.item.authorType === "ASSISTANT"}>
                      {e.item.text}
                    </Bubble>
                  </div>
                )}
                {renderProposal(e.item)}
              </li>
            );
          case "event":
            return <EventCard key={e.key} event={e.item} milestones={milestones} />;
          case "system":
            return (
              <li key={e.key} className="flex justify-center px-2">
                <p role="status" className="max-w-[90%] rounded-lg bg-amber-50 px-3 py-2 text-center text-xs text-amber-900 ring-1 ring-amber-200">
                  {e.item.text}
                </p>
              </li>
            );
        }
      })}
      {pending.map((p) => (
        <PendingBubble key={p.clientId} p={p} onRetry={onRetry} />
      ))}
      {view.assistantBusy && <TypingIndicator />}
    </ol>
  );
}
