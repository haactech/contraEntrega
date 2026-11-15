import { ApiError } from "./api";

/**
 * True when the server does not implement an endpoint yet (the Worker answers a bare 404/405/501,
 * or the SPA fallback returns HTML). A 404 carrying our error envelope ("este enlace no existe")
 * is NOT a missing endpoint: the token or id is simply wrong.
 */
export function isMissingEndpoint(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "BAD_RESPONSE") return true;
  if (e.status === 405 || e.status === 501) return true;
  return e.status === 404 && /^Error 404$/.test(e.message);
}
