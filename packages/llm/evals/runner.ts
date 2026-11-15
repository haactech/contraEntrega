import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmProvider, LlmProviderId } from "@trato/shared";
import { runAssistantTurn } from "../src/assistant";
import { createLlmProvider } from "../src/factory";
import { EVALS_DIR, loadSuite } from "./dataset";
import { gradeCase } from "./grading";
import {
  checkThresholds,
  lookupPricing,
  renderMarkdown,
  summarize,
  type PricingTable,
  type Summary,
  type ThresholdResult,
  type Thresholds,
} from "./report";
import { buildCase } from "./scenarios";
import { SUITES, type CaseRun, type EvalCase, type Suite } from "./types";

export interface EvalConfig {
  provider: LlmProviderId;
  model: string;
  baseUrl?: string | undefined;
  effort?: string | undefined;
  structured?: "native" | "prompted" | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  suites?: readonly Suite[] | undefined;
  /** Times each case is run (to measure variance). */
  repeat?: number | undefined;
  concurrency?: number | undefined;
  /** First N cases of each suite (quick smoke runs). */
  limit?: number | undefined;
  /** Receives one line per finished case. */
  onProgress?: ((done: number, total: number, run: CaseRun) => void) | undefined;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export const loadThresholds = (): Thresholds => readJson<Thresholds>(join(EVALS_DIR, "thresholds.json"));
export const loadPricing = (): PricingTable => readJson<PricingTable>(join(EVALS_DIR, "pricing.json"));

/** Provider construction shared by the CLI and the matrix. */
export function providerFromConfig(cfg: EvalConfig): LlmProvider {
  return createLlmProvider({
    provider: cfg.provider,
    model: cfg.model,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.effort ? { effort: cfg.effort } : {}),
    ...(cfg.structured ? { structured: cfg.structured } : {}),
    ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
  });
}

export function selectCases(suites: readonly Suite[], limit?: number): EvalCase[] {
  return suites.flatMap((s) => {
    const cases = loadSuite(s);
    return limit ? cases.slice(0, limit) : cases;
  });
}

/** Runs one case through `runAssistantTurn` (the real product path) and grades it. */
export async function runCase(provider: LlmProvider, c: EvalCase, run: number): Promise<CaseRun> {
  const built = buildCase(c);
  let out;
  try {
    out = await runAssistantTurn(provider, {
      context: built.context,
      state: built.facts,
      allowed: built.allowed,
      normalize: { defaultBuyerName: "Comprador", today: c.input.today },
    });
  } catch (e) {
    return {
      id: c.id,
      suite: c.suite,
      run,
      pass: false,
      reasons: [`excepción: ${e instanceof Error ? e.message : "desconocida"}`],
      amountsOk: null,
      ok: false,
      kind: "provider_error",
      message: null,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      repairs: 0,
      raw: null,
      sanitized: null,
      flags: [],
    };
  }
  const grade = gradeCase(c, built, out);
  const r = out.result;
  return {
    id: c.id,
    suite: c.suite,
    run,
    pass: grade.pass,
    reasons: grade.reasons,
    amountsOk: grade.amountsOk,
    ok: r.ok,
    kind: r.ok ? null : r.kind,
    message: r.ok ? null : r.message,
    latencyMs: r.latencyMs,
    inputTokens: r.ok ? r.usage.inputTokens : 0,
    outputTokens: r.ok ? r.usage.outputTokens : 0,
    repairs: out.repairs,
    raw: r.ok ? r.value : null,
    sanitized: out.sanitized ? out.sanitized.turn : null,
    flags: out.flags,
  };
}

async function pool<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return results;
}

export interface EvalOutcome {
  runs: CaseRun[];
  summary: Summary;
  thresholds: ThresholdResult[];
  markdown: string;
  jsonPath: string | null;
  mdPath: string | null;
}

const safeFile = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, "_");

/** Runs the selected suites and returns everything; writes result files when `outDir` is given. */
export async function executeEval(cfg: EvalConfig, outDir: string | null, provider?: LlmProvider): Promise<EvalOutcome> {
  const suites = cfg.suites && cfg.suites.length > 0 ? cfg.suites : SUITES;
  const repeat = Math.max(1, cfg.repeat ?? 1);
  const p = provider ?? providerFromConfig(cfg);
  const cases = selectCases(suites, cfg.limit);
  const tasks = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ c, run: i + 1 })));

  const startedAt = new Date();
  let done = 0;
  const runs = await pool(tasks, cfg.concurrency ?? 4, async (t) => {
    const r = await runCase(p, t.c, t.run);
    cfg.onProgress?.(++done, tasks.length, r);
    return r;
  });

  const pricing = lookupPricing(loadPricing(), cfg.provider, cfg.model);
  const summary = summarize(
    runs,
    { provider: cfg.provider, model: p.model, effort: cfg.effort, startedAt: startedAt.toISOString(), repeat, suites: [...suites] },
    pricing,
  );
  // Thresholds only apply to the suites that ran (a partial run is not an acceptance run).
  const thresholds = checkThresholds(summary, loadThresholds());
  const markdown = renderMarkdown(summary, thresholds, runs);

  let jsonPath: string | null = null;
  let mdPath: string | null = null;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const base = join(outDir, `${safeFile(cfg.provider)}-${safeFile(p.model)}-${stamp}`);
    jsonPath = `${base}.json`;
    mdPath = `${base}.md`;
    writeFileSync(jsonPath, JSON.stringify({ summary, thresholds, runs }, null, 2));
    writeFileSync(mdPath, markdown);
  }
  return { runs, summary, thresholds, markdown, jsonPath, mdPath };
}

export const RESULTS_DIR = join(EVALS_DIR, "results");
