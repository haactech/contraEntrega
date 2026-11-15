import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { logger } from "../lib/logger";
import { authenticateApiKey, type ApiKeyIdentity } from "../services/api-keys";
import { callTool, findTool, listToolDescriptors } from "./registry";

/** Base64 evidence (~7 MB) plus JSON framing. */
export const MCP_MAX_BODY_BYTES = 8 * 1024 * 1024;
const SERVER_INFO = { name: "trato", version: "0.3.0" } as const;

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

/** Reads the body with a hard cap, even without Content-Length (chunked). */
async function readBounded(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

type Auth = { ok: true; apiKey: ApiKeyIdentity | null } | { ok: false };

/** No Authorization header -> anonymous (buyer-link tools). A present but invalid/revoked key is rejected. */
async function authenticate(env: AppEnv, req: Request, now: number): Promise<Auth> {
  const header = req.headers.get("authorization");
  if (header === null) return { ok: true, apiKey: null };
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return { ok: false };
  const identity = await authenticateApiKey(createDb(env.DB), m[1] as string, now);
  return identity ? { ok: true, apiKey: identity } : { ok: false };
}

function buildServer(env: AppEnv, caller: { apiKey: ApiKeyIdentity | null; ip: string }): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "Trato: tratos con anticipo y saldo contra entrega. Las herramientas del prestador requieren una llave de API; las del comprador reciben el buyerToken del enlace. Ningún agente puede marcar pagos como pagados, cambiar montos o cuentas, ni aprobar su propia entrega. Revisa siempre allowedActions antes de actuar.",
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listToolDescriptors() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Herramienta desconocida: ${request.params.name}`);
    return callTool(env, tool, request.params.arguments, caller);
  });
  return server;
}

/**
 * Stateless Streamable HTTP endpoint (POST /mcp): a fresh Server + transport per request, JSON responses
 * (no SSE, no sessions, no Durable Objects).
 */
export async function handleMcpRequest(req: Request, env: AppEnv, ip: string): Promise<Response> {
  if (req.method !== "POST") {
    return rpcError(405, -32000, "Método no permitido: este servidor MCP es sin estado y solo acepta POST.", { Allow: "POST" });
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return rpcError(415, -32000, "Content-Type debe ser application/json.");
  }
  const auth = await authenticate(env, req, Date.now());
  if (!auth.ok) {
    return rpcError(401, -32001, "Llave de API inválida o revocada.", { "WWW-Authenticate": 'Bearer realm="trato"' });
  }
  const text = await readBounded(req, MCP_MAX_BODY_BYTES);
  if (text === null) return rpcError(413, -32000, "La solicitud supera el límite de 8 MB.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "JSON inválido.");
  }

  // Clients that omit `Accept` still get a JSON answer.
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  const forwarded = new Request(req.url, { method: "POST", headers, body: text });

  const server = buildServer(env, { apiKey: auth.apiKey, ip });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(forwarded, { parsedBody: body });
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    return out;
  } catch (err) {
    logger.error("mcp_transport_failed", { error: err });
    return rpcError(500, -32603, "Error interno del servidor MCP.");
  } finally {
    await server.close().catch(() => undefined);
  }
}

