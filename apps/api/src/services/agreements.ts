import { and, eq, sql } from "drizzle-orm";
import {
  buildTermsSnapshot,
  canShare,
  canonicalJson,
  type CreateAgreementData,
  type SellerAgreementView,
  type ShareAgreementResponse,
  sha256Hex,
  splitTotal,
} from "@trato/shared";
import { rawStmt, stmt, type Db } from "../db/client";
import { agreements, buyerAccess, milestones } from "../db/schema";
import type { AppEnv } from "../env";
import { decryptText, encryptText, randomToken } from "../lib/crypto";
import { invalidState, notFound } from "../lib/errors";
import { findSeller, listBySeller, loadBundle, nextCounter, type AgreementBundle } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { buildSellerView, buyerLink, sellerSummary, whatsappLink } from "./views";

const guard = (agreementId: string, writeId: string) =>
  sql`EXISTS (SELECT 1 FROM agreements WHERE id = ${agreementId} AND write_id = ${writeId})`;

export const formatCode = (n: number): string => `TR-${String(n).padStart(4, "0")}`;

export async function listAgreements(db: Db, sellerId: string) {
  const rows = await listBySeller(db, sellerId);
  return { agreements: rows.map((r) => sellerSummary(r.agreement, r.balanceStatus)) };
}

/** Loads a bundle owned by `sellerId`; 404 (not 403) when it belongs to someone else. */
export async function loadOwned(db: Db, sellerId: string, agreementId: string): Promise<AgreementBundle> {
  const b = await loadBundle(db, agreementId);
  if (!b || b.agreement.sellerId !== sellerId) throw notFound("No encontramos este trato.");
  return b;
}

export async function getSellerView(db: Db, env: AppEnv, sellerId: string, agreementId: string, now: number) {
  return buildSellerView(env, await loadOwned(db, sellerId, agreementId), now);
}

export async function createAgreement(
  db: Db,
  env: AppEnv,
  sellerId: string,
  input: CreateAgreementData,
  now: number,
): Promise<SellerAgreementView> {
  const seller = await findSeller(db, sellerId);
  if (!seller) throw notFound("No encontramos al prestador.");
  // Amounts are always computed on the server.
  const split = splitTotal(input.totalCents, input.advanceCents);
  const code = formatCode(await nextCounter(db, "agreement_code"));
  const id = crypto.randomUUID();
  const createWriteId = crypto.randomUUID();

  // Sealed provisionally at creation: the view contract requires a hash, and there is no edit
  // endpoint, so the terms sealed at share time are identical (share re-seals while DRAFT).
  const snapshot = buildTermsSnapshot({
    code,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    buyerName: input.buyerName,
    dueDate: input.dueDate ?? null,
    totalCents: split.totalCents,
    advanceCents: split.advanceCents,
    sellerDisplayName: seller.seller.displayName,
    payeeAlias: seller.account.alias,
    payeeLast4: seller.account.clabeLast4,
  });
  const termsJson = canonicalJson(snapshot);
  const termsSha256 = await sha256Hex(termsJson);

  await batchWithSeqRetry(() =>
    env.DB.batch([
      stmt(env.DB, db.insert(agreements).values({
        id,
        code,
        sellerId,
        buyerName: snapshot.buyerName,
        buyerPhone: input.buyerPhone ?? null,
        title: snapshot.title,
        description: snapshot.description,
        acceptanceCriteria: snapshot.acceptanceCriteria,
        dueDate: snapshot.dueDate,
        totalCents: split.totalCents,
        termsJson,
        termsSha256,
        termsVersion: snapshot.termsVersion,
        status: "DRAFT",
        createdAt: now,
        updatedAt: now,
        version: 1,
        writeId: createWriteId,
      })),
      stmt(env.DB, db.insert(milestones).values([
        {
          id: crypto.randomUUID(),
          agreementId: id,
          kind: "ADVANCE",
          amountCents: split.advanceCents,
          description: "Anticipo",
          status: "PENDING_ACCEPTANCE",
        },
        {
          id: crypto.randomUUID(),
          agreementId: id,
          kind: "BALANCE",
          amountCents: split.balanceCents,
          description: "Saldo contra entrega",
          status: "WAITING_DELIVERY",
        },
      ])),
      ...appendEventStatements(env.DB, {
        agreementId: id,
        type: "AGREEMENT_CREATED",
        actorType: "SELLER",
        actorRef: sellerId,
        payload: { code, totalCents: split.totalCents, advanceCents: split.advanceCents, balanceCents: split.balanceCents },
        now,
        guardWriteId: createWriteId,
      }),
    ]),
  );
  return getSellerView(db, env, sellerId, id, now);
}

