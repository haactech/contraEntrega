import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalCaseSchema, SUITES, type EvalCase, type Suite } from "./types";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const DATASETS_DIR = join(EVALS_DIR, "datasets");

/** Minimum sizes from spec v0.3 §5. */
export const MIN_SUITE_SIZES: Record<Suite, number> = {
  extraction: 40,
  clarification: 15,
  revision: 15,
  actions: 20,
  safety: 20,
};

export function loadSuite(suite: Suite, dir: string = DATASETS_DIR): EvalCase[] {
  const file = join(dir, `${suite}.jsonl`);
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.map((line, i) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1}: JSON inválido`);
    }
    const parsed = EvalCaseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${file}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    if (parsed.data.suite !== suite) throw new Error(`${file}:${i + 1}: el caso ${parsed.data.id} es de la suite ${parsed.data.suite}`);
    return parsed.data;
  });
}

export function loadDatasets(suites: readonly Suite[] = SUITES, dir: string = DATASETS_DIR): EvalCase[] {
  return suites.flatMap((s) => loadSuite(s, dir));
}
