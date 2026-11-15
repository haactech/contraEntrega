import type { Context } from "hono";
import type { z } from "zod";
import { AppError } from "./errors";

function firstMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Datos inválidos.";
  const generic = issue.code === "invalid_type" || issue.code === "unrecognized_keys";
  const where = issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
  return generic ? `Datos inválidos${where}.` : issue.message;
}

/** Parses the JSON body with a shared Zod schema; invalid input -> VALIDATION_ERROR (400). */
export async function parseJson<S extends z.ZodTypeAny>(c: Context, schema: S, allowEmpty = false): Promise<z.output<S>> {
  let raw: unknown;
  const text = await c.req.text();
  if (text.trim() === "") {
    if (!allowEmpty) throw new AppError("VALIDATION_ERROR", "El cuerpo de la solicitud está vacío.");
    raw = {};
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "El cuerpo de la solicitud no es JSON válido.");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", firstMessage(parsed.error));
  return parsed.data;
}
