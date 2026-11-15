import { env } from "cloudflare:workers";
import type { BuyerAgreementView, EvidenceView, SellerAgreementView, TaskView } from "@trato/shared";
import { call, login, share, tokenOf } from "./helpers";
import { pngBytes } from "./evidence-helpers";

export const cleaningInput = (over: Record<string, unknown> = {}) => ({
  serviceType: "CLEANING",
  title: "Limpieza de departamento",
  buyerName: "Mariana López",
  totalCents: 70_000,
  tasks: [{ title: "Limpiar baño" }, { title: "Limpiar cocina", description: "Estufa y barra." }, { title: "Trapear pisos" }, { title: "Limpiar ventanas" }],
  ...over,
});

export async function createCleaning(cookie: string, over: Record<string, unknown> = {}): Promise<SellerAgreementView> {
  const res = await call("/api/agreements", { method: "POST", cookie, json: cleaningInput(over) });
  if (res.status !== 201) throw new Error(`create cleaning failed ${res.status} ${await res.text()}`);
  return (await res.json()) as SellerAgreementView;
}

export async function sharedCleaning(sellerId = "seller_1", over: Record<string, unknown> = {}) {
  const cookie = await login(sellerId);
  const created = await createCleaning(cookie, over);
  const shared = await share(cookie, created.agreement.id);
  return { cookie, id: created.agreement.id, token: tokenOf(shared.shareUrl), created };
}

export const getBuyer = async (token: string): Promise<BuyerAgreementView> =>
  (await (await call(`/api/public/tratos/${token}`)).json()) as BuyerAgreementView;
export const getSeller = async (cookie: string, id: string): Promise<SellerAgreementView> =>
  (await (await call(`/api/agreements/${id}`, { cookie })).json()) as SellerAgreementView;

export async function acceptCleaning(token: string): Promise<BuyerAgreementView> {
  const v = await getBuyer(token);
  const res = await call(`/api/public/tratos/${token}/accept`, {
    method: "POST",
    json: { buyerName: "Mariana López", termsSha256: v.agreement.termsSha256, consent: true },
  });
  if (res.status !== 200) throw new Error(`accept failed ${res.status} ${await res.text()}`);
  return (await res.json()) as BuyerAgreementView;
}

export async function acceptedCleaning(sellerId = "seller_1", over: Record<string, unknown> = {}) {
  const s = await sharedCleaning(sellerId, over);
  const view = await acceptCleaning(s.token);
  return { ...s, view, tasks: view.tasks as TaskView[], balanceId: view.milestones.find((m) => m.kind === "BALANCE")!.id };
}

export function uploadTask(cookie: string, id: string, taskId: string, seed = 1, kind?: string): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([pngBytes(64, seed)], "foto.png", { type: "image/png" }));
  if (kind) fd.append("kind", kind);
  return call(`/api/agreements/${id}/tasks/${taskId}/evidence`, { method: "POST", cookie, body: fd });
}
export async function photo(cookie: string, id: string, taskId: string, seed = 1): Promise<EvidenceView> {
  const r = await uploadTask(cookie, id, taskId, seed);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${await r.text()}`);
  return (await r.json()) as EvidenceView;
}
export const submitTaskCall = (cookie: string, id: string, taskId: string): Promise<Response> =>
  call(`/api/agreements/${id}/tasks/${taskId}/submit`, { method: "POST", cookie, json: {} });
export const approveCall = (token: string, taskId: string, cookie?: string): Promise<Response> =>
  call(`/api/public/tratos/${token}/tasks/${taskId}/approve`, { method: "POST", json: {}, ...(cookie ? { cookie } : {}) });
export const adjustCall = (token: string, taskId: string, reason: string, cookie?: string): Promise<Response> =>
  call(`/api/public/tratos/${token}/tasks/${taskId}/request-adjustment`, { method: "POST", json: { reason }, ...(cookie ? { cookie } : {}) });

export async function submitAndApprove(c: { cookie: string; id: string; token: string }, taskId: string, seed = 1): Promise<void> {
  await photo(c.cookie, c.id, taskId, seed);
  const s = await submitTaskCall(c.cookie, c.id, taskId);
  if (s.status !== 200) throw new Error(`submit failed ${s.status} ${await s.text()}`);
  const a = await approveCall(c.token, taskId);
  if (a.status !== 200) throw new Error(`approve failed ${a.status} ${await a.text()}`);
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
}
