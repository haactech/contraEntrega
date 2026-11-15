/**
 * Pure logic for the local account scripts (no filesystem access, fetch is injected).
 * The full CLABE never leaves the machine except in the POST /bank-account body to pey,
 * and is never printed: logs only use alias + last4.
 */
import {
  PeyBankAccountSchema,
  PeyRegisterBankAccountRequestSchema,
  PeyRegisterBankAccountResponseSchema,
  PeyErrorResponseSchema,
  type PeyCodiStatus,
} from "@trato/shared";
import { z } from "zod";

export const AccountEntrySchema = z.object({
  alias: z.string().min(1),
  name: z.string().min(1),
  clabe: z.string().regex(/^\d{18}$/, "La CLABE debe tener 18 dígitos."),
  entity: z.enum(["BUSINESS", "PERSON"]),
  sellerDisplayName: z.string().min(1),
  trade: z.string().min(1),
  peyBankAccountId: z.string().nullable(),
  codiStatus: z.enum(["PENDING", "PROCESSING", "ACTIVE", "ERROR"]).optional(),
});
export type AccountEntry = z.infer<typeof AccountEntrySchema>;
export const AccountsFileSchema = z.array(AccountEntrySchema).min(1);

export interface AccountsDeps {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  /** Called right after every state change so the id is never lost. */
  persist: (entries: AccountEntry[]) => void;
  log: (line: string) => void;
}

export function last4(clabe: string): string {
  return clabe.slice(-4);
}

/** Mexican CLABE check digit (weights 3,7,1). */
export function isValidClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += ((Number(clabe[i]) * (weights[i % 3] as number)) % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

const tag = (e: AccountEntry): string => `${e.alias} (••••${last4(e.clabe)})`;

async function peyRequest(
  deps: AccountsDeps,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  const reqInit: RequestInit = { method: init.method, headers, signal: AbortSignal.timeout(10_000) };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await deps.fetch(`${deps.baseUrl.replace(/\/$/, "")}${path}`, reqInit);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function peyErrorMessage(json: unknown): string {
  const p = PeyErrorResponseSchema.safeParse(json);
  return p.success ? `${p.data.error.type ?? "error"}: ${p.data.error.message}` : "respuesta inesperada";
}

export interface RegisterSummary {
  registered: number;
  refreshed: number;
  failed: number;
}

/** Idempotent: entries that already have an id are only queried, never re-registered. */
export async function registerAccounts(entries: AccountEntry[], deps: AccountsDeps): Promise<RegisterSummary> {
  const summary: RegisterSummary = { registered: 0, refreshed: 0, failed: 0 };
  for (const entry of entries) {
    try {
      if (entry.peyBankAccountId) {
        const { status, json } = await peyRequest(deps, `/bank-account/${encodeURIComponent(entry.peyBankAccountId)}`, { method: "GET" });
        const parsed = PeyBankAccountSchema.safeParse(json);
        if (status !== 200 || !parsed.success) throw new Error(`GET falló (${status}): ${peyErrorMessage(json)}`);
        entry.codiStatus = parsed.data.codiStatus;
        deps.persist(entries);
        summary.refreshed++;
        deps.log(`= ${tag(entry)} ya registrada -> ${parsed.data.codiStatus}`);
        continue;
      }
      if (!isValidClabe(entry.clabe)) throw new Error("CLABE inválida (dígito verificador).");
      const body = PeyRegisterBankAccountRequestSchema.parse({
        alias: entry.alias,
        name: entry.name,
        clabe: entry.clabe,
        entity: entry.entity,
      });
      const { status, json } = await peyRequest(deps, "/bank-account", { method: "POST", body });
      const parsed = PeyRegisterBankAccountResponseSchema.safeParse(json);
      if (status !== 200 || !parsed.success) throw new Error(`POST falló (${status}): ${peyErrorMessage(json)}`);
      // Persist immediately so a re-run never registers the same account twice.
      entry.peyBankAccountId = parsed.data.id;
      entry.codiStatus = parsed.data.codiStatus;
      deps.persist(entries);
      summary.registered++;
      deps.log(`+ ${tag(entry)} registrada -> ${parsed.data.codiStatus}`);
    } catch (err) {
      summary.failed++;
      deps.log(`! ${tag(entry)} ${err instanceof Error ? err.message : "error desconocido"}`);
    }
  }
  return summary;
}

export interface VerifyRow {
  alias: string;
  last4: string;
  status: PeyCodiStatus | "SIN_ID" | "ERROR_CONSULTA";
  detail?: string;
}

export async function verifyAccounts(entries: AccountEntry[], deps: AccountsDeps): Promise<VerifyRow[]> {
  const rows: VerifyRow[] = [];
  for (const entry of entries) {
    const base = { alias: entry.alias, last4: last4(entry.clabe) };
    if (!entry.peyBankAccountId) {
      rows.push({ ...base, status: "SIN_ID" });
    } else {
      try {
        const { status, json } = await peyRequest(deps, `/bank-account/${encodeURIComponent(entry.peyBankAccountId)}`, { method: "GET" });
        const parsed = PeyBankAccountSchema.safeParse(json);
        if (status !== 200 || !parsed.success) throw new Error(`GET falló (${status}): ${peyErrorMessage(json)}`);
        entry.codiStatus = parsed.data.codiStatus;
        rows.push({
          ...base,
          status: parsed.data.codiStatus,
          ...(parsed.data.errorMessage ? { detail: parsed.data.errorMessage } : {}),
        });
      } catch (err) {
        rows.push({ ...base, status: "ERROR_CONSULTA", detail: err instanceof Error ? err.message : "error" });
      }
    }
    const row = rows[rows.length - 1] as VerifyRow;
    deps.log(`${row.alias} (••••${row.last4}): ${row.status}${row.detail ? ` - ${row.detail}` : ""}`);
  }
  deps.persist(entries);
  return rows;
}

const sqlStr = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/**
 * Upserts demo_bank_accounts + sellers using the same ids as infra/seed/mock.sql
 * (demo_ba_N / seller_N), so real accounts replace the mock ones in place.
 */
export function buildAccountsSql(entries: AccountEntry[], nowMs: number): string {
  const lines: string[] = [
    "-- Generado por register-accounts. NO versionar. Contiene ids de pey y los últimos 4 de la CLABE.",
  ];
  entries.forEach((e, i) => {
    if (!e.peyBankAccountId) return;
    const n = i + 1;
    const status = e.codiStatus ?? "PENDING";
    const verified = status === "ACTIVE" ? String(nowMs) : "NULL";
    lines.push(
      `INSERT INTO demo_bank_accounts (id, alias, pey_bank_account_id, clabe_last4, codi_status, enabled, verified_at) VALUES (${sqlStr(`demo_ba_${n}`)}, ${sqlStr(e.alias)}, ${sqlStr(e.peyBankAccountId)}, ${sqlStr(last4(e.clabe))}, ${sqlStr(status)}, 1, ${verified}) ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, pey_bank_account_id = excluded.pey_bank_account_id, clabe_last4 = excluded.clabe_last4, codi_status = excluded.codi_status, enabled = 1, verified_at = excluded.verified_at;`,
      `INSERT INTO sellers (id, display_name, trade, demo_bank_account_id, created_at) VALUES (${sqlStr(`seller_${n}`)}, ${sqlStr(e.sellerDisplayName)}, ${sqlStr(e.trade)}, ${sqlStr(`demo_ba_${n}`)}, ${nowMs}) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, trade = excluded.trade, demo_bank_account_id = excluded.demo_bank_account_id;`,
    );
  });
  return `${lines.join("\n")}\n`;
}
