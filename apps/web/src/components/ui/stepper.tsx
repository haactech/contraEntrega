import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export interface Step {
  label: string;
}

/** Horizontal progress stepper. `current` = index of the active step; earlier ones are done. */
export function Stepper({ steps, current, done }: { steps: Step[]; current: number; done?: boolean }) {
  return (
    <ol className="flex w-full items-start" aria-label="Progreso del trato">
      {steps.map((s, i) => {
        const complete = done || i < current;
        const active = !done && i === current;
        return (
          <li
            key={s.label}
            aria-current={active ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center text-center"
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  "absolute right-1/2 top-3.5 h-0.5 w-full -translate-y-1/2",
                  complete || active ? "bg-brand-700" : "bg-slate-300",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 grid size-7 place-items-center rounded-full border-2 text-xs font-bold",
                complete && "border-brand-700 bg-brand-700 text-white",
                active && "border-brand-700 bg-white text-brand-700 ring-4 ring-brand-100",
                !complete && !active && "border-slate-300 bg-white text-slate-500",
              )}
            >
              {complete ? <Check className="size-4" aria-hidden /> : i + 1}
            </span>
            <span
              className={cn(
                "mt-1 w-full break-words px-0.5 text-[11px] leading-tight",
                active ? "font-bold text-brand-800" : "text-slate-600",
              )}
            >
              {s.label}
              <span className="sr-only">{complete ? " (hecho)" : active ? " (actual)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
