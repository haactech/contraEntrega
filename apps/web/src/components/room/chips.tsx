import type { AllowedAction } from "@trato/shared";
import { cn } from "@/lib/cn";
import type { ActionChip } from "@/lib/conversation";

/**
 * Deterministic action chips above the composer (`allowedActions` + labels from shared).
 * They never come from the AI; each one scrolls to its card or runs the action.
 */
export function Chips({
  chips,
  busy,
  onChip,
}: {
  chips: readonly ActionChip[];
  busy?: AllowedAction | null;
  onChip: (action: AllowedAction) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex gap-2 overflow-x-auto border-t border-slate-200 bg-white px-3 py-2" aria-label="Acciones disponibles">
      {chips.map((c) => (
        <li key={c.action} className="shrink-0">
          <button
            type="button"
            onClick={() => onChip(c.action)}
            disabled={busy === c.action}
            data-action={c.action}
            className={cn(
              "min-h-11 whitespace-nowrap rounded-full border px-4 text-sm font-bold disabled:opacity-50",
              c.primary
                ? "border-brand-700 bg-brand-700 text-white hover:bg-brand-800"
                : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
            )}
          >
            {busy === c.action ? "…" : c.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
