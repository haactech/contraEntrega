import { and, eq, sql } from "drizzle-orm";
import {
  type ActionVia,
  buildCleaningAcceptanceCriteria,
  buildTermsSnapshot,
  canShare,
  canonicalJson,
  type CreateAnyAgreementData,
  type CreateCleaningAgreementData,
  type SellerAgreementView,
  type ShareAgreementResponse,
  sha256Hex,
  splitTotal,
} from "@trato/shared";
import { rawStmt, stmt, type Db } from "../db/client";
import { GUARD_SQL, claimStmt } from "../payments/common";
import { agreementTasks, agreements, buyerAccess, milestones } from "../db/schema";
import type { AppEnv } from "../env";
import { decryptText, encryptText, randomToken } from "../lib/crypto";
import { expireStalePaymentRequests } from "../payments/expire";
import { invalidState, notFound } from "../lib/errors";
import { findSeller, listBySeller, loadBundle, nextCounter, type AgreementBundle } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { buildSellerView, buyerLink, sellerSummary, whatsappLink } from "./views";

const guard = (agreementId: string, writeId: string) =>
  sql`EXISTS (SELECT 1 FROM agreements WHERE id = ${agreementId} AND write_id = ${writeId})`;

export const formatCode = (n: number): string => `TR-${String(n).padStart(4, "0")}`;

export async function listAgreements(db: Db, sellerId: string) {
  // Pre-v0.3 agreements get their room lazily (idempotent).
  await db.run(sql`INSERT OR IGNORE INTO conversations (id, seller_id, agreement_id, created_at, updated_at, version)
    SELECT lower(hex(randomblob(16))), a.seller_id, a.id, a.created_at, a.updated_at, 1
    FROM agreements a WHERE a.seller_id = ${sellerId} AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.agreement_id = a.id)`);
  const rows = await listBySeller(db, sellerId);
  return { agreements: rows.map((r) => sellerSummary(r.agreement, r.balanceStatus, r.conversationId, r.tasks)) };
}

/** Loads a bundle owned by `sellerId`; 404 (not 403) when it belongs to someone else. */
export async function loadOwned(db: Db, sellerId: string, agreementId: string): Promise<AgreementBundle> {
  const b = await loadBundle(db, agreementId);
  if (!b || b.agreement.sellerId !== sellerId) throw notFound("No encontramos este trato.");
  return b;
}

export async function getSellerView(db: Db, env: AppEnv, sellerId: string, agreementId: string, now: number) {
  await expireStalePaymentRequests(env, agreementId, now);
  return buildSellerView(env, await loadOwned(db, sellerId, agreementId), now);
}

export const isCleaningInput = (i: CreateAnyAgreementData): i is CreateCleaningAgreementData =>
  "serviceType" in i && i.serviceType === "CLEANING";

/** Terms fields shared by every creation/revision path; CLEANING derives the criteria from the checklist. */
function normalizedTerms(input: CreateAnyAgreementData) {
  if (isCleaningInput(input)) {
    return {
      cleaning: true as const,
      acceptanceCriteria: buildCleaningAcceptanceCriteria(input.tasks),
      split: { totalCents: input.totalCents, advanceCents: 0, balanceCents: input.totalCents },
      tasks: input.tasks.map((t, position) => ({ position, title: t.title, description: t.description?.trim() ? t.description.trim() : null })),
    };
  }
  return {
    cleaning: false as const,
    acceptanceCriteria: input.acceptanceCriteria,
    split: splitTotal(input.totalCents, input.advanceCents),
    tasks: [] as { position: number; title: string; description: string | null }[],
  };
}

