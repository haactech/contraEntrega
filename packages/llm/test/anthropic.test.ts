import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AssistantTurnSchema } from "@trato/shared";
import { createLlmProvider } from "../src";
import { createAnthropicProvider, supportsServerFallback } from "../src/providers/anthropic";
import type { LlmFactoryConfig } from "../src/core";

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function message(text: string, over: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...over,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false", ...headers },
  });

function fakeFetch(responses: Array<Response | (() => Response)>, rec: Recorded[] = []) {
  let i = 0;
  const f: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    rec.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Record<string, unknown> });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return typeof next === "function" ? next() : next;
  };
  return f;
}

const base: LlmFactoryConfig = { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-test-secret" };
const Out = z.object({ n: z.number() });
const req = { system: "SYS", messages: [{ role: "user" as const, content: "hola" }], schema: Out, schemaName: "Out" };

describe("anthropic: cuerpo de la solicitud", () => {
  it("usa output_config.format json_schema, fallbacks por defecto y cache_control; sin temperature ni tool_choice", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, { fetch: fakeFetch([json(200, message('{"n":7}'))], rec) });
    const r = await p.generateStructured(req);
    expect(r.ok && r.value).toEqual({ n: 7 });
    expect(r.ok && r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    const call = rec[0]!;
    expect(call.url).toContain("/v1/messages");
    expect(call.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const b = call.body;
    expect(b["model"]).toBe("claude-opus-5-5");
    expect(b["max_tokens"]).toBe(16000);
    expect(b["fallbacks"]).toBe("default");
    expect(b).not.toHaveProperty("temperature");
    expect(b).not.toHaveProperty("top_p");
    expect(b).not.toHaveProperty("top_k");
    expect(b).not.toHaveProperty("tool_choice");
    expect(b).not.toHaveProperty("thinking");
    const oc = b["output_config"] as { format: { type: string; schema: Record<string, unknown> }; effort?: string };
    expect(oc.format.type).toBe("json_schema");
    expect(oc.format.schema["type"]).toBe("object");
    expect(oc.format.schema["additionalProperties"]).toBe(false);
    expect(oc).not.toHaveProperty("effort");
    expect(b["system"]).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    // the last message is the user turn: no prefill
    const msgs = b["messages"] as Array<{ role: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe("user");
    // key never leaves in the body
    expect(JSON.stringify(b)).not.toContain("sk-test-secret");
  });

  it("serverFallback=false usa el endpoint estable sin betas ni fallbacks", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(
      { ...base, serverFallback: false },
      { fetch: fakeFetch([json(200, message('{"n":1}'))], rec) },
    );
    await p.generateStructured(req);
    expect(rec[0]!.headers.get("anthropic-beta")).toBeNull();
    expect(rec[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("desactiva el fallback para modelos que no lo aceptan", async () => {
    expect(supportsServerFallback("claude-opus-5-5")).toBe(true);
    expect(supportsServerFallback("claude-haiku-5-5")).toBe(true);
    expect(supportsServerFallback("claude-sonnet-4-6")).toBe(false);
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(
      { ...base, model: "claude-sonnet-4-6" },
      { fetch: fakeFetch([json(200, message('{"n":1}'))], rec) },
    );
    await p.generateStructured(req);
    expect(rec[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("envía effort solo si se define y rechaza valores inválidos", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(
      { ...base, effort: "low" },
      { fetch: fakeFetch([json(200, message('{"n":1}'))], rec) },
    );
    await p.generateStructured(req);
    expect((rec[0]!.body["output_config"] as { effort: string }).effort).toBe("low");
    expect(() => createAnthropicProvider({ ...base, effort: "ultra" })).toThrow();
  });

  it("convierte imágenes a bloques base64", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, { fetch: fakeFetch([json(200, message('{"n":1}'))], rec) });
    await p.generateStructured({
      ...req,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "mira" },
            { type: "image", mediaType: "image/png", dataBase64: "AAAA" },
          ],
        },
      ],
    });
    const content = (rec[0]!.body["messages"] as Array<{ content: unknown }>)[0]!.content;
    expect(content).toEqual([
      { type: "text", text: "mira" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(p.capabilities).toEqual({ vision: true, structuredOutput: "native" });
  });

  it("el schema de AssistantTurn llega sin type-arrays (anyOf para null)", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, {
      fetch: fakeFetch([json(200, message("{}"))], rec),
    });
    await p.generateStructured({ ...req, schema: AssistantTurnSchema, schemaName: "AssistantTurn" });
    const text = JSON.stringify((rec[0]!.body["output_config"] as { format: unknown }).format);
    expect(text).not.toMatch(/"type":\[/);
    expect(text).toContain('"anyOf"');
  });
});

describe("anthropic: respuestas y errores", () => {
  it("refusal -> kind refusal", async () => {
    const p = createAnthropicProvider(base, {
      fetch: fakeFetch([json(200, message("", { stop_reason: "refusal", content: [] }))]),
    });
    const r = await p.generateStructured(req);
    expect(!r.ok && r.kind).toBe("refusal");
  });

  it("max_tokens -> invalid_output sin reparar", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, {
      fetch: fakeFetch([json(200, message('{"n"', { stop_reason: "max_tokens" }))], rec),
    });
    const r = await p.generateStructured(req);
    expect(!r.ok && r.kind).toBe("invalid_output");
    expect(rec).toHaveLength(1);
  });

  it("ignora el texto del modelo que declinó antes de un bloque fallback", async () => {
    const p = createAnthropicProvider(base, {
      fetch: fakeFetch([
        json(
          200,
          message("", {
            content: [
              { type: "text", text: "parcial {basura" },
              { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal", category: null } },
              { type: "text", text: '{"n":5}' },
            ],
          }),
        ),
      ]),
    });
    const r = await p.generateStructured(req);
    expect(r.ok && r.value).toEqual({ n: 5 });
  });

  it("401 -> auth, 429 -> rate_limited, 500 -> provider_error", async () => {
    const err = (status: number) => json(status, { type: "error", error: { type: "x", message: "SECRETO-DEL-USUARIO" } });
    const kinds: string[] = [];
    for (const status of [401, 403, 429, 500]) {
      const p = createAnthropicProvider(base, { fetch: fakeFetch([err(status)]) });
      const r = await p.generateStructured(req);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        kinds.push(r.kind);
        expect(r.message).not.toContain("SECRETO");
        expect(r.message).not.toContain("sk-test-secret");
      }
    }
    expect(kinds).toEqual(["auth", "auth", "rate_limited", "provider_error"]);
  });

  it("timeout -> kind timeout", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const p = createAnthropicProvider({ ...base, timeoutMs: 40 }, { fetch: hang });
    const r = await p.generateStructured(req);
    expect(!r.ok && r.kind).toBe("timeout");
  });

  it("sin API key -> auth sin llamar a la red", async () => {
    const p = createAnthropicProvider({ provider: "anthropic", model: "claude-opus-5-5" });
    const r = await p.generateStructured(req);
    expect(!r.ok && r.kind).toBe("auth");
  });

  it("repara una vez: inválida y luego válida, enviando el error", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, {
      fetch: fakeFetch([json(200, message('{"n":"mal"}')), json(200, message('{"n":2}'))], rec),
    });
    const r = await p.generateStructured(req);
    expect(r.ok && r.value).toEqual({ n: 2 });
    expect(r.ok && r.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(rec).toHaveLength(2);
    const second = rec[1]!.body["messages"] as Array<{ role: string; content: string }>;
    expect(second).toHaveLength(3);
    expect(second[1]!.role).toBe("assistant");
    expect(second[2]!.role).toBe("user");
    expect(second[2]!.content).toContain("n:");
  });

  it("dos salidas inválidas -> invalid_output (una sola reparación)", async () => {
    const rec: Recorded[] = [];
    const p = createAnthropicProvider(base, { fetch: fakeFetch([() => json(200, message("no es json"))], rec) });
    const r = await p.generateStructured(req);
    expect(!r.ok && r.kind).toBe("invalid_output");
    expect(rec).toHaveLength(2);
  });

  it("createLlmProvider construye el proveedor anthropic", () => {
    const p = createLlmProvider(base);
    expect(p.id).toBe("anthropic");
    expect(p.model).toBe("claude-opus-5-5");
  });
});
