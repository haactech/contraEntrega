import type { EventView, MilestoneView } from "@trato/shared";
import { eventText, type EventTone } from "@/lib/events";
import { formatDateTime } from "@/lib/labels";
import { cn } from "@/lib/cn";

const DOT: Record<EventTone, string> = {
  neutral: "bg-slate-400",
  success: "bg-brand-700",
  warn: "bg-amber-500",
  danger: "bg-red-600",
};

/** Reusable history (seller and buyer). Newest first. */
export function Timeline({
  events,
  milestones,
  empty = "Aún no hay movimientos.",
  cleaning = false,
}: {
  events: readonly EventView[];
  milestones: readonly MilestoneView[];
  empty?: string;
  cleaning?: boolean;
}) {
  if (events.length === 0) return <p className="text-sm text-slate-600">{empty}</p>;
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  return (
    <ol className="relative space-y-4 border-l-2 border-slate-200 pl-5" aria-label="Historial del trato">
      {ordered.map((ev) => {
        const t = eventText(ev, milestones, { cleaning });
        return (
          <li key={ev.id} className="relative">
            <span aria-hidden className={cn("absolute -left-[27px] top-1.5 size-3 rounded-full ring-4 ring-slate-50", DOT[t.tone])} />
            <p className="font-semibold text-slate-900">{t.title}</p>
            {t.detail && <p className="text-sm text-slate-700">{t.detail}</p>}
            <p className="text-xs text-slate-500">
              <time dateTime={ev.occurredAt}>{formatDateTime(ev.occurredAt)}</time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
