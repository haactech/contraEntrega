import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type JsonSchema = Record<string, unknown>;

/**
 * Zod -> plain JSON Schema (draft-07 style, no `$ref`s, no `$schema` key), suitable for provider
 * structured-output modes and MCP `inputSchema`. Uses the *input* side of the schema so defaults
 * stay optional for callers.
 */
export function toJsonSchema(schema: ZodTypeAny, opts: { name?: string } = {}): JsonSchema {
  const raw = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
    effectStrategy: "input",
    pipeStrategy: "input",
  }) as JsonSchema;
  const { $schema: _omit, ...rest } = raw;
  return opts.name ? { title: opts.name, ...rest } : rest;
}
