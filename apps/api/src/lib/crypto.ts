/** WebCrypto helpers (Workers + Node 22). Never log the outputs of these functions. */
import { sha256Hex } from "@trato/shared";

export { sha256Hex };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Constant-time comparison of two strings (hash-then-compare hides the length). */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/** HKDF-SHA256 with a purpose label (domain separation) -> raw key bytes. */
async function deriveBits(secret: string, purpose: string, bytes: number): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("trato/v1"), info: enc.encode(purpose) },
    base,
    bytes * 8,
  );
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const bits = await deriveBits(secret, "aes-gcm/token-ciphertext", 32);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const bits = await deriveBits(secret, `hmac/${purpose}`, 32);
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** AES-256-GCM. Output: `v1.<iv>.<ciphertext+tag>` (base64url). */
export async function encryptText(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decryptText(secret: string, payload: string): Promise<string> {
  const [v, iv, ct] = payload.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Ciphertext con formato inválido.");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await aesKey(secret),
    fromBase64Url(ct),
  );
  return dec.decode(pt);
}

export async function hmacSign(secret: string, purpose: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, purpose), enc.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

/** Constant-time verification (SubtleCrypto.verify). */
export async function hmacVerify(secret: string, purpose: string, data: string, signature: string): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await hmacKey(secret, purpose), sigBytes, enc.encode(data));
}

/* ------------------------------------------------------------ signed URLs */

/** `path?exp=<epoch ms>&sig=<hmac>`. Used for evidence files (stage 2c). */
export async function signUrl(secret: string, path: string, expiresAtMs: number): Promise<string> {
  const sig = await hmacSign(secret, "url", `${path}\n${expiresAtMs}`);
  return `${path}?exp=${expiresAtMs}&sig=${sig}`;
}

export async function verifySignedUrl(
  secret: string,
  path: string,
  exp: string | null | undefined,
  sig: string | null | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,16}$/.test(exp)) return false;
  if (Number(exp) < nowMs) return false;
  return hmacVerify(secret, "url", `${path}\n${exp}`, sig);
}

/* --------------------------------------------------------- session cookie */

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function createSessionValue(secret: string, sellerId: string, nowMs: number): Promise<string> {
  const body = `${toBase64Url(enc.encode(sellerId))}.${nowMs + SESSION_TTL_MS}`;
  return `${body}.${await hmacSign(secret, "session", body)}`;
}

/** Returns the seller id or null when missing/tampered/expired. */
export async function readSessionValue(secret: string, value: string | undefined, nowMs: number): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts as [string, string, string];
  if (!(await hmacVerify(secret, "session", `${id}.${exp}`, sig))) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < nowMs) return null;
  try {
    return dec.decode(fromBase64Url(id));
  } catch {
    return null;
  }
}
