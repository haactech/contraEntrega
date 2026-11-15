import {
  ASSISTANT_SYSTEM_PROMPT,
  AssistantTurnSchema,
  sanitizeAssistantTurn,
  type AllowedAction,
  type AssistantContext,
  type AssistantStateFacts,
  type AssistantTurn,
  type LlmProvider,
  type LlmResult,
  type NormalizeContext,
  type SanitizeResult,
} from "@trato/shared";
import { repairsOf } from "./core";

export const ASSISTANT_SCHEMA_NAME = "AssistantTurn";

export interface RunAssistantTurnInput {
  /** From `buildAssistantContext`. */
  context: AssistantContext;
  /** What the server knows to be true (blocks unbacked payment claims). */
  state: AssistantStateFacts;
  /** Actions the current speaker may take (from `allowedActions`). */
  allowed: readonly AllowedAction[];
  normalize?: NormalizeContext;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface RunAssistantTurnOutput {
  /** Raw provider result, before sanitizing (useful to diagnose the model). */
  result: LlmResult<AssistantTurn>;
  /** What the user sees: null when the provider call failed. */
  sanitized: SanitizeResult | null;
  /** Machine-readable sanitizer reasons (never message content). */
  flags: string[];
  /** Repair retries the provider needed (0 or 1). */
  repairs: number;
}

/**
 * One assistant turn, exactly as the backend runs it: system prompt + context messages ->
 * `generateStructured(AssistantTurnSchema)` -> `sanitizeAssistantTurn`.
 */
export async function runAssistantTurn(
  provider: LlmProvider,
  input: RunAssistantTurnInput,
): Promise<RunAssistantTurnOutput> {
  const result = await provider.generateStructured({
    system: ASSISTANT_SYSTEM_PROMPT,
    messages: input.context.messages,
    schema: AssistantTurnSchema,
    schemaName: ASSISTANT_SCHEMA_NAME,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return { result, sanitized: null, flags: [], repairs: repairsOf(result) };
  const sanitized = sanitizeAssistantTurn(result.value, {
    allowed: input.allowed,
    state: input.state,
    ...(input.normalize ? { normalize: input.normalize } : {}),
  });
  return { result, sanitized, flags: sanitized.flags, repairs: repairsOf(result) };
}
