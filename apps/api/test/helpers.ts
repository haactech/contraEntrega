import { env } from "cloudflare:workers";
import app from "../src/index";
import type { BuyerAgreementView, SellerAgreementView, CreateAgreementInput, ShareAgreementResponse } from "@trato/shared";

export const PIN = "4321";
let ipCounter = 0;

/** Each call gets a unique client IP so the shared rate-limit state never leaks between tests. */
export function call(path: string, init: RequestInit & { cookie?: string; json?: unknown; ip?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`);
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const req = new Request(`http://localhost:8787${path}`, { ...init, headers, body });
  return Promise.resolve(app.fetch(req, env));
}

export async function seedMock(): Promise<void> {
  const accounts = [1, 2, 3, 4, 5].map((n) =>
    env.DB.prepare(
      "INSERT OR REPLACE INTO demo_bank_accounts (id, alias, pey_bank_account_id, clabe_last4, codi_status, enabled, verified_at) VALUES (?, ?, ?, ?, 'ACTIVE', 1, 1)",
    ).bind(`demo_ba_${n}`, `Cuenta demo ${n}`, `mock_ba_${n}`, `000${n}`),
  );
  const names = ["Herrería Don Chuy", "Carpintería Lupita", "Plomería Ramírez", "Electricista Sofía", "Pintura Hermanos Ortega"];
  const sellers = names.map((name, i) =>
    env.DB.prepare("INSERT OR REPLACE INTO sellers (id, display_name, trade, demo_bank_account_id, created_at) VALUES (?, ?, 'Oficio', ?, 1)").bind(
      `seller_${i + 1}`,
      name,
      `demo_ba_${i + 1}`,
    ),
  );
  await env.DB.batch([...accounts, ...sellers]);
}

export async function login(sellerId = "seller_1"): Promise<string> {
  const res = await call("/api/session", { method: "POST", json: { sellerId, pin: PIN } });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] as string;
}

export const validInput: CreateAgreementInput = {
  title: "Portón de herrería",
  description: "Portón de 3 m con pintura.",
  acceptanceCriteria: "Instalado, pintado y funcionando.",
  buyerName: "Ana Pérez",
  buyerPhone: "5551234567",
  totalCents: 1_000_000,
  advanceCents: 400_000,
};

export async function createAgreement(cookie: string, input: CreateAgreementInput = validInput): Promise<SellerAgreementView> {
  const res = await call("/api/agreements", { method: "POST", cookie, json: input });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${await res.text()}`);
  return (await res.json()) as SellerAgreementView;
}

export async function share(cookie: string, id: string, regenerate = false): Promise<ShareAgreementResponse> {
  const res = await call(`/api/agreements/${id}/share`, { method: "POST", cookie, json: { regenerate } });
  if (res.status !== 200) throw new Error(`share failed ${res.status} ${await res.text()}`);
  return (await res.json()) as ShareAgreementResponse;
}

export const tokenOf = (shareUrl: string): string => shareUrl.split("/t/")[1] as string;

export async function publicView(token: string): Promise<Response> {
  return call(`/api/public/tratos/${token}`);
}

export async function newSharedAgreement(sellerId = "seller_1") {
  const cookie = await login(sellerId);
  const created = await createAgreement(cookie);
  const shared = await share(cookie, created.agreement.id);
  return { cookie, id: created.agreement.id, shared, token: tokenOf(shared.shareUrl), created };
}

export type { BuyerAgreementView };
