import type { Context } from "hono";
import { ActionViaSchema, type ActionVia } from "@trato/shared";

export const VIA_HEADER = "X-Trato-Via";

/** Optional channel hint (`web | chat | mcp`) recorded in event payloads. Absent / unknown -> undefined. */
export function viaOf(c: Context): ActionVia | undefined {
  const parsed = ActionViaSchema.safeParse(c.req.header(VIA_HEADER)?.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}
