import { writeFileSync } from "node:fs";
import { buildAccountsSql } from "./lib/accounts";
import { registerAccounts } from "./lib/accounts";
import { LOCAL_SQL, buildDeps, loadEntries } from "./lib/io";

try {

  const entries = loadEntries();
  const summary = await registerAccounts(entries, buildDeps());
  writeFileSync(LOCAL_SQL, buildAccountsSql(entries, Date.now()), { mode: 0o600 });
  console.log(
    `\nRegistradas: ${summary.registered} · Consultadas: ${summary.refreshed} · Fallidas: ${summary.failed}`,
  );
  console.log("SQL generado: infra/seed/accounts.local.sql -> pnpm --filter @trato/api db:seed:accounts:local");
  if (summary.failed > 0) process.exitCode = 1;
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : "desconocido"}`);
  process.exitCode = 1;
}
