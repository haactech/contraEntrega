import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from "@trato/shared";
import type { HonoEnv } from "../env";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

const envelope = (code: ErrorCode, message: string): ErrorEnvelope => ({ error: { code, message } });

export const onError: ErrorHandler<HonoEnv> = (err, c) => {
  if (err instanceof AppError) {
    return c.json(envelope(err.code, err.message), err.status as 400);
  }
  if (err instanceof HTTPException) {
    const code: ErrorCode = err.status === 401 ? "UNAUTHORIZED" : err.status === 403 ? "FORBIDDEN" : err.status === 404 ? "NOT_FOUND" : err.status === 429 ? "RATE_LIMITED" : err.status >= 500 ? "INTERNAL" : "VALIDATION_ERROR";
    return c.json(envelope(code, code === "INTERNAL" ? "Ocurrió un error inesperado." : "Solicitud inválida."), ERROR_HTTP_STATUS[code] as 400);
  }
  logger.error("unhandled_error", { path: new URL(c.req.url).pathname.replace(/\/t\/[^/]+/, "/t/[token]"), error: err });
  return c.json(envelope("INTERNAL", "Ocurrió un error inesperado. Inténtalo de nuevo."), 500);
};

export const onNotFound: NotFoundHandler<HonoEnv> = async (c) => {
  const { pathname } = new URL(c.req.url);
  if (!pathname.startsWith("/api/")) return c.env.ASSETS.fetch(c.req.raw);
  return c.json(envelope("NOT_FOUND", "No encontramos lo que buscas."), 404);
};
