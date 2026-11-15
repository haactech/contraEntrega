import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { HonoEnv } from "../env";
import { SESSION_TTL_MS, createSessionValue, readSessionValue } from "../lib/crypto";
import { forbidden, unauthorized } from "../lib/errors";
import { createDb } from "../db/client";
import { OWNER_CANNOT_BUY_MESSAGE, isAgreementOwner, resolveBuyerToken } from "../services/public";

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
  c.set("access", await resolveBuyerToken(createDb(c.env.DB), c.req.param("token") ?? ""));
  await next();
};

/**
 * Invariant 3: the seller who owns the agreement can never act as the buyer
 * (accept / review). Must run after `resolveToken`.
 */
export const forbidOwnerSeller: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const sellerId = await sellerFromCookie(c);
  if (sellerId && (await isAgreementOwner(createDb(c.env.DB), sellerId, c.get("access").agreementId))) {
    throw forbidden(OWNER_CANNOT_BUY_MESSAGE);
  }
  await next();
};
