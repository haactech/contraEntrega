import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  API_ROUTES,
  APP_ROUTES,
  AddEvidenceMcpInputSchema,
  ApiKeyViewSchema,
  BuyerAcceptMcpInputSchema,
  CreateAgreementMcpInputSchema,
  CreateApiKeyInputSchema,
  CreateApiKeyResponseSchema,
  FeedItemSchema,
  HealthResponseSchema,
  MCP_EVIDENCE_MAX_BASE64_CHARS,
  MCP_TOOLS,
  PostMessageInputSchema,
  ProposalViewSchema,
  CreateAgreementInputSchema,
  compareFeedItems,
  mcpTermsToCreateInput,
  toJsonSchema,
  type FeedItem,
} from "../src";

const sha = "a".repeat(64);
const iso = "2026-11-14T18:00:00.000Z";
const proposal = {
  id: "p1",
  version: 2,
  status: "OPEN",
  terms: {
    title: "Puerta",
    description: "",
    acceptanceCriteria: "Instalada",
    buyerName: "Mariana",
    dueDate: null,
    totalCents: 2_000_000,
    advanceCents: 600_000,
    balanceCents: 1_400_000,
  },
  termsSha256: sha,
  createdAt: iso,
  confirmedAt: null,
};

describe("conversation contracts", () => {
  it("parses a proposal and feed items (discriminated union)", () => {
    expect(ProposalViewSchema.parse(proposal).version).toBe(2);
    const msg = {
      type: "message", id: "m1", seq: 1, occurredAt: iso, authorType: "ASSISTANT", authorName: "Trato",
      kind: "PROPOSAL", text: "Propuesta", proposal, system: false, assistant: { provider: "mock", model: "mock-1" },
    };
    const ev = { type: "event", id: "e1", seq: 1, occurredAt: iso, eventType: "TERMS_REVISED", actorType: "SELLER", payload: { via: "chat" } };
    expect(FeedItemSchema.parse(msg).type).toBe("message");
    expect(FeedItemSchema.parse(ev).type).toBe("event");
    expect(FeedItemSchema.safeParse({ ...msg, kind: "OTHER" }).success).toBe(false);
  });
  it("orders feed by occurredAt, messages before events, then seq", () => {
    const m = (seq: number, t: string): FeedItem => ({ type: "message", id: `m${seq}`, seq, occurredAt: t, authorType: "SELLER", authorName: "x", kind: "TEXT", text: "", proposal: null, system: false, assistant: null });
    const e = (seq: number, t: string): FeedItem => ({ type: "event", id: `e${seq}`, seq, occurredAt: t, eventType: "AGREEMENT_CREATED", actorType: "SYSTEM", payload: {} });
    const sorted = [e(1, iso), m(2, iso), m(1, "2026-11-14T17:00:00.000Z"), m(3, iso)].sort(compareFeedItems);
    expect(sorted.map((x) => x.id)).toEqual(["m1", "m2", "m3", "e1"]);
  });
  it("validates message length", () => {
    expect(PostMessageInputSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(PostMessageInputSchema.safeParse({ text: "a".repeat(2001) }).success).toBe(false);
    expect(PostMessageInputSchema.parse({ text: " hola " }).text).toBe("hola");
  });
  it("exposes routes", () => {
    expect(API_ROUTES.conversationProposalConfirm("c 1", "p1")).toBe("/api/conversations/c%201/proposals/p1/confirm");
    expect(API_ROUTES.publicMessages("tok")).toBe("/api/public/tratos/tok/messages");
    expect(API_ROUTES.mcp).toBe("/mcp");
    expect(APP_ROUTES.room("abc")).toBe("/salas/abc");
  });
  it("health carries assistant status without keys", () => {
    const h = HealthResponseSchema.parse({ ok: true, mode: "mock", assistant: { enabled: true, provider: "mock", model: "m" } });
    expect(Object.keys(h.assistant).sort()).toEqual(["enabled", "model", "provider"]);
    expect(HealthResponseSchema.safeParse({ ok: true, mode: "mock" }).success).toBe(false);
  });
});

describe("api keys", () => {
  it("validates label and the one-time secret response", () => {
    expect(CreateApiKeyInputSchema.safeParse({ label: "" }).success).toBe(false);
    expect(CreateApiKeyInputSchema.safeParse({ label: "x".repeat(61) }).success).toBe(false);
    const key = { id: "k1", label: "Claude", prefix: `${API_KEY_PREFIX}ab12…`, createdAt: iso, lastUsedAt: null, revokedAt: null };
    expect(ApiKeyViewSchema.parse(key).prefix).toBe("trk_ab12…");
    expect(CreateApiKeyResponseSchema.parse({ key, secret: "trk_secret" }).secret).toBe("trk_secret");
    expect(ApiKeyViewSchema.safeParse({ ...key, secret: "x" }).success).toBe(true); // extra keys are stripped
    expect("secret" in ApiKeyViewSchema.parse({ ...key, secret: "x" })).toBe(false);
  });
});

describe("MCP tools", () => {
  const spec = ["list_agreements", "get_agreement", "create_agreement", "share_agreement", "add_evidence", "request_review", "submit_task", "export_agreement",
    "buyer_get_agreement", "buyer_accept", "buyer_review", "review_task", "buyer_create_payment_request", "buyer_refresh_payment"];
  it("registers exactly the spec tools, none can mark PAID", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(spec);
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
    for (const t of MCP_TOOLS) expect(t.name).not.toMatch(/paid|mark|confirm_payment/);
  });
  it("every output has allowedActions and every description is meaningful Spanish", () => {
    for (const t of MCP_TOOLS) {
      const out = toJsonSchema(t.outputSchema) as any;
      expect(out.properties.allowedActions, t.name).toBeDefined();
      expect(out.required, t.name).toContain("allowedActions");
      expect(t.description.length).toBeGreaterThan(80);
    }
  });
  it("buyer tools take buyerToken; seller tools do not", () => {
    for (const t of MCP_TOOLS) {
      const inp = toJsonSchema(t.inputSchema) as any;
      expect(Boolean(inp.properties.buyerToken), t.name).toBe(t.audience === "buyer");
    }
  });
  it("input schemas convert to JSON Schema keeping required fields", () => {
    const by = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
    const req = (n: string) => ((toJsonSchema(by(n).inputSchema) as any).required ?? []).slice().sort();
    expect(req("get_agreement")).toEqual(["agreementId"]);
    expect(req("add_evidence")).toEqual(["agreementId", "imageBase64", "mediaType"]);
    expect(req("buyer_accept")).toEqual(["buyerName", "buyerToken", "consent", "termsSha256"]);
    expect(req("create_agreement")).toEqual(["acceptanceCriteria", "advanceMxn", "buyerName", "title", "totalMxn"]);
    expect(req("list_agreements")).toEqual([]);
    for (const t of MCP_TOOLS) expect(JSON.stringify(toJsonSchema(t.inputSchema))).not.toContain("$ref");
  });
  it("add_evidence enforces size and base64 shape", () => {
    const base = { agreementId: "a1", mediaType: "image/png" as const };
    expect(AddEvidenceMcpInputSchema.safeParse({ ...base, imageBase64: "iVBORw0KGgo=" }).success).toBe(true);
    expect(AddEvidenceMcpInputSchema.safeParse({ ...base, imageBase64: "data:image/png;base64,AAAA" }).success).toBe(false);
    expect(AddEvidenceMcpInputSchema.safeParse({ ...base, imageBase64: "A".repeat(MCP_EVIDENCE_MAX_BASE64_CHARS + 4) }).success).toBe(false);
    expect(AddEvidenceMcpInputSchema.safeParse({ ...base, mediaType: "image/gif", imageBase64: "AAAA" }).success).toBe(false);
  });
  it("buyer_accept requires consent=true", () => {
    const ok = { buyerToken: "tok-12345678", buyerName: "Mariana", termsSha256: sha, consent: true };
    expect(BuyerAcceptMcpInputSchema.safeParse(ok).success).toBe(true);
    expect(BuyerAcceptMcpInputSchema.safeParse({ ...ok, consent: false }).success).toBe(false);
  });
  it("create_agreement converts pesos to a valid CreateAgreementInput", () => {
    const parsed = CreateAgreementMcpInputSchema.parse({
      title: "Puerta", acceptanceCriteria: "Instalada", buyerName: "Mariana", totalMxn: 20000.5, advanceMxn: 8000, dueDate: "2026-12-01",
    });
    const input = mcpTermsToCreateInput(parsed);
    expect(input).toMatchObject({ totalCents: 2_000_050, advanceCents: 800_000, dueDate: "2026-12-01" });
    expect(CreateAgreementInputSchema.safeParse(input).success).toBe(true);
  });
});
