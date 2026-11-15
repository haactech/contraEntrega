import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountsFileSchema, type AccountEntry, type AccountsDeps } from "./accounts";

const seedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "seed");
export const LOCAL_JSON = join(seedDir, "accounts.local.json");
export const LOCAL_SQL = join(seedDir, "accounts.local.sql");

export function loadEntries(): AccountEntry[] {
  let raw: string;
  try {
    raw = readFileSync(LOCAL_JSON, "utf8");
  } catch {
    throw new Error("No existe infra/seed/accounts.local.json (copia accounts.example.json y complétalo).");
  }
  const parsed = AccountsFileSchema.safeParse(JSON.parse(raw));
  // Never echo values: only the issue paths/messages (which contain no data).
  if (!parsed.success) {
    throw new Error(`accounts.local.json inválido: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function saveEntries(entries: AccountEntry[]): void {
  writeFileSync(LOCAL_JSON, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
}

export function buildDeps(): AccountsDeps {
  const apiKey = process.env["PEY_API_KEY"];
  if (!apiKey) throw new Error("Falta PEY_API_KEY en el entorno.");
  return {
    fetch,
    apiKey,
    baseUrl: process.env["PEY_BASE_URL"] ?? "https://api.pey.mx",
    persist: saveEntries,
    log: (l) => console.log(l),
  };
}
