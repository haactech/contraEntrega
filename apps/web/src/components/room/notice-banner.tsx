import { useEffect } from "react";
import { AlertTriangle, BellRing, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { StateNotice } from "@/lib/notices";

export const NOTICE_TTL_MS = 10_000;

const TONE: Record<StateNotice["tone"], { box: string; icon: typeof BellRing }> = {
  info: { box: "border-sky-300 bg-sky-50 text-sky-950", icon: BellRing },
  success: { box: "border-emerald-300 bg-emerald-50 text-emerald-950", icon: CheckCircle2 },
  warn: { box: "border-amber-300 bg-amber-50 text-amber-950", icon: AlertTriangle },
  danger: { box: "border-red-300 bg-red-50 text-red-950", icon: AlertTriangle },
};

function NoticeRow({ notice, onView, onDismiss }: { notice: StateNotice; onView: () => void; onDismiss: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, NOTICE_TTL_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice.id]);
  const { box, icon: Icon } = TONE[notice.tone];
  return (
    <div
      role={notice.tone === "danger" || notice.tone === "warn" ? "alert" : "status"}
      className={cn("notice-in pointer-events-auto flex items-start gap-2 rounded-xl border-2 p-3 shadow-lg", box)}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-extrabold leading-snug">{notice.title}</p>
        {notice.detail && <p className="mt-0.5 text-sm leading-snug">{notice.detail}</p>}
      </div>
      {notice.target && (
        <button
          type="button"
          onClick={onView}
          className="min-h-9 shrink-0 rounded-lg bg-white/80 px-3 text-sm font-bold underline-offset-2 hover:underline"
        >
          Ver
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Cerrar aviso"
        className="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-white/60"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** Stack of «qué cambió» notices floating over the top of the chat. */
export function NoticeBanner({
  notices,
  onView,
  onDismiss,
}: {
  notices: readonly StateNotice[];
  onView: (n: StateNotice) => void;
  onDismiss: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-0 top-0 z-20 space-y-2 p-2">
      {notices.map((n) => (
        <NoticeRow
          key={n.id}
          notice={n}
          onView={() => {
            onView(n);
            onDismiss(n.id);
          }}
          onDismiss={() => onDismiss(n.id)}
        />
      ))}
    </div>
  );
}
