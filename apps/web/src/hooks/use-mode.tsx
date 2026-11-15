import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PaymentsMode } from "@trato/shared";
import { api } from "@/lib/api";

const ModeContext = createContext<PaymentsMode | null>(null);

/** Reads `GET /api/health` once; `useMode()` returns "mock" | "live" | null (unknown/loading). */
export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PaymentsMode | null>(null);
  useEffect(() => {
    const c = new AbortController();
    api
      .health(c.signal)
      .then((h) => setMode(h.mode))
      .catch(() => undefined);
    return () => c.abort();
  }, []);
  return <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>;
}

export const useMode = (): PaymentsMode | null => useContext(ModeContext);

export function DemoBanner() {
  const mode = useMode();
  if (mode !== "mock") return null;
  return (
    <div
      role="note"
      className="sticky top-0 z-40 bg-amber-300 px-3 py-1.5 text-center text-xs font-extrabold tracking-wide text-amber-950"
    >
      MODO DEMO — sin dinero real
    </div>
  );
}
