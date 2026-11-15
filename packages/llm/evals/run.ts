import { parseArgs } from "node:util";
import { LLM_PROVIDER_IDS, type LlmProviderId } from "@trato/shared";
import { loadSuite } from "./dataset";
import { RESULTS_DIR, executeEval, type EvalConfig } from "./runner";
import { SUITES, type Suite } from "./types";

const USAGE = `Uso: pnpm --filter @trato/llm eval --provider anthropic|openai-compatible|mock [opciones]

  --model <id>          Modelo (anthropic: claude-opus-5-5 por defecto; mock: mock-rules-v1)
  --base-url <url>      Solo openai-compatible (ej. https://api.openai.com/v1)
  --structured <modo>   native|prompted (openai-compatible)
  --effort <nivel>      low|medium|high|xhigh|max (anthropic)
  --suite <lista>       extraction,clarification,revision,actions,safety (por defecto todas)
  --repeat <n>          Veces que corre cada caso (default 1)
  --concurrency <c>     Llamadas en paralelo (default 4)
  --limit <n>           Solo los primeros n casos de cada suite
  --timeout-ms <ms>     Timeout por llamada
  --no-fail             Reporta sin salir con código distinto de 0 si fallan los umbrales
  --yes                 Obligatorio para proveedores reales (cuestan dinero)

Llaves por variable de entorno: ANTHROPIC_API_KEY (anthropic) o LLM_API_KEY (los demás).
Resultados: packages/llm/evals/results/<proveedor>-<modelo>-<fecha>.json y .md (gitignored).`;

function fail(msg: string, code = 2): never {
  console.error(`Error: ${msg}\n`);
  console.error(USAGE);
  process.exit(code);
}

function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      structured: { type: "string" },
      effort: { type: "string" },
      suite: { type: "string" },
      repeat: { type: "string" },
      concurrency: { type: "string" },
      limit: { type: "string" },
      "timeout-ms": { type: "string" },
      "no-fail": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return Promise.resolve();
  }

  const provider = values.provider as LlmProviderId | undefined;
  if (!provider || !(LLM_PROVIDER_IDS as readonly string[]).includes(provider)) fail("--provider debe ser anthropic, openai-compatible o mock");
  const defaultModel = provider === "anthropic" ? "claude-opus-5-5" : provider === "mock" ? "mock-rules-v1" : undefined;
  const model = values.model ?? defaultModel;
  if (!model) fail("--model es obligatorio para openai-compatible");

  const suites = values.suite
    ? (values.suite.split(",").map((s) => s.trim()).filter(Boolean) as Suite[])
    : [...SUITES];
  for (const s of suites) if (!(SUITES as readonly string[]).includes(s)) fail(`suite desconocida: ${s}`);
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(`${name} debe ser un entero positivo`);
    return n;
  };
  const repeat = num(values.repeat, "--repeat") ?? 1;

  const apiKey = provider === "anthropic" ? process.env["ANTHROPIC_API_KEY"] ?? process.env["LLM_API_KEY"] : process.env["LLM_API_KEY"];
  const structured = values.structured as "native" | "prompted" | undefined;
  if (structured && structured !== "native" && structured !== "prompted") fail("--structured debe ser native o prompted");

  const cfg: EvalConfig = {
    provider,
    model: model as string,
    baseUrl: values["base-url"],
    effort: values.effort,
    structured,
    apiKey,
    timeoutMs: num(values["timeout-ms"], "--timeout-ms"),
    suites,
    repeat,
    concurrency: num(values.concurrency, "--concurrency"),
    limit: num(values.limit, "--limit"),
  };

  if (provider !== "mock") {
    if (!apiKey && provider === "anthropic") fail("falta ANTHROPIC_API_KEY (o LLM_API_KEY)");
    const calls = suites.reduce((n, s) => n + (cfg.limit ? Math.min(cfg.limit, loadSuite(s).length) : loadSuite(s).length), 0) * repeat;
    if (!values.yes) {
      fail(
        `esto hará aproximadamente ${calls} llamadas a un proveedor real (${provider}/${model}) y cuesta dinero. ` +
          "Si tienes aprobación para gastar, agrega --yes.",
      );
    }
    console.error(`Corriendo ~${calls} llamadas contra ${provider}/${model}...`);
  }

  const started = Date.now();
  return executeEval(
    {
      ...cfg,
      onProgress: (done, total, r) => {
        if (!r.pass || done === total || done % 20 === 0) {
          console.error(`[${done}/${total}] ${r.id}${r.run > 1 ? `#${r.run}` : ""} ${r.pass ? "ok" : `FALLA: ${r.reasons.join("; ")}`}`);
        }
      },
    },
    RESULTS_DIR,
  ).then((o) => {
    console.log(o.markdown);
    console.error(`Resultados: ${o.jsonPath}\nResumen:    ${o.mdPath}\nDuración:   ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const failing = o.thresholds.filter((t) => !t.pass);
    if (failing.length > 0 && !values["no-fail"]) {
      console.error(`Umbrales incumplidos: ${failing.map((t) => t.metric).join(", ")}`);
      process.exitCode = 1;
    }
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
