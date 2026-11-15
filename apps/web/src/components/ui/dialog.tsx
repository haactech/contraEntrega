import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Minimal modal built on <dialog>. `variant="sheet"` docks it to the bottom
 * on mobile. Closes on Escape/backdrop click; native focus trap.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  variant = "sheet",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  variant?: "sheet" | "center" | "fullscreen";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-full max-w-lg bg-white p-0 text-slate-900 backdrop:bg-slate-900/60",
        variant === "sheet" && "mb-0 rounded-t-3xl sm:mb-auto sm:rounded-3xl",
        variant === "center" && "rounded-3xl",
        variant === "fullscreen" && "h-dvh max-h-dvh max-w-none bg-black/95 text-white",
      )}
    >
      {open && (
        <div className={cn(variant !== "fullscreen" && "p-5")}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className={cn("text-xl font-bold", variant === "fullscreen" && "sr-only")}>{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-full hover:bg-slate-100",
                variant === "fullscreen" && "absolute right-3 top-3 z-10 bg-black/50 text-white hover:bg-black/70",
              )}
            >
              <X className="size-6" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
