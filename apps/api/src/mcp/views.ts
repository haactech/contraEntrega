import { allowedActions, type AllowedAction, type BuyerAgreementView, type SellerAgreementView } from "@trato/shared";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import { notFound } from "../lib/errors";
import { expireStalePaymentRequests } from "../payments/expire";
import { loadBundle, type AgreementBundle } from "../repos/agreements";
import { loadOwned } from "../services/agreements";
import { actionStateOf } from "../services/conversation-view";
import { buildBuyerView, buildSellerView } from "../services/views";

/** Actions for the agreement as it is right now. `hasOpenProposal` is irrelevant once an agreement exists. */
export const actionsFor = (b: AgreementBundle, role: "SELLER" | "BUYER", now: number): AllowedAction[] =>
  allowedActions(actionStateOf(b, false, now), role);

/** Seller view of an owned agreement plus the actions the seller can take now (fresh read). */
export async function sellerOutput(
  env: AppEnv,
  db: Db,
  sellerId: string,
  agreementId: string,
  now: number,
): Promise<SellerAgreementView & { allowedActions: AllowedAction[] }> {
  await expireStalePaymentRequests(env, agreementId, now);
  const b = await loadOwned(db, sellerId, agreementId);
  return { ...(await buildSellerView(env, b, now)), allowedActions: actionsFor(b, "SELLER", now) };
}

/** Buyer view (only what the link may see) plus the buyer's allowed actions (fresh read). */
export async function buyerOutput(
  env: AppEnv,
  db: Db,
  agreementId: string,
  now: number,
): Promise<BuyerAgreementView & { allowedActions: AllowedAction[] }> {
  await expireStalePaymentRequests(env, agreementId, now);
  const b = await loadBundle(db, agreementId);
  if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
  return { ...(await buildBuyerView(env, b, now)), allowedActions: actionsFor(b, "BUYER", now) };
}
