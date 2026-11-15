import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, HonoEnv } from "../env";
import { AppError } from "../lib/errors";

type Limiter = "RL_PUBLIC_READ" | "RL_PUBLIC_WRITE";

export function clientIp(c: Context<HonoEnv>): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

/** Rate limit via the Workers Rate Limiting binding (no-op if the binding is absent). */
export function rateLimit(
  binding: Limiter,
  keyOf: (c: Context<HonoEnv>) => string,
): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const limiter: AppEnv[Limiter] | undefined = c.env[binding];
    if (limiter) {
      const { success } = await limiter.limit({ key: keyOf(c) });
      if (!success) throw new AppError("RATE_LIMITED", "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.");
    }
    await next();
  };
}

/** Public routes: key = IP + token prefix. */
export const publicKey = (prefix: string) => (c: Context<HonoEnv>): string =>
  `${prefix}:${clientIp(c)}:${(c.req.param("token") ?? "").slice(0, 16)}`;
