import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

execFileSync("node", [path.join(__dirname, "scripts/ensure-assets.mjs")]);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123",
            DEMO_SELLER_PIN: "4321",
            PEY_API_KEY: "pey_test",
            PEY_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQtcmVwbGFjZS1tZS0zMi1ieXRlcyE=",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
