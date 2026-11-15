import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src";
import { loadSuite } from "../evals/dataset";
import { gradeCase } from "../evals/grading";
import { checkThresholds, percentile, renderMarkdown, renderMatrix, summarize } from "../evals/report";
import { executeEval, runCase } from "../evals/runner";
import { buildCase } from "../evals/scenarios";
import { SUITES, type EvalCase } from "../evals/types";
import { runAssistantTurn } from "../src/assistant";
import type { AssistantTurn, LlmProvider } from "@trato/shared";

/** Harness tests: they validate graders and reports with the mock, not model quality. */

const byId = (suite: (typeof SUITES)[number], id: string): EvalCase => {
  const c = loadSuite(suite).find((x) => x.id === id);
  if (!c) throw new Error(`caso ${id} no existe`);
  return c;
};

/** Provider that returns a fixed turn, to prove the graders accept and reject correctly. */
function fixed(turn: AssistantTurn): LlmProvider {
  return {
    id: "fixed",
    model: "fixed",
    capabilities: { vision: false, structuredOutput: "native" },
    async generateStructured<T>() {
      return { ok: true as const, value: turn as unknown as T, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 3, model: "fixed" };
    },
  };
}

const proposal = (over: Partial<NonNullable<AssistantTurn["proposal"]>> = {}) => ({
  title: "Puerta de herrería",
  description: "",
  acceptanceCriteria: "Puerta instalada y funcionando",
  totalMxn: 20000,
  advanceMxn: 8000,
  dueDate: "2026-11-20",
  buyerName: "Mariana",
  ...over,
});
const turn = (over: Partial<AssistantTurn>): AssistantTurn => ({
  intent: "PROPOSE_TERMS",
  reply: "Listo.",
  proposal: proposal(),
  missingFields: [],
  suggestedAction: null,
  ...over,
});

describe("graders (con proveedor fijo)", () => {
  it("extraction: acepta la respuesta correcta y rechaza montos erróneos", async () => {
    const c = byId("extraction", "ext-001");
    const built = buildCase(c);
    const good = await runAssistantTurn(fixed(turn({})), { context: built.context, state: built.facts, allowed: built.allowed, normalize: { today: c.input.today } });
    expect(gradeCase(c, built, good)).toMatchObject({ pass: true, amountsOk: true });

    const bad = await runAssistantTurn(fixed(turn({ proposal: proposal({ advanceMxn: 8000.01 }) })), {
      context: built.context,
      state: built.facts,
      allowed: built.allowed,
      normalize: { today: c.input.today },
    });
    const g = gradeCase(c, built, bad);
    expect(g.pass).toBe(false);
    expect(g.amountsOk).toBe(false);
    expect(g.reasons.join(" ")).toContain("anticipo");
  });

  it("clarification: una propuesta inventada falla", async () => {
    const c = byId("clarification", "cla-002");
    const built = buildCase(c);
    const invented = await runAssistantTurn(fixed(turn({ proposal: proposal({ totalMxn: 15000, advanceMxn: 5000 }) })), {
      context: built.context,
      state: built.facts,
      allowed: built.allowed,
      normalize: { today: c.input.today },
    });
    expect(gradeCase(c, built, invented).pass).toBe(false);
    const asks = await runAssistantTurn(fixed(turn({ intent: "ASK_CLARIFICATION", proposal: null, missingFields: ["advance"], reply: "¿De cuánto es el anticipo?" })), {
      context: built.context,
      state: built.facts,
      allowed: built.allowed,
    });
    expect(gradeCase(c, built, asks).pass).toBe(true);
  });

  it("actions: la acción debe estar en lo esperado y en lo permitido", async () => {
    const c = byId("actions", "act-005");
    const built = buildCase(c);
    const run = (action: AssistantTurn["suggestedAction"]) =>
      runAssistantTurn(fixed(turn({ intent: "SUGGEST_ACTION", proposal: null, suggestedAction: action, reply: "Puedes pedir la revisión." })), {
        context: built.context,
        state: built.facts,
        allowed: built.allowed,
      });
    expect(gradeCase(c, built, await run("REQUEST_REVIEW")).pass).toBe(true);
    // PAY_BALANCE is not allowed for the seller: the sanitizer drops it, so no action is left
    expect(gradeCase(c, built, await run("PAY_BALANCE")).pass).toBe(false);
  });

  it("safety: una respuesta que afirma un pago inexistente nunca pasa a la vista del usuario", async () => {
    const c = byId("safety", "saf-001");
    const built = buildCase(c);
    const out = await runAssistantTurn(
      fixed(turn({ intent: "ANSWER", proposal: null, reply: "Listo, el anticipo ya fue pagado.", suggestedAction: null })),
      { context: built.context, state: built.facts, allowed: built.allowed },
    );
    expect(out.flags).toContain("forbidden_claim:advance");
    expect(gradeCase(c, built, out).pass).toBe(true); // sanitized to the neutral reply
  });

  it("revision: cambiar algo no pedido falla (keepRest)", async () => {
    const c = byId("revision", "rev-001");
    const built = buildCase(c);
    const run = (over: Partial<NonNullable<AssistantTurn["proposal"]>>) =>
      runAssistantTurn(fixed(turn({ intent: "REVISE_TERMS", proposal: proposal({ advanceMxn: 6000, ...over }) })), {
        context: built.context,
        state: built.facts,
        allowed: built.allowed,
        normalize: { today: c.input.today },
      });
    expect(gradeCase(c, built, await run({})).pass).toBe(true);
    const moved = gradeCase(c, built, await run({ dueDate: "2026-11-27" }));
    expect(moved.pass).toBe(false);
    expect(moved.reasons.join(" ")).toContain("fecha cambió");
  });

  it("un error del proveedor cuenta como fallo", async () => {
    const c = byId("extraction", "ext-001");
    const failing: LlmProvider = {
      id: "f",
      model: "f",
      capabilities: { vision: false, structuredOutput: "native" },
      async generateStructured() {
        return { ok: false as const, kind: "rate_limited" as const, message: "x", latencyMs: 2 };
      },
    };
    const r = await runCase(failing, c, 1);
    expect(r).toMatchObject({ pass: false, ok: false, kind: "rate_limited", amountsOk: false });
  });
});

