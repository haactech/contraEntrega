import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LLM_PROVIDER_IDS, type LlmProviderId } from "@trato/shared";
import { EVALS_DIR } from "./dataset";
import { renderMatrix, type Summary } from "./report";
import { RESULTS_DIR, executeEval, readJson, type EvalConfig } from "./runner";
import { SUITES, type Suite } from "./types";

interface MatrixEntry {
  label?: string;
  provider: LlmProviderId;
  model: string;
  effort?: string;
  baseUrl?: string;
  structured?: "native" | "prompted";
  /** Environment variable that holds this entry's API key (default by provider). */
  apiKeyEnv?: string;
  /** false = skipped (examples you have not set up). Default true. */
  enabled?: boolean;
}
interface MatrixFile {
  repeat?: number;
  concurrency?: number;
  suites?: Suite[];
  configs: MatrixEntry[];
}

const defaultKeyEnv = (p: LlmProviderId): string => (p === "anthropic" ? "ANTHROPIC_API_KEY" : "LLM_API_KEY");
const labelOf = (e: MatrixEntry): string => e.label ?? `${e.provider} ${e.model}${e.effort ? ` effort=${e.effort}` : ""}`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      yes: { type: "boolean", default: false },
      only: { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
  });
  const file = values.file ?? join(EVALS_DIR, "matrix.json");
  const matrix = readJson<MatrixFile>(file);
  const only = values.only?.split(",").map((s) => s.trim());
  const suites = matrix.suites ?? [...SUITES];
  const limit = values.limit ? Number(values.limit) : undefined;

  const rows: Array<{ label: string; summary: Summary | null; note?: string; thresholdsPass?: boolean }> = [];
  for (const entry of matrix.configs) {
    const label = labelOf(entry);
    if (!(LLM_PROVIDER_IDS as readonly string[]).includes(entry.provider)) {
      rows.push({ label, summary: null, note: "proveedor inválido" });
      continue;
    }
    if (entry.enabled === false || (only && !only.includes(entry.provider) && !only.includes(label))) {
      rows.push({ label, summary: null, note: "omitida (disabled/--only)" });
      continue;
    }
    const keyEnv = entry.apiKeyEnv ?? defaultKeyEnv(entry.provider);
    const apiKey = process.env[keyEnv] ?? (entry.provider === "anthropic" ? process.env["LLM_API_KEY"] : undefined);
    if (entry.provider === "anthropic" && !apiKey) {
      rows.push({ label, summary: null, note: `sin ${keyEnv}` });
      continue;
    }
    if (entry.provider !== "mock" && !values.yes) {
      rows.push({ label, summary: null, note: "proveedor real: requiere --yes (cuesta dinero)" });
      continue;
    }
    console.error(`== ${label}`);
    const cfg: EvalConfig = {
      provider: entry.provider,
      model: entry.model,
      effort: entry.effort,
      baseUrl: entry.baseUrl,
      structured: entry.structured,
      apiKey,
      suites,
      repeat: matrix.repeat,
      concurrency: matrix.concurrency,
      limit,
    };
    const o = await executeEval(cfg, RESULTS_DIR);
    rows.push({ label, summary: o.summary, thresholdsPass: o.thresholds.every((t) => t.pass) });
  }

  const md = renderMatrix(rows);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = join(RESULTS_DIR, `matrix-${stamp}.md`);
  writeFileSync(out, md);
  console.log(md);
  console.error(`Tabla: ${out}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
