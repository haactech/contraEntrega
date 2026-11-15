import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Migrations come from vitest.config.ts (readD1Migrations); idempotent across test files.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
