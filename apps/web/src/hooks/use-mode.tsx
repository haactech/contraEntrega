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

const HIDE_KEY = "trato.hideDemoBanner";

/**
 * Video recording: `?video=1` hides the «MODO DEMO» banner on this origin (remembered in
 * localStorage), `?video=0` shows it again. Only the banner: payments stay simulated.
 */
function readHideBanner(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("video");
    if (q === "1") window.localStorage.setItem(HIDE_KEY, "1");
    if (q === "0") window.localStorage.removeItem(HIDE_KEY);
    return window.localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

/** True when the «MODO DEMO» banner is on screen (mock mode and not hidden for a video). */
export function useDemoBannerVisible(): boolean {
  const mode = useMode();
  const [hidden] = useState(readHideBanner);
  return mode === "mock" && !hidden;
}

export function DemoBanner() {
  if (!useDemoBannerVisible()) return null;
  return (
    <div
      role="note"
      className="sticky top-0 z-40 bg-amber-300 px-3 py-1.5 text-center text-xs font-extrabold tracking-wide text-amber-950"
    >
      MODO DEMO — sin dinero real
    </div>
  );
}