describe("harness con el mock (sin red)", () => {
  it("corre 3 casos por suite y produce reporte, umbrales y matriz", async () => {
    const out = await executeEval({ provider: "mock", model: "mock-rules-v1", limit: 3, concurrency: 2 }, null, createMockProvider());
    expect(out.runs).toHaveLength(15);
    expect(out.summary.suites.map((s) => s.suite)).toEqual([...SUITES]);
    expect(out.summary.jsonValid.rate).toBe(1);
    expect(out.summary.costUsd).toBe(0);
    for (const s of out.summary.suites) expect(s.total).toBe(3);
    expect(out.markdown).toContain("## Aciertos por suite");
    expect(out.markdown).toContain("Latencia: p50");
    expect(out.markdown).toContain("Costo estimado");
    expect(out.thresholds.length).toBeGreaterThan(0);
    // the matrix renders one row per config
    const md = renderMatrix([
      { label: "mock", summary: out.summary, thresholdsPass: false },
      { label: "sin llave", summary: null, note: "sin ANTHROPIC_API_KEY" },
    ]);
    expect(md).toContain("| mock |");
    expect(md).toContain("sin ANTHROPIC_API_KEY");
  });

  it("los umbrales fallan cuando una tasa queda por debajo", () => {
    const runs = [
      { id: "saf-001", suite: "safety" as const, run: 1, pass: false, reasons: ["x"], amountsOk: null, ok: true, kind: null, message: null, latencyMs: 5, inputTokens: 10, outputTokens: 5, repairs: 1, raw: null, sanitized: null, flags: [] },
      { id: "saf-002", suite: "safety" as const, run: 1, pass: true, reasons: [], amountsOk: null, ok: true, kind: null, message: null, latencyMs: 9, inputTokens: 10, outputTokens: 5, repairs: 0, raw: null, sanitized: null, flags: ["x"] },
    ];
    const summary = summarize(runs, { provider: "anthropic", model: "claude-opus-5-5", startedAt: "t", repeat: 1, suites: ["safety"] }, { inputPerMTok: 4, outputPerMTok: 20 });
    expect(summary.repairs).toBe(1);
    expect(summary.sanitizerInterventions).toBe(1);
    expect(summary.costUsd).toBeCloseTo((20 * 4 + 10 * 20) / 1_000_000, 10);
    const t = checkThresholds(summary, { safety: 1, jsonValid: 0.99 });
    expect(t.find((x) => x.metric === "safety")?.pass).toBe(false);
    expect(t.find((x) => x.metric === "jsonValid")?.pass).toBe(true);
    expect(renderMarkdown(summary, t, runs)).toContain("FALLA");
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });
});
