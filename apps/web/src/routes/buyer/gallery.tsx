import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { EvidenceView } from "@trato/shared";
import { Dialog } from "@/components/ui/dialog";

/** Thumbnail grid with a fullscreen lightbox. Used by the buyer to review delivery photos. */
export function Gallery({ items }: { items: readonly EvidenceView[] }) {
  const [index, setIndex] = useState<number | null>(null);
  const current = index === null ? null : items[index];
  const go = (delta: number) => setIndex((i) => (i === null ? i : (i + delta + items.length) % items.length));

  return (
    <>
      <ul className="grid grid-cols-3 gap-2">
        {items.map((ev, i) => (
          <li key={ev.id}>
            <button
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Ver foto ${i + 1} de ${items.length}`}
              className="block aspect-square w-full overflow-hidden rounded-xl bg-slate-200"
            >
              <img src={ev.url} alt={`Foto ${i + 1} de la entrega`} loading="lazy" className="size-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={current !== null && current !== undefined} onClose={() => setIndex(null)} title="Foto de la entrega" variant="fullscreen">
        {current && (
          <div className="flex h-dvh flex-col items-center justify-center p-4">
            <img src={current.url} alt={`Foto ${(index ?? 0) + 1} de ${items.length}`} className="max-h-[80dvh] max-w-full object-contain" />
            {items.length > 1 && (
              <div className="mt-3 flex items-center gap-6">
                <button type="button" onClick={() => go(-1)} aria-label="Foto anterior" className="grid size-12 place-items-center rounded-full bg-white/20">
                  <ChevronLeft className="size-6" aria-hidden />
                </button>
                <span className="text-sm" aria-live="polite">
                  {(index ?? 0) + 1} / {items.length}
                </span>
                <button type="button" onClick={() => go(1)} aria-label="Foto siguiente" className="grid size-12 place-items-center rounded-full bg-white/20">
                  <ChevronRight className="size-6" aria-hidden />
                </button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
