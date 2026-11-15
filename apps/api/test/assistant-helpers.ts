import type {
  AssistantTurn,
  ConversationView,
  FeedMessage,
  ListConversationsResponse,
  LlmProvider,
  LlmRequest,
  LlmResult,
} from "@trato/shared";
import { call } from "./helpers";

export const turn = (over: Partial<AssistantTurn> = {}): AssistantTurn => ({
  intent: "ANSWER",
  reply: "Entendido.",
  proposal: null,
  missingFields: [],
  suggestedAction: null,
  ...over,
});

type HandlerOut = LlmResult<unknown> | AssistantTurn;
export type Handler = (req: LlmRequest<unknown>, call: number) => Promise<HandlerOut> | HandlerOut;

/** Scriptable provider for tests; counts calls and keeps the requests it received. */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted-1";
  readonly capabilities = { vision: false, structuredOutput: "native" } as const;
  calls = 0;
  requests: LlmRequest<unknown>[] = [];
  constructor(private readonly handler: Handler) {}

  async generateStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls++;
    this.requests.push(req as LlmRequest<unknown>);
    const out = await this.handler(req as LlmRequest<unknown>, this.calls);
    if (typeof out === "object" && out !== null && "intent" in out) {
      return { ok: true, value: out as unknown as T, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 3, model: this.model };
    }
    return out as unknown as LlmResult<T>;
  }
}

export const failing = (kind: "timeout" | "provider_error" | "refusal" = "timeout"): LlmResult<never> => ({
  ok: false,
  kind,
  message: "boom",
  latencyMs: 7,
});

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function newRoom(cookie: string): Promise<string> {
  const res = await call("/api/conversations", { method: "POST", cookie });
  return ((await res.json()) as ConversationView).conversation.id;
}

export async function roomOf(cookie: string, agreementId: string): Promise<string> {
  const list = (await (await call("/api/conversations", { cookie })).json()) as ListConversationsResponse;
  const c = list.conversations.find((x) => x.agreementId === agreementId);
  if (!c) throw new Error("conversation not found");
  return c.id;
}

export async function sellerSays(cookie: string, conversationId: string, text: string): Promise<ConversationView> {
  const res = await call(`/api/conversations/${conversationId}/messages`, { method: "POST", cookie, json: { text } });
  if (res.status !== 200) throw new Error(`post failed ${res.status} ${await res.text()}`);
  return (await res.json()) as ConversationView;
}

export async function buyerSays(token: string, text: string, cookie?: string): Promise<Response> {
  return call(`/api/public/tratos/${token}/messages`, { method: "POST", json: { text }, ...(cookie ? { cookie } : {}) });
}

export async function sellerRoom(cookie: string, conversationId: string): Promise<ConversationView> {
  return (await (await call(`/api/conversations/${conversationId}`, { cookie })).json()) as ConversationView;
}

export async function buyerRoom(token: string): Promise<ConversationView> {
  return (await (await call(`/api/public/tratos/${token}/conversation`)).json()) as ConversationView;
}

export const messagesOf = (v: ConversationView): FeedMessage[] =>
  v.feed.filter((f): f is FeedMessage => f.type === "message");
