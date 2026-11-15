import { describe, expect, it } from "vitest";
import {
  ASSISTANT_SYSTEM_PROMPT,
  assistantFactsFromStatuses,
  buildAssistantContext,
  type AssistantTurn,
  type LlmProvider,
} from "@trato/shared";
import { createMockProvider, runAssistantTurn } from "../src";

const NOW = Date.parse("2026-11-14T18:00:00Z");
const facts = assistantFactsFromStatuses(null, null);

function ctx(text: string, speaker: "SELLER" | "BUYER" = "SELLER") {
  return buildAssistantContext({
    nowMs: NOW,
    speaker,
    agreement: null,
    openProposal: null,
    allowedActions: { seller: [], buyer: [] },
    messages: [{ authorType: speaker, text }],
  });
}

describe("runAssistantTurn", () => {
  it("corre el mock y sanea: devuelve crudo, saneado y flags", async () => {
    const out = await runAssistantTurn(createMockProvider(), {
      context: ctx("Puerta de herrería para Mariana, 20 mil, 8 mil de anticipo, el viernes"),
      state: facts,
      allowed: [],
      normalize: { today: "2026-11-14" },
    });
    expect(out.result.ok).toBe(true);
    expect(out.sanitized?.turn.intent).toBe("PROPOSE_TERMS");
    expect(out.sanitized?.normalized?.input.totalCents).toBe(2_000_000);
    expect(out.flags).toEqual([]);
    expect(out.repairs).toBe(0);
  });

  it("usa el prompt de sistema compartido y el schema AssistantTurn", async () => {
    let seen: { system: string; schemaName: string } | null = null;
    const spy: LlmProvider = {
      id: "spy",
      model: "spy",
      capabilities: { vision: false, structuredOutput: "native" },
      async generateStructured(req) {
        seen = { system: req.system, schemaName: req.schemaName };
        return { ok: false, kind: "timeout", message: "x", latencyMs: 1 };
      },
    };
    const out = await runAssistantTurn(spy, { context: ctx("hola"), state: facts, allowed: [] });
    expect(seen).toEqual({ system: ASSISTANT_SYSTEM_PROMPT, schemaName: "AssistantTurn" });
    expect(out.sanitized).toBeNull();
    expect(out.result.ok).toBe(false);
  });

  it("aplica sanitizeAssistantTurn a salidas peligrosas del modelo", async () => {
    const bad: AssistantTurn = {
      intent: "SUGGEST_ACTION",
      reply: "Listo, el anticipo ya fue pagado.",
      proposal: null,
      missingFields: [],
      suggestedAction: "PAY_BALANCE",
    };
    const stub: LlmProvider = {
      id: "stub",
      model: "stub",
      capabilities: { vision: false, structuredOutput: "native" },
      async generateStructured<T>() {
        return {
          ok: true as const,
          value: bad as unknown as T,
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
          model: "stub",
        };
      },
    };
    const out = await runAssistantTurn(stub, { context: ctx("hola", "BUYER"), state: facts, allowed: ["EXPORT"] });
    expect(out.flags).toContain("forbidden_claim:advance");
    expect(out.flags).toContain("action_dropped:PAY_BALANCE");
    expect(out.sanitized?.turn.suggestedAction).toBeNull();
  });
});
