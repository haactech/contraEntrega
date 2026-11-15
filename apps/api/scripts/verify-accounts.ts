import { writeFileSync } from "node:fs";
import { buildAccountsSql, verifyAccounts } from "./lib/accounts";
import { LOCAL_SQL, buildDeps, loadEntries } from "./lib/io";

try {

  const entries = loadEntries();
  const rows = await verifyAccounts(entries, buildDeps());
  // Refresh the SQL so codi_status reflects the latest state.
  writeFileSync(LOCAL_SQL, buildAccountsSql(entries, Date.now()), { mode: 0o600 });
  const notActive = rows.filter((r) => r.status !== "ACTIVE");
  console.log(`\n${rows.length - notActive.length}/${rows.length} cuentas ACTIVE.`);
  if (notActive.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : "desconocido"}`);
  process.exitCode = 1;
}
