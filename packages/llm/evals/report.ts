import { SUITES, type CaseRun, type Suite } from "./types";

/** Aggregation, thresholds and Markdown rendering for eval runs. No I/O here. */

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}
export type PricingTable = Record<string, Pricing>;

export interface Thresholds {
  amounts?: number;
  extraction?: number;
  clarification?: number;
  revision?: number;
  actions?: number;
  safety?: number;
  jsonValid?: number;
}

export interface RunMeta {
  provider: string;
  model: string;
  effort?: string | undefined;
  startedAt: string;
  repeat: number;
  suites: Suite[];
}

export interface SuiteStat {
  suite: Suite;
  total: number;
  passed: number;
  rate: number;
}

export interface Summary {
  meta: RunMeta;
  runs: number;
  suites: SuiteStat[];
  amounts: { total: number; ok: number; rate: number | null };
  /** Share of calls that returned a valid structured output (infra errors excluded). */
  jsonValid: { valid: number; considered: number; rate: number | null };
  repairs: number;
  refusals: number;
  providerErrors: Record<string, number>;
  sanitizerInterventions: number;
  latency: { p50: number; p95: number };
  tokens: { input: number; output: number };
  costUsd: number | null;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

const INFRA_KINDS = new Set(["auth", "rate_limited", "timeout", "provider_error"]);

export function lookupPricing(table: PricingTable, provider: string, model: string): Pricing | null {
  return table[`${provider}:${model}`] ?? table[`${provider}:*`] ?? null;
}

export function summarize(runs: readonly CaseRun[], meta: RunMeta, pricing: Pricing | null): Summary {
  const suites: SuiteStat[] = SUITES.filter((s) => runs.some((r) => r.suite === s)).map((suite) => {
    const rs = runs.filter((r) => r.suite === suite);
    const passed = rs.filter((r) => r.pass).length;
    return { suite, total: rs.length, passed, rate: rs.length ? passed / rs.length : 0 };
  });
  const amountRuns = runs.filter((r) => r.amountsOk !== null);
  const amountsOk = amountRuns.filter((r) => r.amountsOk === true).length;

  const considered = runs.filter((r) => !(r.kind !== null && INFRA_KINDS.has(r.kind)));
  const valid = considered.filter((r) => r.ok).length;

  const providerErrors: Record<string, number> = {};
  for (const r of runs) if (r.kind) providerErrors[r.kind] = (providerErrors[r.kind] ?? 0) + 1;

  const tokens = {
    input: runs.reduce((n, r) => n + r.inputTokens, 0),
    output: runs.reduce((n, r) => n + r.outputTokens, 0),
  };
  const latencies = runs.map((r) => r.latencyMs);
  return {
    meta,
    runs: runs.length,
    suites,
    amounts: { total: amountRuns.length, ok: amountsOk, rate: amountRuns.length ? amountsOk / amountRuns.length : null },
    jsonValid: { valid, considered: considered.length, rate: considered.length ? valid / considered.length : null },
    repairs: runs.reduce((n, r) => n + r.repairs, 0),
    refusals: runs.filter((r) => r.kind === "refusal").length,
    providerErrors,
    sanitizerInterventions: runs.filter((r) => r.flags.length > 0).length,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    tokens,
    costUsd: pricing ? (tokens.input * pricing.inputPerMTok + tokens.output * pricing.outputPerMTok) / 1_000_000 : null,
  };
}

/* ------------------------------------------------------------- thresholds */

export interface ThresholdResult {
  metric: string;
  value: number | null;
  min: number;
  pass: boolean;
}

export function checkThresholds(s: Summary, t: Thresholds): ThresholdResult[] {
  const out: ThresholdResult[] = [];
  const add = (metric: string, value: number | null, min: number | undefined) => {
    if (min === undefined || value === null) return;
    out.push({ metric, value, min, pass: value >= min });
  };
  for (const st of s.suites) add(st.suite, st.rate, t[st.suite]);
  add("amounts", s.amounts.rate, t.amounts);
  add("jsonValid", s.jsonValid.rate, t.jsonValid);
  return out;
}

/* --------------------------------------------------------------- markdown */

const pct = (v: number | null): string => (v === null ? "n/d" : `${(v * 100).toFixed(1)}%`);
const ms = (v: number): string => `${Math.round(v)} ms`;
const usd = (v: number | null): string => (v === null ? "n/d (sin precio en pricing.json)" : `$${v.toFixed(4)}`);

export function renderMarkdown(s: Summary, thresholds: ThresholdResult[], runs: readonly CaseRun[], maxFailures = 25): string {
  const m = s.meta;
  const lines: string[] = [];
  lines.push(`# Evals Trato: ${m.provider} / ${m.model}${m.effort ? ` (effort ${m.effort})` : ""}`);
  lines.push("");
  lines.push(`- Fecha: ${m.startedAt}`);
  lines.push(`- Corridas: ${s.runs} (repeat ${m.repeat}; suites: ${m.suites.join(", ")})`);
  lines.push("");
  lines.push("## Aciertos por suite");
  lines.push("");
  lines.push("| Suite | Aciertos | Total | Tasa |");
  lines.push("|---|---:|---:|---:|");
  for (const st of s.suites) lines.push(`| ${st.suite} | ${st.passed} | ${st.total} | ${pct(st.rate)} |`);
  lines.push(`| montos exactos (casos con importes) | ${s.amounts.ok} | ${s.amounts.total} | ${pct(s.amounts.rate)} |`);
  lines.push("");
  lines.push("## Calidad operativa");
  lines.push("");
  lines.push(`- JSON válido: ${pct(s.jsonValid.rate)} (${s.jsonValid.valid}/${s.jsonValid.considered}; no cuenta errores de infraestructura)`);
  lines.push(`- Reparaciones usadas: ${s.repairs}`);
  lines.push(`- Rechazos (refusal): ${s.refusals}`);
  const errs = Object.entries(s.providerErrors);
  lines.push(`- Errores del proveedor: ${errs.length ? errs.map(([k, v]) => `${k}=${v}`).join(", ") : "ninguno"}`);
  lines.push(`- Corridas donde el saneador intervino: ${s.sanitizerInterventions}`);
  lines.push(`- Latencia: p50 ${ms(s.latency.p50)}, p95 ${ms(s.latency.p95)}`);
  lines.push(`- Tokens: ${s.tokens.input} entrada / ${s.tokens.output} salida`);
  lines.push(`- Costo estimado: ${usd(s.costUsd)}`);
  if (thresholds.length > 0) {
    lines.push("");
    lines.push("## Umbrales");
    lines.push("");
    lines.push("| Métrica | Valor | Mínimo | Resultado |");
    lines.push("|---|---:|---:|---|");
    for (const t of thresholds) lines.push(`| ${t.metric} | ${pct(t.value)} | ${pct(t.min)} | ${t.pass ? "PASA" : "FALLA"} |`);
  }
  const failed = runs.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push("");
    lines.push(`## Casos fallidos (${failed.length}${failed.length > maxFailures ? `, primeros ${maxFailures}` : ""})`);
    lines.push("");
    for (const r of failed.slice(0, maxFailures)) lines.push(`- ${r.id}${r.run > 1 ? ` (corrida ${r.run})` : ""}: ${r.reasons.join("; ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** One-row-per-config comparison for `eval:matrix`. */
export function renderMatrix(rows: Array<{ label: string; summary: Summary | null; note?: string; thresholdsPass?: boolean }>): string {
  const lines: string[] = [];
  lines.push("# Matriz de evals");
  lines.push("");
  lines.push("| Configuración | extraction | clarification | revision | actions | safety | montos | JSON | p50 | p95 | costo | umbrales |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of rows) {
    if (!r.summary) {
      lines.push(`| ${r.label} | ${r.note ?? "omitida"} |  |  |  |  |  |  |  |  |  |  |`);
      continue;
    }
    const s = r.summary;
    const rate = (suite: Suite) => pct(s.suites.find((x) => x.suite === suite)?.rate ?? null);
    lines.push(
      `| ${r.label} | ${rate("extraction")} | ${rate("clarification")} | ${rate("revision")} | ${rate("actions")} | ${rate("safety")} | ${pct(s.amounts.rate)} | ${pct(s.jsonValid.rate)} | ${ms(s.latency.p50)} | ${ms(s.latency.p95)} | ${s.costUsd === null ? "n/d" : `$${s.costUsd.toFixed(3)}`} | ${r.thresholdsPass === undefined ? "n/d" : r.thresholdsPass ? "PASA" : "FALLA"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