export async function shareAgreement(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  regenerate: boolean,
  now: number,
): Promise<ShareAgreementResponse> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const can = canShare(b.agreement);
    if (!can.ok) throw invalidState(can.message);

    const existing = b.activeAccess;
    const isDraft = b.agreement.status === "DRAFT";

    // Same link requested again: return it decrypted, no writes.
    if (existing && !regenerate && !isDraft) {
      const token = await decryptText(env.SESSION_SECRET, existing.tokenCiphertext);
      return respond(env, b, token, now);
    }

    const v = b.agreement.version;
    const writeId = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const tokenCiphertext = await encryptText(env.SESSION_SECRET, token);

    // Terms are sealed only while DRAFT; once SHARED/ACCEPTED they are immutable.
    let sealed: { termsJson: string; termsSha256: string } | null = null;
    if (isDraft) {
      const snapshot = buildTermsSnapshot({
        code: b.agreement.code,
        title: b.agreement.title,
        description: b.agreement.description,
        acceptanceCriteria: b.agreement.acceptanceCriteria,
        buyerName: b.agreement.buyerName,
        dueDate: b.agreement.dueDate,
        totalCents: b.agreement.totalCents,
        advanceCents: b.milestones.find((m) => m.kind === "ADVANCE")?.amountCents ?? 0,
        sellerDisplayName: b.seller.displayName,
        payeeAlias: b.account.alias,
        payeeLast4: b.account.clabeLast4,
        termsVersion: b.agreement.termsVersion,
      });
      const termsJson = canonicalJson(snapshot);
      sealed = { termsJson, termsSha256: await sha256Hex(termsJson) };
    }

    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        stmt(
          env.DB,
          db
            .update(agreements)
            .set({
              version: sql`${agreements.version} + 1`,
              writeId,
              updatedAt: now,
              ...(isDraft ? { status: "SHARED" as const, sharedAt: now, ...sealed } : {}),
            })
            .where(and(eq(agreements.id, agreementId), eq(agreements.version, v))),
        ),
        stmt(
          env.DB,
          db
            .update(buyerAccess)
            .set({ revokedAt: now })
            .where(and(eq(buyerAccess.agreementId, agreementId), sql`${buyerAccess.revokedAt} IS NULL`, guard(agreementId, writeId))),
        ),
        rawStmt(
          env.DB,
          `INSERT INTO buyer_access (id, agreement_id, token_hash, token_ciphertext, issued_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM agreements WHERE id = ? AND write_id = ?)`,
          crypto.randomUUID(),
          agreementId,
          tokenHash,
          tokenCiphertext,
          now,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: existing ? "LINK_REGENERATED" : "AGREEMENT_SHARED",
          actorType: "SELLER",
          actorRef: sellerId,
          payload: existing ? {} : { termsSha256: sealed?.termsSha256 ?? b.agreement.termsSha256 },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes !== 1) continue; // lost a race: reload and retry
    return respond(env, await loadOwned(db, sellerId, agreementId), token, now);
  }
  throw invalidState("El trato cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
}

async function respond(env: AppEnv, b: AgreementBundle, token: string, now: number): Promise<ShareAgreementResponse> {
  const shareUrl = buyerLink(env, token);
  return {
    shareUrl,
    whatsappUrl: whatsappLink(b.agreement, shareUrl),
    agreement: await buildSellerView(env, b, now, token),
  };
}

