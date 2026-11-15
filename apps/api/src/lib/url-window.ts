/**
 * Signed evidence URLs expire on fixed windows so the public view stays cacheable (ETag):
 * exp = start of the current 15-minute window + 30 minutes. Identical for every request in a
 * window, and the window index is part of the ETag, so a 304 never revalidates expired URLs.
 */
export const EVIDENCE_WINDOW_MS = 15 * 60 * 1000;

export const evidenceWindow = (nowMs: number): number => Math.floor(nowMs / EVIDENCE_WINDOW_MS);

export const evidenceUrlExpiry = (nowMs: number): number => evidenceWindow(nowMs) * EVIDENCE_WINDOW_MS + 2 * EVIDENCE_WINDOW_MS;
