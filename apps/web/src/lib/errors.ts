import { ApiError, type ClientErrorCode } from "./api";

const FRIENDLY: Record<ClientErrorCode, string> = {
  VALIDATION_ERROR: "Revisa los datos e intenta de nuevo.",
  UNAUTHORIZED: "Tu sesión terminó. Vuelve a entrar.",
  FORBIDDEN: "No tienes permiso para hacer esto.",
  NOT_FOUND: "No encontramos este trato. Revisa que el enlace esté completo.",
  INVALID_STATE: "Este paso ya no está disponible. Actualizamos la pantalla.",
  TERMS_MISMATCH: "Las condiciones cambiaron. Recarga la página para verlas de nuevo.",
  PAYMENT_PENDING_RECONCILIATION: "Estamos verificando un intento anterior, intenta en unos minutos.",
  RATE_LIMITED: "Demasiados intentos seguidos. Espera un momento y vuelve a intentar.",
  PROVIDER_ERROR: "El servicio de pagos no respondió. Intenta de nuevo en unos minutos.",
  INTERNAL: "Algo salió mal de nuestro lado. Intenta de nuevo.",
  NETWORK: "Sin conexión. Revisa tu internet e intenta de nuevo.",
  BAD_RESPONSE: "Recibimos una respuesta inesperada. Intenta de nuevo.",
};

/**
 * Human message for any thrown value. Server messages are in Spanish and already
 * curated, so they win for validation/state errors where they carry detail.
 */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    const keepServerMessage = e.code === "VALIDATION_ERROR" || e.code === "INVALID_STATE" || e.code === "PROVIDER_ERROR";
    if (keepServerMessage && e.message && !/^Error \d+$/.test(e.message)) return e.message;
    return FRIENDLY[e.code];
  }
  if (e instanceof Error && e.message) return e.message;
  return FRIENDLY.INTERNAL;
}
