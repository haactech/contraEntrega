import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmProvider } from "../src";
import { createOpenAiCompatibleProvider } from "../src/providers/openai-compatible";
import type { LlmFactoryConfig } from "../src/core";

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const completion = (content: string, over: Record<string, unknown> = {}) => ({
  model: "gpt-x",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
  ...over,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(responses: Array<() => Response>, rec: Recorded[] = []): typeof fetch {
  let i = 0;
  return async (input, init) => {
    const req = new Request(input, init);
    rec.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Record<string, unknown> });
    return responses[Math.min(i++, responses.length - 1)]!();
  };
}

const base: LlmFactoryConfig = {
  provider: "openai-compatible",
  model: "gpt-x",
  apiKey: "sk-secret",
  baseUrl: "https://example.test/v1/",
};
const Out = z.object({ n: z.number(), s: z.string().nullable() });
const req = { system: "SYS", messages: [{ role: "user" as const, content: "hola" }], schema: Out, schemaName: "Out Name!" };

describe("openai-compatible", () => {
  it("modo native: response_format json_schema estricto y Bearer", async () => {
    const rec: Recorded[] = [];
    const p = createOpenAiCompatibleProvider(base, { fetch: fakeFetch([() => json(200, completion('{"n":1,"s":null}'))], rec) });
    const r = await p.generateStructured(req);
    expect(r.ok && r.value).toEqual({ n: 1, s: null });
    expect(r.ok && r.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    const c = rec[0]!;
    expect(c.url).toBe("https://example.test/v1/chat/completions");
    expect(c.headers.get("authorization")).toBe("Bearer sk-secret");
    const rf = c.body["response_format"] as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.name).toBe("Out_Name_");
    expect(rf.json_schema.schema["additionalProperties"]).toBe(false);
    expect(rf.json_schema.schema["required"]).toEqual(["n", "s"]);
    const msgs = c.body["messages"] as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(c.body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(c.body)).not.toContain("sk-secret");
  });

  it("modo prompted: instrucción en el sistema, sin response_format, extrae el JSON del texto", async () => {
    const rec: Recorded[] = [];
    const p = createOpenAiCompatibleProvider(
      { ...base, structured: "prompted" },
      { fetch: fakeFetch([() => json(200, completion('Aquí va:\n```json\n{"n":4,"s":"x"}\n```'))], rec) },
    );
    expect(p.capabilities.structuredOutput).toBe("prompted");
    const r = await p.generateStructured({ ...req, maxTokens: 500 });
    expect(r.ok && r.value).toEqual({ n: 4, s: "x" });
    expect(rec[0]!.body).not.toHaveProperty("response_format");
    expect(rec[0]!.body["max_tokens"]).toBe(500);
    const sys = (rec[0]!.body["messages"] as Array<{ content: string }>)[0]!.content;
    expect(sys).toContain("JSON Schema");
    expect(sys.startsWith("SYS")).toBe(true);
  });

  it("imágenes como image_url con data URL", async () => {
    const rec: Recorded[] = [];
    const p = createOpenAiCompatibleProvider({ ...base, vision: true }, { fetch: fakeFetch([() => json(200, completion('{"n":1,"s":null}'))], rec) });
    await p.generateStructured({
      ...req,
      messages: [{ role: "user", content: [{ type: "text", text: "mira" }, { type: "image", mediaType: "image/jpeg", dataBase64: "QQ==" }] }],
    });
    expect((rec[0]!.body["messages"] as Array<{ content: unknown }>)[1]!.content).toEqual([
      { type: "text", text: "mira" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QQ==" } },
    ]);
    expect(p.capabilities.vision).toBe(true);
  });

  it("mapea 401/403 -> auth, 429 -> rate_limited, 500 -> provider_error, red -> provider_error", async () => {
    const kinds: string[] = [];
    for (const status of [401, 403, 429, 500]) {
      const p = createOpenAiCompatibleProvider(base, { fetch: fakeFetch([() => json(status, { error: { message: "boom" } })]) });
      const r = await p.generateStructured(req);
      if (!r.ok) kinds.push(r.kind);
    }
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await createOpenAiCompatibleProvider(base, { fetch: down }).generateStructured(req);
    if (!r.ok) kinds.push(r.kind);
    expect(kinds).toEqual(["auth", "auth", "rate_limited", "provider_error", "provider_error"]);
  });

  it("timeout -> kind timeout", async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("x", "AbortError"))));
    const r = await createOpenAiCompatibleProvider({ ...base, timeoutMs: 30 }, { fetch: hang }).generateStructured(req);
    expect(!r.ok && r.kind).toBe("timeout");
  });

  it("refusal y length", async () => {
    const refusal = completion("", { choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] });
    const length = completion('{"n"', { choices: [{ finish_reason: "length", message: { content: '{"n"' } }] });
    const a = await createOpenAiCompatibleProvider(base, { fetch: fakeFetch([() => json(200, refusal)]) }).generateStructured(req);
    const b = await createOpenAiCompatibleProvider(base, { fetch: fakeFetch([() => json(200, length)]) }).generateStructured(req);
    expect(!a.ok && a.kind).toBe("refusal");
    expect(!b.ok && b.kind).toBe("invalid_output");
  });

  it("repara una vez con el error de validación", async () => {
    const rec: Recorded[] = [];
    const p = createOpenAiCompatibleProvider(base, {
      fetch: fakeFetch([() => json(200, completion('{"n":"x","s":null}')), () => json(200, completion('{"n":2,"s":null}'))], rec),
    });
    const r = await p.generateStructured(req);
    expect(r.ok && r.value).toEqual({ n: 2, s: null });
    expect(rec).toHaveLength(2);
    const msgs = rec[1]!.body["messages"] as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[3]!.content).toContain("JSON corregido");
  });

  it("la fábrica usa openai-compatible", () => {
    expect(createLlmProvider(base).id).toBe("openai-compatible");
  });
});