/** Creates a GENERIC or CLEANING agreement (same function for the form, the API, MCP and the chat). */
export async function createAgreement(
  db: Db,
  env: AppEnv,
  sellerId: string,
  input: CreateAnyAgreementData,
  now: number,
  opts: { conversationId?: string | undefined; via?: ActionVia | undefined; actorRef?: string | undefined } = {},
): Promise<SellerAgreementView> {
  const seller = await findSeller(db, sellerId);
  if (!seller) throw notFound("No encontramos al prestador.");
  // Amounts are always computed on the server.
  const norm = normalizedTerms(input);
  const split = norm.split;
  const code = formatCode(await nextCounter(db, "agreement_code"));
  const id = crypto.randomUUID();
  const createWriteId = crypto.randomUUID();

  // Sealed provisionally at creation: the view contract requires a hash, and there is no edit
  // endpoint, so the terms sealed at share time are identical (share re-seals while DRAFT).
  const snapshot = buildTermsSnapshot({
    code,
    title: input.title,
    description: input.description,
    acceptanceCriteria: norm.acceptanceCriteria,
    buyerName: input.buyerName,
    dueDate: input.dueDate ?? null,
    totalCents: split.totalCents,
    advanceCents: split.advanceCents,
    sellerDisplayName: seller.seller.displayName,
    payeeAlias: seller.account.alias,
    payeeLast4: seller.account.clabeLast4,
    ...(norm.cleaning ? { serviceType: "CLEANING" as const, tasks: norm.tasks } : {}),
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
        serviceType: norm.cleaning ? "CLEANING" : "GENERIC",
        paymentStrategy: norm.cleaning ? "ON_COMPLETION" : "ADVANCE_AND_BALANCE",
        status: "DRAFT",
        createdAt: now,
        updatedAt: now,
        version: 1,
        writeId: createWriteId,
      })),
      stmt(env.DB, db.insert(milestones).values([
        ...(norm.cleaning
          ? []
          : [{
              id: crypto.randomUUID(),
              agreementId: id,
              kind: "ADVANCE" as const,
              amountCents: split.advanceCents,
              description: "Anticipo",
              status: "PENDING_ACCEPTANCE" as const,
            }]),
        {
          id: crypto.randomUUID(),
          agreementId: id,
          kind: "BALANCE" as const,
          amountCents: split.balanceCents,
          description: norm.cleaning ? "Pago al terminar" : "Saldo contra entrega",
          status: "WAITING_DELIVERY" as const,
        },
      ])),
      ...(norm.cleaning
        ? [stmt(env.DB, db.insert(agreementTasks).values(
            norm.tasks.map((t) => ({
              id: crypto.randomUUID(),
              agreementId: id,
              position: t.position,
              title: t.title,
              description: t.description,
              status: "TODO" as const,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            })),
          ))]
        : []),
      ...appendEventStatements(env.DB, {
        agreementId: id,
        type: "AGREEMENT_CREATED",
        actorType: "SELLER",
        actorRef: opts.actorRef ?? sellerId,
        payload: {
          code,
          totalCents: split.totalCents,
          advanceCents: split.advanceCents,
          balanceCents: split.balanceCents,
          ...(norm.cleaning ? { serviceType: "CLEANING", taskCount: norm.tasks.length } : {}),
          ...(opts.via ? { via: opts.via } : {}),
        },
        now,
        guardWriteId: createWriteId,
      }),
      // Every agreement has a conversation: link the room it came from, or open a new one.
      opts.conversationId
        ? rawStmt(
            env.DB,
            `UPDATE conversations SET agreement_id = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND seller_id = ? AND agreement_id IS NULL AND ${GUARD_SQL}`,
            id,
            now,
            opts.conversationId,
            sellerId,
            id,
            createWriteId,
          )
        : rawStmt(
            env.DB,
            `INSERT INTO conversations (id, seller_id, agreement_id, created_at, updated_at, version)
             SELECT ?, ?, ?, ?, ?, 1 WHERE ${GUARD_SQL}`,
            crypto.randomUUID(),
            sellerId,
            id,
            now,
            now,
            id,
            createWriteId,
          ),
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
  opts: { via?: ActionVia | undefined; actorRef?: string | undefined } = {},
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
        ...(b.agreement.serviceType === "CLEANING"
          ? {
              serviceType: "CLEANING" as const,
              tasks: b.tasks.map((t) => ({ position: t.position, title: t.title, description: t.description })),
            }
          : {}),
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
          actorRef: opts.actorRef ?? sellerId,
          payload: {
            ...(existing ? {} : { termsSha256: sealed?.termsSha256 ?? b.agreement.termsSha256 }),
            ...(opts.via ? { via: opts.via } : {}),
          },
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


const ACTIVE_PR_EXISTS_SQL = `EXISTS (SELECT 1 FROM payment_requests pr JOIN milestones m ON m.id = pr.milestone_id
  WHERE m.agreement_id = agreements.id AND pr.status IN ('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN'))`;

/**
 * Spec v0.3 §7: revise the terms before acceptance (DRAFT | SHARED only). `terms_version++`, the
 * terms are re-sealed (new `terms_sha256`, so an acceptance of the old hash gets TERMS_MISMATCH),
 * milestone amounts follow, and `TERMS_REVISED` is appended; all in one guarded batch.
 *
 * Active payment request: in DRAFT/SHARED the advance is still PENDING_ACCEPTANCE, so none can
 * exist (they need an accepted agreement). If one ever did, we reject with 409 instead of
 * abandoning it: a request already at the provider could still be paid with the old amount, and
 * abandoning it would risk losing track of real money.
 */
