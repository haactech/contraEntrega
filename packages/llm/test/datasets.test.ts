import { describe, expect, it } from "vitest";
import { MIN_SUITE_SIZES, loadSuite } from "../evals/dataset";
import { buildCase } from "../evals/scenarios";
import { SUITES } from "../evals/types";

describe("datasets de evals", () => {
  for (const suite of SUITES) {
    const cases = loadSuite(suite);

    it(`${suite}: cumple el tamaño mínimo de la spec (>= ${MIN_SUITE_SIZES[suite]})`, () => {
      expect(cases.length).toBeGreaterThanOrEqual(MIN_SUITE_SIZES[suite]);
    });

    it(`${suite}: ids únicos y escenarios construibles`, () => {
      const ids = new Set(cases.map((c) => c.id));
      expect(ids.size).toBe(cases.length);
      for (const c of cases) {
        const built = buildCase(c);
        expect(built.context.messages.length).toBeGreaterThan(0);
        // every expected action must be either null or reachable in the scenario for that speaker
        // (non-allowed ones would be dropped by the sanitizer, so the case would be unwinnable)
        for (const a of c.expect.action ?? []) {
          if (a !== null && !(c.expect.action ?? []).includes(null)) expect(built.allowed).toContain(a);
        }
      }
    });
  }

  it("todas las fechas relativas parten del mismo «hoy» fijo", () => {
    const all = SUITES.flatMap((s) => loadSuite(s));
    expect(new Set(all.map((c) => c.input.today))).toEqual(new Set(["2026-11-14"]));
  });
});
