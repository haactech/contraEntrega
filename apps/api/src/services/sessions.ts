import type { SellerSummary } from "@trato/shared";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import { timingSafeEqualStrings } from "../lib/crypto";
import { AppError, unauthorized } from "../lib/errors";
import { findSeller, listSellers } from "../repos/agreements";
import type { AccountRow, SellerRow } from "../repos/agreements";

export const toSellerSummary = (seller: SellerRow, account: AccountRow): SellerSummary => ({
  id: seller.id,
  displayName: seller.displayName,
  trade: seller.trade,
  account: { alias: account.alias, last4: account.clabeLast4 },
});

export async function listDemoSellers(db: Db): Promise<SellerSummary[]> {
  return (await listSellers(db)).map((r) => toSellerSummary(r.seller, r.account));
}

/** Validates profile + PIN. The same error is returned for unknown profile and wrong PIN. */
export async function authenticate(db: Db, env: AppEnv, sellerId: string, pin: string): Promise<SellerSummary> {
  const row = await findSeller(db, sellerId);
  const pinOk = await timingSafeEqualStrings(pin, env.DEMO_SELLER_PIN);
  if (!row || !pinOk) throw new AppError("UNAUTHORIZED", "PIN incorrecto.");
  return toSellerSummary(row.seller, row.account);
}

export async function currentSeller(db: Db, sellerId: string): Promise<SellerSummary> {
  const row = await findSeller(db, sellerId);
  if (!row) throw unauthorized();
  return toSellerSummary(row.seller, row.account);
}
