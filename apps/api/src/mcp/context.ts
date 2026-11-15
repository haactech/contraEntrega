import type { z } from "zod";
import type { MCP_TOOLS, McpToolName } from "@trato/shared";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import type { ApiKeyIdentity } from "../services/api-keys";

/** Everything a tool handler needs. One per `tools/call`. */
export interface McpContext {
  env: AppEnv;
  db: Db;
  /** Seller identified by `Authorization: Bearer trk_...`, or null for anonymous (buyer-link) callers. */
  apiKey: ApiKeyIdentity | null;
  ip: string;
  now: number;
  /** Set by the registry for buyer tools: the agreement the `buyerToken` resolves to (never the seller's own). */
  buyerAgreementId: string | null;
}

type ToolOf<N extends McpToolName> = Extract<(typeof MCP_TOOLS)[number], { name: N }>;
export type McpToolInput<N extends McpToolName> = z.output<ToolOf<N>["inputSchema"]>;
/** Handlers return the *input* side of the output schema; the registry then parses it (strips extras). */
export type McpToolOutput<N extends McpToolName> = z.input<ToolOf<N>["outputSchema"]>;

export type McpHandler<N extends McpToolName> = (ctx: McpContext, input: McpToolInput<N>) => Promise<McpToolOutput<N>>;
export type McpHandlers = { [N in McpToolName]: McpHandler<N> };

/** `via` and actor recorded in event payloads for everything done through MCP. */
export const MCP_VIA = "mcp" as const;
export const sellerActor = (apiKey: ApiKeyIdentity): string => `mcp:${apiKey.apiKeyId}`;

export function buyerAgreementOf(ctx: McpContext): string {
  if (!ctx.buyerAgreementId) throw new Error("buyerAgreementId no resuelto");
  return ctx.buyerAgreementId;
}
