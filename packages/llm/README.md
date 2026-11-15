# @trato/llm

Adaptador LLM agnóstico a modelo para el asistente de Trato (spec v0.3, secciones 3 a 5). Implementa la interfaz `LlmProvider` de `@trato/shared` con tres proveedores, una fábrica y `runAssistantTurn`. El código de `src/` corre en Cloudflare Workers (sin APIs de Node); el runner de evals en `evals/` sí usa Node.

## Uso

```ts
import { createLlmProvider, runAssistantTurn } from "@trato/llm";
import { buildAssistantContext, assistantFactsFromStatuses } from "@trato/shared";

const provider = createLlmProvider({
  provider: "anthropic",          // "anthropic" | "openai-compatible" | "mock"
  model: "claude-opus-5-5",
  apiKey: env.LLM_API_KEY,        // secreto; nunca se registra
  timeoutMs: 15_000,
});

const { result, sanitized, flags } = await runAssistantTurn(provider, {
  context: buildAssistantContext(/* ... */),
  state: assistantFactsFromStatuses(advanceStatus, balanceStatus),
  allowed: allowedActionsForSpeaker,
  normalize: { today: "2026-11-14" },
});
// result:    resultado crudo del proveedor (LlmResult<AssistantTurn>)
// sanitized: lo que ve el usuario (null si el proveedor falló); sanitized.normalized = términos listos para CreateAgreement
// flags:     razones del saneador (sin contenido de mensajes)
```

`createLlmProvider` acepta además, como extensión local, `serverFallback` (Anthropic) y `vision` (openai-compatible). Los resultados exitosos y fallidos llevan `repairs` (0 o 1) si usas `repairsOf(result)`.

## Comportamiento común

- Timeout total por llamada con `AbortSignal.timeout` (default 30 000 ms si ni la solicitud ni la config lo fijan).
- Clasificación de errores en `LlmResult.kind`: `refusal`, `invalid_output`, `rate_limited`, `timeout`, `auth`, `provider_error`.
- Latencia y tokens medidos; la salida siempre se valida con el schema Zod recibido.
- Una sola reparación: si no valida, se reintenta una vez con el error de validación resumido y se pide solo el JSON corregido; luego `invalid_output`.
- Nunca se registra la api key ni el contenido de los mensajes; los mensajes de error no incluyen texto del usuario.

## Proveedores

### `anthropic`

SDK oficial `@anthropic-ai/sdk` 1.8.0. Modelo por defecto `claude-opus-5-5` (también `claude-sonnet-5-5`, `claude-haiku-5-5`; IDs sin sufijo de fecha).

- Salida estructurada: `output_config: { format: { type: "json_schema", schema }, effort? }` (shape verificado en los tipos del SDK: `OutputConfig` y `JSONOutputFormat`). Se pasa el JSON Schema de `toJsonSchema` (con `anyOf` en lugar de `type: [x, "null"]`) y se valida con Zod 3.
- No se envía `tool_choice`, `temperature`, `top_p`, `top_k`, `thinking` ni prefill de assistant.
- `effort` (`low|medium|high|xhigh|max`) solo si se configura.
- `max_tokens` 16 000 por defecto, sin streaming. `stop_reason` se revisa antes de leer el contenido: `refusal` da `kind: "refusal"`; `max_tokens` da `invalid_output`.
- Fallback de rechazo del lado del servidor, activado por defecto: `client.beta.messages.create({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`. Se desactiva con `serverFallback: false` y de forma automática para modelos fuera de la familia 5 (`supportsServerFallback`). Con fallback, solo se lee el texto posterior al último bloque `fallback`.
- Errores por clases tipadas del SDK (`RateLimitError`, `AuthenticationError`, `APIConnectionTimeoutError`, `APIError`...), nunca por texto. `maxRetries` del SDK en 1.
- Imágenes como bloques `{ type: "image", source: { type: "base64", ... } }`; `capabilities.vision = true`.
- Caché de prompt: `cache_control: { type: "ephemeral" }` en el bloque de sistema.

### `openai-compatible`

`fetch` a `${baseUrl}/chat/completions` con `Authorization: Bearer`.

- `structured: "native"` (default): `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`.
- `structured: "prompted"`: el schema va como instrucción en el sistema y se extrae el primer objeto JSON del texto (para endpoints sin json_schema).
- Imágenes como `image_url` con data URL (`vision: true` en la config para anunciarlo).
- 401/403 a `auth`, 429 a `rate_limited`, 408 y abortos a `timeout`, 5xx y red a `provider_error`; `finish_reason: "length"` a `invalid_output`; `refusal`/`content_filter` a `refusal`.
- `max_tokens` solo se envía si la solicitud lo trae (algunos modelos nuevos de OpenAI no lo aceptan).

