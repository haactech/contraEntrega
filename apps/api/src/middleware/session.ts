import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { HonoEnv } from "../env";
import { SESSION_TTL_MS, createSessionValue, readSessionValue } from "../lib/crypto";
import { forbidden, notFound, unauthorized } from "../lib/errors";
import { createDb } from "../db/client";
import { findAccessByHash } from "../repos/agreements";
import { agreements } from "../db/schema";
import { eq } from "drizzle-orm";
import { sha256Hex } from "../lib/crypto";

export const SESSION_COOKIE = "trato_session";

const secureCookie = (c: Context<HonoEnv>): boolean => !c.env.PUBLIC_APP_URL.startsWith("http://localhost");

export async function issueSessionCookie(c: Context<HonoEnv>, sellerId: string): Promise<void> {
  const value = await createSessionValue(c.env.SESSION_SECRET, sellerId, Date.now());
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookie(c) });
}

async function sellerFromCookie(c: Context<HonoEnv>): Promise<string | null> {
  return readSessionValue(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), Date.now());
}

/** Sets `sellerId` (or null) without failing. */
export const sessionOptional: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set("sellerId", await sellerFromCookie(c));
  await next();
};

/** Requires a valid seller session cookie (401 otherwise). */
export const requireSeller: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const id = await sellerFromCookie(c);
  if (!id) throw unauthorized();
  c.set("sellerId", id);
  await next();
};

/** Public routes: resolves `:token` to its agreement (404 for unknown or revoked, same message). */
export const resolveToken: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const token = c.req.param("token");
  if (!token || token.length > 128) throw notFound("Este enlace no existe o ya no está vigente.");
  const tokenHash = await sha256Hex(token);
  const access = await findAccessByHash(createDb(c.env.DB), tokenHash);
  if (!access || access.revokedAt !== null) throw notFound("Este enlace no existe o ya no está vigente.");
  c.set("access", { agreementId: access.agreementId, tokenHash });
  await next();
};

/**
 * Invariant 3: the seller who owns the agreement can never act as the buyer
 * (accept / review). Must run after `resolveToken`.
 */
export const forbidOwnerSeller: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const sellerId = await sellerFromCookie(c);
  if (sellerId) {
    const rows = await createDb(c.env.DB)
      .select({ sellerId: agreements.sellerId })
      .from(agreements)
      .where(eq(agreements.id, c.get("access").agreementId))
      .limit(1);
    if (rows[0]?.sellerId === sellerId) {
      throw forbidden("No puedes realizar esta acción en tu propio trato. Debe hacerla el comprador desde su enlace.");
    }
  }
  await next();
};