export async function reviseTerms(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  input: CreateAnyAgreementData,
  now: number,
  opts: { via?: ActionVia | undefined; actorRef?: string | undefined } = {},
): Promise<SellerAgreementView> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    if (b.agreement.status !== "DRAFT" && b.agreement.status !== "SHARED") {
      throw invalidState("Las condiciones ya no se pueden cambiar: el comprador ya las aceptó.");
    }
    const norm = normalizedTerms(input);
    if (norm.cleaning !== (b.agreement.serviceType === "CLEANING")) {
      throw invalidState("El tipo de trato no se puede cambiar.");
    }
    if (b.paymentRequests.some((p) => ["CREATING", "AWAITING_PAYMENT", "CREATION_UNKNOWN"].includes(p.status))) {
      throw invalidState("Hay una solicitud de pago en curso; no se pueden cambiar las condiciones.");
    }
    const split = norm.split;
    const termsVersion = b.agreement.termsVersion + 1;
    const snapshot = buildTermsSnapshot({
      code: b.agreement.code,
      title: input.title,
      description: input.description,
      acceptanceCriteria: norm.acceptanceCriteria,
      buyerName: input.buyerName,
      dueDate: input.dueDate ?? null,
      totalCents: split.totalCents,
      advanceCents: split.advanceCents,
      sellerDisplayName: b.seller.displayName,
      payeeAlias: b.account.alias,
      payeeLast4: b.account.clabeLast4,
      termsVersion,
      ...(norm.cleaning ? { serviceType: "CLEANING" as const, tasks: norm.tasks } : {}),
    });
    const termsJson = canonicalJson(snapshot);
    const termsSha256 = await sha256Hex(termsJson);
    const writeId = crypto.randomUUID();

    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(
          env.DB,
          agreementId,
          writeId,
          now,
          `version = ? AND status IN ('DRAFT','SHARED') AND NOT ${ACTIVE_PR_EXISTS_SQL}`,
          b.agreement.version,
        ),
        stmt(
          env.DB,
          db
            .update(agreements)
            .set({
              title: snapshot.title,
              description: snapshot.description,
              acceptanceCriteria: snapshot.acceptanceCriteria,
              buyerName: snapshot.buyerName,
              buyerPhone: input.buyerPhone ?? b.agreement.buyerPhone,
              dueDate: snapshot.dueDate,
              totalCents: split.totalCents,
              termsJson,
              termsSha256,
              termsVersion,
            })
            .where(and(eq(agreements.id, agreementId), guard(agreementId, writeId))),
        ),
        // CLEANING: the checklist is replaced wholesale (DRAFT/SHARED only, so it never has evidence).
        ...(norm.cleaning
          ? [
              rawStmt(
                env.DB,
                `DELETE FROM agreement_tasks WHERE agreement_id = ? AND NOT EXISTS (SELECT 1 FROM evidence WHERE agreement_id = ?) AND ${GUARD_SQL}`,
                agreementId,
                agreementId,
                agreementId,
                writeId,
              ),
              ...norm.tasks.map((t) =>
                rawStmt(
                  env.DB,
                  `INSERT INTO agreement_tasks (id, agreement_id, position, title, description, status, revision, created_at, updated_at)
                   SELECT ?, ?, ?, ?, ?, 'TODO', 1, ?, ? WHERE ${GUARD_SQL}`,
                  crypto.randomUUID(),
                  agreementId,
                  t.position,
                  t.title,
                  t.description,
                  now,
                  now,
                  agreementId,
                  writeId,
                ),
              ),
            ]
          : []),
        rawStmt(
          env.DB,
          `UPDATE milestones SET amount_cents = ? WHERE agreement_id = ? AND kind = 'ADVANCE' AND status = 'PENDING_ACCEPTANCE' AND ${GUARD_SQL}`,
          split.advanceCents,
          agreementId,
          agreementId,
          writeId,
        ),
        rawStmt(
          env.DB,
          `UPDATE milestones SET amount_cents = ? WHERE agreement_id = ? AND kind = 'BALANCE' AND status = 'WAITING_DELIVERY' AND ${GUARD_SQL}`,
          split.balanceCents,
          agreementId,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: "TERMS_REVISED",
          actorType: "SELLER",
          actorRef: opts.actorRef ?? sellerId,
          payload: {
            termsVersion,
            termsSha256,
            totalCents: split.totalCents,
            advanceCents: split.advanceCents,
            ...(norm.cleaning ? { taskCount: norm.tasks.length } : {}),
            ...(opts.via ? { via: opts.via } : {}),
          },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes === 1) return getSellerView(db, env, sellerId, agreementId, now);
  }
  throw invalidState("El trato cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
}
