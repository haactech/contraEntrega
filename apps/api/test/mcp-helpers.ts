import { env } from "cloudflare:workers";
import { API_ROUTES, type AllowedAction, type CreateApiKeyResponse } from "@trato/shared";
import { call, login } from "./helpers";

export interface ToolOutcome {
  isError: boolean;
  /** Parsed structuredContent (success) or the error envelope (isError). */
  data: Record<string, unknown>;
  text: string;
  errorCode?: string;
}

export const MCP_HEADERS = { accept: "application/json, text/event-stream" };

export async function rpc(method: string, params: unknown, opts: { key?: string; id?: number } = {}): Promise<Response> {
  return call(API_ROUTES.mcp, {
    method: "POST",
    json: { jsonrpc: "2.0", id: opts.id ?? 1, method, params },
    headers: { ...MCP_HEADERS, ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
  });
}

export async function tool(name: string, args: Record<string, unknown>, key?: string): Promise<ToolOutcome> {
  const res = await rpc("tools/call", { name, arguments: args }, key ? { key } : {});
  if (res.status !== 200) throw new Error(`tools/call ${name} -> HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }; error?: unknown };
  if (!body.result) throw new Error(`tools/call ${name} -> JSON-RPC error ${JSON.stringify(body.error)}`);
  const text = body.result.content[0]?.text ?? "";
  if (body.result.isError) {
    const data = JSON.parse(text) as { error: { code: string } };
    return { isError: true, data: data as unknown as Record<string, unknown>, text, errorCode: data.error.code };
  }
  expectStructuredMatchesText(body.result.structuredContent, text);
  return { isError: false, data: body.result.structuredContent ?? {}, text };
}

function expectStructuredMatchesText(structured: Record<string, unknown> | undefined, text: string): void {
  if (!structured || JSON.stringify(structured) !== text) throw new Error("structuredContent y content[0].text difieren");
}

export async function newApiKey(sellerId = "seller_1", label = "test"): Promise<{ secret: string; id: string; cookie: string }> {
  const cookie = await login(sellerId);
  const res = await call(API_ROUTES.apiKeys, { method: "POST", cookie, json: { label } });
  if (res.status !== 201) throw new Error(`api key failed ${res.status}`);
  const body = (await res.json()) as CreateApiKeyResponse;
  return { secret: body.secret, id: body.key.id, cookie };
}

export const actionsOf = (o: ToolOutcome): AllowedAction[] => o.data.allowedActions as AllowedAction[];
export const tokenFromUrl = (shareUrl: string): string => shareUrl.split("/t/")[1] as string;

export async function events(agreementId: string): Promise<{ event_type: string; actor_type: string; actor_ref: string | null; payload: Record<string, unknown> }[]> {
  const rows = await env.DB.prepare("SELECT event_type, actor_type, actor_ref, payload_json FROM agreement_events WHERE agreement_id = ? ORDER BY seq")
    .bind(agreementId)
    .all<{ event_type: string; actor_type: string; actor_ref: string | null; payload_json: string }>();
  return rows.results.map((r) => ({ event_type: r.event_type, actor_type: r.actor_type, actor_ref: r.actor_ref, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}
