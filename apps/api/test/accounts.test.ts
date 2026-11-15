import { describe, expect, it } from "vitest";
import {
  buildAccountsSql,
  isValidClabe,
  registerAccounts,
  verifyAccounts,
  type AccountEntry,
  type AccountsDeps,
} from "../scripts/lib/accounts";

const CLABE_A = "012180001234567893"; // checksum computed below in test
function withCheck(prefix17: string): string {
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(prefix17[i]) * (w[i % 3] as number)) % 10;
  return `${prefix17}${(10 - (sum % 10)) % 10}`;
}

const entries = (): AccountEntry[] => [
  { alias: "Cuenta demo 1", name: "Uno", clabe: withCheck("01218000123456789"), entity: "PERSON", sellerDisplayName: "Herrería Don Chuy", trade: "Herrería", peyBankAccountId: null },
  { alias: "Cuenta demo 2", name: "Dos", clabe: withCheck("01218000987654321"), entity: "PERSON", sellerDisplayName: "Carpintería Lupita", trade: "Carpintería", peyBankAccountId: null },
];

function deps(handler: (url: string, init: RequestInit) => Response) {
  const logs: string[] = [];
  const saved: string[] = [];
  const calls: string[] = [];
  const d: AccountsDeps = {
    apiKey: "k",
    baseUrl: "https://pey.test",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return handler(url, init);
    }) as unknown as typeof fetch,
    persist: (e) => saved.push(JSON.stringify(e)),
    log: (l) => logs.push(l),
  };
  return { d, logs, saved, calls };
}

describe("clabe", () => {
  it("valida el dígito verificador", () => {
    expect(isValidClabe(withCheck("01218000123456789"))).toBe(true);
    expect(isValidClabe("012180001234567890".replace(/.$/, "9"))).toBe(isValidClabe("012180001234567899"));
    expect(isValidClabe(CLABE_A.slice(0, 17))).toBe(false);
    expect(isValidClabe("000000000000000000")).toBe(true);
  });
});

describe("register-accounts", () => {
  it("registra, persiste el id de inmediato, es idempotente y nunca imprime la CLABE", async () => {
    const list = entries();
    let n = 0;
    const { d, logs, saved, calls } = deps((_url, init) =>
      init.method === "POST"
        ? Response.json({ id: `ba_${++n}`, codiStatus: "PENDING" })
        : Response.json({ id: "ba_1", codiStatus: "ACTIVE" }),
    );
    const s1 = await registerAccounts(list, d);
    expect(s1).toEqual({ registered: 2, refreshed: 0, failed: 0 });
    expect(list.map((e) => e.peyBankAccountId)).toEqual(["ba_1", "ba_2"]);
    expect(saved).toHaveLength(2); // un guardado por cuenta, antes de la siguiente llamada
    const s2 = await registerAccounts(list, d);
    expect(s2).toEqual({ registered: 0, refreshed: 2, failed: 0 });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(2); // sin registros duplicados
    const all = logs.join("\n");
    for (const e of list) expect(all).not.toContain(e.clabe);
    expect(all).toContain("••••");
  });

  it("error 400 de pey no guarda id y reporta sin CLABE", async () => {
    const list = entries();
    const { d, logs } = deps(() => Response.json({ error: { message: "bad", type: "INVALID_CLABE" } }, { status: 400 }));
    const s = await registerAccounts(list, d);
    expect(s.failed).toBe(2);
    expect(list[0]?.peyBankAccountId).toBeNull();
    expect(logs.join("\n")).toContain("INVALID_CLABE");
    expect(logs.join("\n")).not.toContain(list[0]?.clabe as string);
  });

  it("CLABE con dígito verificador inválido no llega a pey", async () => {
    const list = entries();
    list[0] = { ...(list[0] as AccountEntry), clabe: "012180001234567891".replace(/.$/, String((Number(list[0]?.clabe.at(-1)) + 1) % 10)) };
    const { d, calls } = deps(() => Response.json({ id: "x", codiStatus: "PENDING" }));
    const s = await registerAccounts(list, d);
    expect(s.failed).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("verify-accounts y SQL", () => {
  it("reporta estados y genera SQL con ids compatibles con el seed mock", async () => {
    const list = entries();
    list[0]!.peyBankAccountId = "ba_1";
    const { d, logs } = deps(() => Response.json({ id: "ba_1", codiStatus: "ACTIVE" }));
    const rows = await verifyAccounts(list, d);
    expect(rows.map((r) => r.status)).toEqual(["ACTIVE", "SIN_ID"]);
    expect(logs.join("\n")).not.toContain(list[0]?.clabe as string);
    const sql = buildAccountsSql(list, 1000);
    expect(sql).toContain("'demo_ba_1'");
    expect(sql).toContain("'seller_1'");
    expect(sql).toContain("Herrería Don Chuy");
    expect(sql).toContain("'ba_1'");
    expect(sql).not.toContain("demo_ba_2"); // sin id de pey, no se genera
    expect(sql).not.toContain(list[0]?.clabe as string);
  });
});
