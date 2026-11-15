import { z } from "zod";
import { MCP_TOOLS, type ErrorCode, type McpTool, toJsonSchema } from "@trato/shared";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { checkRateLimit } from "../middleware/ratelimit";
import { OWNER_CANNOT_BUY_MESSAGE, isAgreementOwner, resolveBuyerToken } from "../services/public";
import type { ApiKeyIdentity } from "../services/api-keys";
import { buyerHandlers } from "./buyer-tools";
import type { McpContext, McpHandlers } from "./context";
import { sellerHandlers } from "./seller-tools";

const handlers: McpHandlers = { ...sellerHandlers, ...buyerHandlers };

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** `inputSchema` / `outputSchema` come from the shared Zod schemas (single source of truth). */
export function listToolDescriptors(): McpToolDescriptor[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", ...toJsonSchema(t.inputSchema) },
    outputSchema: { type: "object", ...toJsonSchema(t.outputSchema) },
    annotations: { title: t.name, readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
  }));
}

export type RegisteredTool = (typeof MCP_TOOLS)[number];

export const findTool = (name: string): RegisteredTool | undefined => MCP_TOOLS.find((t) => t.name === name);

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const errorResult = (code: ErrorCode, message: string): McpToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Datos inválidos.";
  const where = issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
  return issue.code === "invalid_type" || issue.code === "unrecognized_keys" ? `Datos inválidos${where}.` : `${issue.message}${where}`;
}

/** Owner of the buyer link must never act as its buyer (invariant 3), even via MCP. */
async function guardBuyerTool(ctx: McpContext, rawInput: unknown): Promise<void> {
  const token = (rawInput as { buyerToken?: unknown }).buyerToken;
  const { agreementId } = await resolveBuyerToken(ctx.db, typeof token === "string" ? token : "");
  if (ctx.apiKey && (await isAgreementOwner(ctx.db, ctx.apiKey.sellerId, agreementId))) {
    throw new AppError("FORBIDDEN", OWNER_CANNOT_BUY_MESSAGE);
  }
  ctx.buyerAgreementId = agreementId;
}

async function rateKey(tool: McpTool, apiKey: ApiKeyIdentity | null, rawInput: unknown, ip: string): Promise<string> {
  if (apiKey) return `mcp:${apiKey.apiKeyId}:${ip}`;
  const token = (rawInput as { buyerToken?: unknown }).buyerToken;
  const short = typeof token === "string" ? (await sha256Hex(token)).slice(0, 12) : "anon";
  return `mcp:${tool.audience}:${short}:${ip}`;
}

/**
 * Runs one tool. Domain errors (`AppError`) become `isError` results with a Spanish message and code;
 * the output is always validated against the shared output schema before it leaves the server.
 */
export async function callTool(
  env: AppEnv,
  tool: RegisteredTool,
  rawInput: unknown,
  caller: { apiKey: ApiKeyIdentity | null; ip: string },
): Promise<McpToolResult> {
  const ctx: McpContext = { env, db: createDb(env.DB), apiKey: caller.apiKey, ip: caller.ip, now: Date.now(), buyerAgreementId: null };
  try {
    if (tool.audience === "seller" && !ctx.apiKey) {
      throw new AppError(
        "UNAUTHORIZED",
        "Esta herramienta requiere una llave de API del prestador: envía el encabezado Authorization: Bearer trk_... (se crea en Ajustes > Conectar un agente).",
      );
    }
    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", firstIssue(parsed.error));
    await checkRateLimit(env, tool.readOnly ? "RL_PUBLIC_READ" : "RL_PUBLIC_WRITE", await rateKey(tool, ctx.apiKey, parsed.data, ctx.ip));
    if (tool.audience === "buyer") await guardBuyerTool(ctx, parsed.data);

    const handler = handlers[tool.name] as unknown as (c: McpContext, input: unknown) => Promise<unknown>;
    const output = tool.outputSchema.safeParse(await handler(ctx, parsed.data));
    if (!output.success) {
      logger.error("mcp_output_invalid", { tool: tool.name, issues: output.error.issues.map((i) => i.path.join(".")) });
      throw new AppError("INTERNAL", "No pudimos preparar la respuesta. Inténtalo de nuevo.");
    }
    const structured = output.data as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  } catch (err) {
    if (err instanceof AppError) return errorResult(err.code, err.message);
    logger.error("mcp_tool_failed", { tool: tool.name, error: err });
    return errorResult("INTERNAL", "Ocurrió un error inesperado. Inténtalo de nuevo.");
  }
}