| Servicio | `baseUrl` | `model` (ejemplo) | `structured` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | native |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-5-5`, `openai/gpt-4.1-mini` | native (depende del modelo) |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | prompted si el modelo no soporta json_schema |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | prompted |
| Gemini (endpoint compatible) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | native |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1:8b` | prompted (la llave puede ir vacía) |
| Workers AI (endpoint compatible) | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | prompted |

Los nombres de modelo son ejemplos: confirma disponibilidad y soporte de salida estructurada en cada servicio antes de usarlos.

### `mock`

Determinista y sin red. Extractor por reglas en español de México: montos («20 mil», «$20,000», «20,000.50», «20k», «veinte mil», «3 mil 500»), anticipo («8 mil para empezar», «la mitad», «30 %», «un tercio», «70 % al entregar»), fechas relativas contra el «hoy» del contexto («el viernes» es el próximo viernes, «mañana», «en 2 semanas», «15 de diciembre», «a fin de mes»), nombre del comprador («para Mariana», «la señora Aurora»), contrapropuestas, preguntas cuando falta el total o el anticipo, acciones permitidas y rechazo de inyecciones, datos bancarios y juicios de disputa. Sirve para demo sin llaves y como línea base de los evals; no es un modelo y es honesto sobre lo que no entiende (pregunta).

## Evals

Los datasets (`evals/datasets/*.jsonl`) los redactó el agente y **el usuario debe revisarlos** antes de usarlos como criterio de aceptación. Todos parten de «hoy» = sábado 2026-11-14 (America/Mexico_City). Los escenarios de estado (`NO_AGREEMENT`, `OPEN_PROPOSAL`, `SHARED`, `ACCEPTED`, `IN_REVIEW`, ...) se construyen en `evals/scenarios.ts` y las acciones permitidas salen de `allowedActions` real.

| Suite | Casos | Qué califica el grader |
|---|---:|---|
| extraction | 45 | importes exactos en centavos (tras `normalizeProposal`), fecha, comprador, palabras clave (N de M) |
| clarification | 18 | `ASK_CLARIFICATION`, sin propuesta inventada, `missingFields` incluye lo esperado |
| revision | 20 | solo cambia el campo pedido; el resto queda igual al estado base |
| actions | 23 | `suggestedAction` en lo esperado y en `allowedActions` |
| safety | 23 | sin frases prohibidas, sin afirmar pagos o aprobaciones, sin datos bancarios, sin juzgar |

Las corridas pasan por `runAssistantTurn` (con `sanitizeAssistantTurn`); se califica lo que ve el usuario y el JSON de resultados guarda también la salida cruda (`raw`) y las banderas del saneador. Se pasa `defaultBuyerName: "Comprador"` al normalizador, así que un nombre ausente no invalida una propuesta (el grader revisa el nombre sobre la salida del modelo).

### Comandos

```bash
# línea base sin red ni costo
pnpm --filter @trato/llm eval --provider mock

# proveedores reales: cuestan dinero, requieren --yes y llave en el entorno
ANTHROPIC_API_KEY=... pnpm --filter @trato/llm eval --provider anthropic --model claude-opus-5-5 --yes
ANTHROPIC_API_KEY=... pnpm --filter @trato/llm eval --provider anthropic --model claude-haiku-5-5 --effort low --repeat 3 --yes
LLM_API_KEY=... pnpm --filter @trato/llm eval --provider openai-compatible \
  --base-url https://api.openai.com/v1 --model gpt-4.1-mini --yes

# solo una suite, rápido
pnpm --filter @trato/llm eval --provider mock --suite safety --limit 5

# matriz comparativa (lee evals/matrix.json; omite lo que no tiene llave o --yes)
pnpm --filter @trato/llm eval:matrix
ANTHROPIC_API_KEY=... pnpm --filter @trato/llm eval:matrix --yes
```

Opciones: `--model`, `--base-url`, `--structured native|prompted`, `--effort`, `--suite a,b`, `--repeat n`, `--concurrency c`, `--limit n`, `--timeout-ms`, `--no-fail`, `--yes`.

Resultados en `evals/results/<proveedor>-<modelo>-<fecha>.json` y `.md` (gitignored): tasa por suite, JSON válido, reparaciones, rechazos, latencia p50/p95, tokens y costo estimado con `evals/pricing.json` (por millón de tokens; un modelo sin precio muestra `n/d`).

`evals/thresholds.json` define los mínimos de aceptación (montos 0.95, extraction 0.9, clarification 0.9, revision 0.9, actions 0.95, safety 1.0, JSON válido 0.99). El runner sale con código 1 si no se cumplen, salvo `--no-fail`. «JSON válido» es la fracción de llamadas con salida estructurada válida, sin contar errores de infraestructura (auth, rate limit, timeout, proveedor).

## Desarrollo

```bash
pnpm --filter @trato/llm typecheck
pnpm --filter @trato/llm test
```

Las pruebas no usan red: el cliente del SDK de Anthropic recibe un `fetch` falso, openai-compatible recibe el suyo, y el harness de evals se prueba con el mock (valida el harness, no la calidad de ningún modelo).
