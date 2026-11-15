export const POLL_BUSY_MS = 1_500;
export const POLL_FAST_MS = 3_000;
export const POLL_SLOW_MS = 15_000;

/**
 * Adaptive polling interval: 1.5 s while the assistant is typing, 3 s while a payment is
 * pending, 15 s otherwise, and `null` (paused) when the tab is hidden.
 */
export function pollInterval(opts: { awaitingPayment: boolean; hidden: boolean; busy?: boolean }): number | null {
  if (opts.hidden) return null;
  if (opts.busy) return POLL_BUSY_MS;
  return opts.awaitingPayment ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** Seconds left until `expiresAt` (never negative); null when there is no expiry. */
export function secondsUntil(expiresAtIso: string | null, nowMs: number): number | null {
  if (!expiresAtIso) return null;
  const t = Date.parse(expiresAtIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** 125 -> "02:05"; 3700 -> "1:01:40". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
