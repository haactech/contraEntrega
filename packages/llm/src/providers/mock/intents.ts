import type { AllowedAction } from "@trato/shared";

/** Safety triggers and action keywords for the mock (folded text in, plain data out). */

export interface SafetyFlags {
  injection: boolean;
  payClaim: boolean;
  bank: boolean;
  judge: boolean;
}

const INJECTION =
  /\b(?:ignora|olvida|desobedece|omite|ignore|forget)\b[^.!?\n]{0,40}\b(?:reglas|instrucciones|indicaciones|prompt|rules|instructions)\b|\bactua como\b|\beres ahora\b|\bnuevas instrucciones\b|\bprompt del sistema\b|\bsystem prompt\b|\bmodo (?:desarrollador|dios)\b|\bdeveloper mode\b|\bjailbreak\b/;
const PAY_CLAIM =
  /\bconfirma(?:me|le)?\s+(?:que\s+)?(?:ya\s+)?(?:se\s+)?pag|\bdi(?:le)?\s+(?:a\w+\s+)?que\s+ya\s+(?:se\s+)?pag|\bmarca(?:lo|la)?\s+(?:como\s+)?(?:pagad|aprobad|completad|liberad|recibid)|\blibera(?:r)?\s+(?:ya\s+)?(?:el\s+)?(?:dinero|pago)|\b(?:da|dalo|dala)\s+por\s+(?:pagad|aprobad|entregad)|\bregistra\s+(?:el|mi)\s+pago|\bcambia\s+(?:el\s+)?estado|\bapruebalo\b|\baprueba\s+(?:tu\s+)?(?:la\s+)?entrega\b/;
const BANK =
  /\b(?:clabe|numero de cuenta|cuenta bancaria|cuenta de banco|datos bancarios|numero de tarjeta|tarjeta de credito|cvv|nip|contrasena|codigo de (?:verificacion|seguridad)|token del banco|banca en linea)\b/;
const JUDGE =
  /\bquien tiene (?:la )?razon\b|\ba quien (?:le )?das la razon\b|\bdecide (?:tu|quien)\b|\bcumplio o no\b|\bsi cumple\b|\bcumple con\b|\besta bien hecho\b|\bes culpa de\b|\bquien (?:esta )?(?:mintiendo|miente)\b|\bveredicto\b|\bresuelve la disputa\b|\bdale la razon\b|\bdame la razon\b/;

export function detectSafety(folded: string): SafetyFlags {
  return {
    injection: INJECTION.test(folded),
    payClaim: PAY_CLAIM.test(folded),
    bank: BANK.test(folded),
    judge: JUDGE.test(folded),
  };
}

export const anySafety = (s: SafetyFlags): boolean => s.injection || s.payClaim || s.bank || s.judge;

interface ActionRule {
  action: AllowedAction;
  re: RegExp;
}

const SELLER_RULES: ActionRule[] = [
  { action: "REDELIVER", re: /\b(?:vuelvo a entregar|entregar de nuevo|re ?entrega|ya (?:lo )?corregi|ya (?:quedo )?corregid)\b/ },
  { action: "REQUEST_REVIEW", re: /\b(?:ya termine|ya quedo|ya lo termine|ya acabe|ya esta listo|trabajo terminado|terminado el trabajo|solicitar revision|mandalo a revision|pide la revision)\b/ },
  { action: "UPLOAD_EVIDENCE", re: /\b(?:subir|mandar|enviar|adjuntar|pasar|cargar)\s+(?:las\s+|unas\s+)?(?:mas\s+)?(?:fotos?|evidencias?|imagenes)|\bte mando (?:las )?fotos\b|\bquiero subir\b/ },
  { action: "SHARE_LINK", re: /\b(?:compartir|comparte)\b|\b(?:mandame|pasame|dame)\s+el\s+(?:link|enlace)\b|\benviar(?:le)?\s+el\s+(?:link|enlace)\b|\bwhatsapp\b/ },
  { action: "CONFIRM_PROPOSAL", re: /\bconfirmo\b|\bconfirmar la propuesta\b|\basi esta bien\b|\bla propuesta (?:esta|queda) (?:bien|correcta)\b|\bmandala\b/ },
  { action: "EXPORT", re: /\b(?:comprobante|descargar|exportar)\b/ },
];

const BUYER_RULES: ActionRule[] = [
  { action: "REFRESH_PAYMENT", re: /\b(?:ya pague|ya hice el pago|ya transferi|ya deposite|pago realizado|ya lo pague|ya escanee)\b/ },
  { action: "DISPUTE_DELIVERY", re: /\b(?:no me gusto|no coincid\w*|medidas no|esta mal|no quedo|reportar|reportarle|defecto|no es lo que|danado|rayado|chueco|mal hecho)\b/ },
  { action: "APPROVE_DELIVERY", re: /\b(?:todo bien|recibido|me gusto|quedo muy bien|apruebo|conforme|esta perfecto|quedo perfecto)\b/ },
  { action: "ACCEPT_TERMS", re: /\b(?:acepto|quiero aceptar|trato hecho|de acuerdo con (?:los )?terminos|me parece bien|esta bien asi)\b/ },
  { action: "PAY_ADVANCE", re: /\b(?:quiero pagar|como (?:le )?pago|donde pago|ya quiero pagar|pagar(?:le)?|el qr|codi)\b/ },
  { action: "EXPORT", re: /\b(?:comprobante|descargar|exportar)\b/ },
];

/**
 * Action the speaker's words point to. `allowed` filters the result; when the wished action is not
 * allowed `blocked` reports it so the reply can say so instead of suggesting it.
 */
export function detectAction(
  folded: string,
  role: "SELLER" | "BUYER",
  allowed: readonly string[],
): { action: AllowedAction | null; blocked: AllowedAction | null } {
  const rules = role === "SELLER" ? SELLER_RULES : BUYER_RULES;
  let blocked: AllowedAction | null = null;
  for (const { action, re } of rules) {
    if (!re.test(folded)) continue;
    const candidates: AllowedAction[] =
      action === "PAY_ADVANCE" ? ["PAY_ADVANCE", "PAY_BALANCE"] : [action];
    const ok = candidates.find((c) => allowed.includes(c));
    if (ok) return { action: ok, blocked: null };
    blocked ??= action;
  }
  return { action: null, blocked };
}

export const STATUS_QUESTION =
  /\b(?:ya (?:pagaron|llego|se pago|esta pagado|me pagaron)|como va|en que (?:estado|va)|cuanto falta|que sigue|cual es el estado|ya llego el pago|se recibio)\b/;

export const GREETING_ONLY = /^\s*(?:hola|buenas|buenos dias|buenas tardes|buenas noches|que tal|hey|oye)\W*$/;

export const THANKS_OR_ACK = /^\s*(?:gracias|ok|va|sale|listo|perfecto|entendido|de acuerdo|muchas gracias|enterado)\W*$/;
