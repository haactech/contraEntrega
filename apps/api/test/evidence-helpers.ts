import { env } from "cloudflare:workers";
import type { BuyerAgreementView, EvidenceView, PaymentRequestView, SellerAgreementView } from "@trato/shared";
import { call } from "./helpers";
import { acceptedAgreement, createPr } from "./payments-helpers";

export function pngBytes(extra = 32, seed = 1): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(head.length + extra);
  out.set(head);
  for (let i = head.length; i < out.length; i++) out[i] = (i * seed) % 251;
  return out;
}

export function upload(cookie: string, id: string, bytes: Uint8Array, opts: { type?: string; name?: string } = {}): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([bytes], opts.name ?? "foto.png", { type: opts.type ?? "image/png" }));
  return call(`/api/agreements/${id}/evidence`, { method: "POST", cookie, body: fd });
}

export const sellerView = async (cookie: string, id: string): Promise<SellerAgreementView> =>
  (await (await call(`/api/agreements/${id}`, { cookie })).json()) as SellerAgreementView;

export const buyerView = async (token: string): Promise<BuyerAgreementView> =>
  (await (await call(`/api/public/tratos/${token}`)).json()) as BuyerAgreementView;

export const simulate = (paymentRequestId: string): Promise<Response> =>
  call("/api/dev/simulate-payment", { method: "POST", json: { paymentRequestId } });

/** Accepted agreement with the advance paid through the real mock pipeline (use with the real MockPeyGateway). */
export async function paidAdvance(sellerId = "seller_1") {
  const a = await acceptedAgreement(sellerId);
  const pr = (await (await createPr(a.token, a.advanceId)).json()) as PaymentRequestView;
  const sim = await simulate(pr.id);
  if (sim.status !== 200) throw new Error(`simulate failed ${sim.status}`);
  return { ...a, advancePr: pr };
}

export async function addPhoto(cookie: string, id: string, seed = 1): Promise<EvidenceView> {
  const res = await upload(cookie, id, pngBytes(64, seed));
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${await res.text()}`);
  return (await res.json()) as EvidenceView;
}

export const requestReviewCall = (cookie: string, id: string, note?: string): Promise<Response> =>
  call(`/api/agreements/${id}/request-review`, { method: "POST", cookie, json: note ? { note } : {} });

export const reviewCall = (token: string, json: unknown, cookie?: string): Promise<Response> =>
  call(`/api/public/tratos/${token}/review`, { method: "POST", json, ...(cookie ? { cookie } : {}) });

export const r2Exists = async (key: string): Promise<boolean> => (await env.EVIDENCE.head(key)) !== null;
