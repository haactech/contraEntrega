import { describe, expect, it } from "vitest";
import { z } from "zod";
import { firstJsonObject, generateWithRepair, parseJsonLoose, repairsOf, strictifySchema } from "../src/core";
import type { Attempt } from "../src/core";

const schema = z.object({ n: z.number() });
const usage = { inputTokens: 1, outputTokens: 2 };

describe("parseJsonLoose", () => {
  it("acepta JSON directo, con fences y con prosa", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonLoose('Claro: {"a":"}{","b":{"c":2}} listo')).toEqual({
      ok: true,
      value: { a: "}{", b: { c: 2 } },
    });
    expect(parseJsonLoose("nada").ok).toBe(false);
    expect(firstJsonObject("{ sin cerrar")).toBeNull();
  });
});

describe("strictifySchema", () => {
  it("convierte type [x, null] en anyOf", () => {
    expect(strictifySchema({ type: ["string", "null"], description: "d" })).toEqual({
      description: "d",
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });
});

describe("generateWithRepair", () => {
  it("repara una vez y suma tokens", async () => {
    const seen: number[] = [];
    const attempt: Attempt = async (messages) => {
      seen.push(messages.length);
      return seen.length === 1
        ? { ok: true, text: '{"n":"x"}', usage, model: "m" }
        : { ok: true, text: '{"n":3}', usage, model: "m" };
    };
    const r = await generateWithRepair(
      { system: "s", messages: [{ role: "user", content: "hola" }], schema, schemaName: "T" },
      { model: "m", timeoutMs: 1000, attempt },
    );
    expect(r.ok && r.value).toEqual({ n: 3 });
    expect(seen).toEqual([1, 3]);
    expect(r.ok && r.usage).toEqual({ inputTokens: 2, outputTokens: 4 });
    expect(repairsOf(r)).toBe(1);
  });

  it("falla con invalid_output tras una sola reparación", async () => {
    let calls = 0;
    const attempt: Attempt = async () => {
      calls++;
      return { ok: true, text: "{}", usage, model: "m" };
    };
    const r = await generateWithRepair(
      { system: "s", messages: [{ role: "user", content: "hola" }], schema, schemaName: "T" },
      { model: "m", timeoutMs: 1000, attempt },
    );
    expect(calls).toBe(2);
    expect(!r.ok && r.kind).toBe("invalid_output");
  });

  it("propaga errores del proveedor sin reparar", async () => {
    const attempt: Attempt = async () => ({ ok: false, kind: "auth", message: "x" });
    const r = await generateWithRepair(
      { system: "s", messages: [{ role: "user", content: "hola" }], schema, schemaName: "T" },
      { model: "m", timeoutMs: 1000, attempt },
    );
    expect(!r.ok && r.kind).toBe("auth");
  });
});
