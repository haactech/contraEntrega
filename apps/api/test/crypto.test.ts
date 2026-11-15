import { describe, expect, it } from "vitest";
import {
  createSessionValue,
  decryptText,
  encryptText,
  randomToken,
  readSessionValue,
  signUrl,
  timingSafeEqualStrings,
  verifySignedUrl,
} from "../src/lib/crypto";
import { redact } from "../src/lib/logger";

const SECRET = "unit-test-secret-0123456789abcdef";

describe("crypto", () => {
  it("token de 32 bytes base64url, distinto cada vez", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("AES-GCM ida y vuelta; falla con otra clave o ciphertext alterado", async () => {
    const ct = await encryptText(SECRET, "hola");
    expect(ct).not.toContain("hola");
    expect(await decryptText(SECRET, ct)).toBe("hola");
    await expect(decryptText("otra-clave-0123456789abcdef0123", ct)).rejects.toThrow();
    await expect(decryptText(SECRET, `${ct.slice(0, -3)}AAA`)).rejects.toThrow();
  });

  it("comparación en tiempo constante", async () => {
    expect(await timingSafeEqualStrings("1234", "1234")).toBe(true);
    expect(await timingSafeEqualStrings("1234", "12345")).toBe(false);
  });

  it("cookie de sesión: válida, expirada y manipulada", async () => {
    const now = Date.now();
    const v = await createSessionValue(SECRET, "seller_1", now);
    expect(await readSessionValue(SECRET, v, now)).toBe("seller_1");
    expect(await readSessionValue(SECRET, v, now + 13 * 3600_000)).toBeNull();
    expect(await readSessionValue("otra-clave-0123456789abcdef0123", v, now)).toBeNull();
    expect(await readSessionValue(SECRET, undefined, now)).toBeNull();
    expect(await readSessionValue(SECRET, v.replace("seller", "seller"), now)).toBe("seller_1");
  });

  it("URL firmada con expiración", async () => {
    const now = 1_000_000;
    const url = await signUrl(SECRET, "/api/files/evidence/abc", now + 900_000);
    const q = new URL(`http://x${url}`).searchParams;
    expect(await verifySignedUrl(SECRET, "/api/files/evidence/abc", q.get("exp"), q.get("sig"), now)).toBe(true);
    expect(await verifySignedUrl(SECRET, "/api/files/evidence/abc", q.get("exp"), q.get("sig"), now + 900_001)).toBe(false);
    expect(await verifySignedUrl(SECRET, "/api/files/evidence/zzz", q.get("exp"), q.get("sig"), now)).toBe(false);
    expect(await verifySignedUrl(SECRET, "/api/files/evidence/abc", String(now + 9_999_999), q.get("sig"), now)).toBe(false);
  });
});

describe("logger.redact", () => {
  it("oculta CLABE, teléfono, token y headers sensibles", () => {
    const out = JSON.stringify(
      redact({ clabe: "012345678901234567", phoneNumber: "5551234567", authorization: "Bearer x", note: "ver /t/abcdefghijklmnopqrstuvwxyz0123456789 y 012345678901234567" }),
    );
    expect(out).not.toMatch(/0123456789012345|5551234567|Bearer x|abcdefghijklmnop/);
  });
});
