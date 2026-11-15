import type { LlmProvider } from "@trato/shared";
import type { LlmFactoryConfig } from "./core";
import { createAnthropicProvider } from "./providers/anthropic";

/** Builds the provider named by `config.provider`. The Worker only ever sees `LlmProvider`. */
export function createLlmProvider(config: LlmFactoryConfig): LlmProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "openai-compatible":
    case "mock":
      throw new Error(`Proveedor LLM aún no implementado: ${config.provider}`);
  }
}
