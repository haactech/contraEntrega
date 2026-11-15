import {
  type ActionVia,
  EVIDENCE_LIMITS,
  evidenceRoundFor,
  canAddEvidence,
  onReviewRequested,
  type EvidenceView,
  type RequestReviewRequest,
  type SellerAgreementView,
} from "@trato/shared";
import { rawStmt } from "../db/client";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import { AppError, invalidState, notFound } from "../lib/errors";
import { sniffImage } from "../lib/image";
import { logger } from "../lib/logger";
import { GUARD_SQL, claimStmt } from "../payments/common";
import { loadBundle, type AgreementBundle } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { loadOwned } from "./agreements";
import { buildSellerView, evidenceView } from "./views";

const MAX_ATTEMPTS = 3;

/** Channel hint and actor override recorded in event payloads / `actor_ref` (e.g. `mcp:<apiKeyId>`). */
export interface ActionOpts {
  via?: ActionVia | undefined;
  actorRef?: string | undefined;
}

const balanceOf = (b: AgreementBundle) => {
  const m = b.milestones.find((x) => x.kind === "BALANCE");
  if (!m) throw new Error("El trato no tiene hito de saldo.");
  return m;
};

const snap = (m: { kind: "ADVANCE" | "BALANCE"; status: AgreementBundle["milestones"][number]["status"]; deliveryRound: number }) => ({
  kind: m.kind,
  status: m.status,
  deliveryRound: m.deliveryRound,
});

/** Sha-256 of raw bytes (hex). */
async function sha256Bytes(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Pre-validates the declared body size so oversized uploads are rejected before buffering. */
export function assertDeclaredSize(contentLength: string | undefined): void {
  if (!contentLength) return;
  const n = Number(contentLength);
  // Allow multipart framing overhead on top of the file limit.
  if (Number.isFinite(n) && n > EVIDENCE_LIMITS.maxBytes + 64 * 1024) {
    throw new AppError("VALIDATION_ERROR", "La foto pesa más de 5 MB. Comprímela e inténtalo de nuevo.");
  }
}

export async function addEvidence(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  file: File,
  now: number,
  opts: ActionOpts = {},
): Promise<EvidenceView> {
  if (file.size > EVIDENCE_LIMITS.maxBytes) {
    throw new AppError("VALIDATION_ERROR", "La foto pesa más de 5 MB. Comprímela e inténtalo de nuevo.");
  }
  if (file.size === 0) throw new AppError("VALIDATION_ERROR", "El archivo está vacío.");
  const buf = await file.arrayBuffer();
  if (buf.byteLength > EVIDENCE_LIMITS.maxBytes) {
    throw new AppError("VALIDATION_ERROR", "La foto pesa más de 5 MB. Comprímela e inténtalo de nuevo.");
  }
  const kind = sniffImage(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
  if (!kind) throw new AppError("VALIDATION_ERROR", "Solo se aceptan fotos JPEG, PNG o WebP.");
  const sha256 = await sha256Bytes(buf);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const balance = balanceOf(b);
    const round = evidenceRoundFor(snap(balance));
    const inRound = b.evidence.filter((e) => e.milestoneId === balance.id && e.deliveryRound === round).length;
    const can = canAddEvidence(b.agreement, snap(balance), inRound);
    if (!can.ok) throw new AppError(can.code, can.message);

    const evidenceId = crypto.randomUUID();
    const r2Key = `agreements/${agreementId}/${evidenceId}.${kind.ext}`;
    await env.EVIDENCE.put(r2Key, buf, { httpMetadata: { contentType: kind.mime } });

    const writeId = crypto.randomUUID();
    let results: D1Result[];
    try {
      results = await batchWithSeqRetry(() =>
        env.DB.batch([
          claimStmt(
            env.DB,
            agreementId,
            writeId,
            now,
            `status = ? AND EXISTS (SELECT 1 FROM milestones WHERE id = ? AND status = ? AND delivery_round = ?)
             AND (SELECT COUNT(*) FROM evidence WHERE milestone_id = ? AND delivery_round = ?) < ?`,
            b.agreement.status,
            balance.id,
            balance.status,
            balance.deliveryRound,
            balance.id,
            round,
            EVIDENCE_LIMITS.maxPerRound,
          ),
          rawStmt(
            env.DB,
            `INSERT INTO evidence (id, agreement_id, milestone_id, delivery_round, uploaded_by, r2_key, sha256, mime_type, size_bytes, submitted, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ? WHERE ${GUARD_SQL}`,
            evidenceId,
            agreementId,
            balance.id,
            round,
            sellerId,
            r2Key,
            sha256,
            kind.mime,
            buf.byteLength,
            now,
            agreementId,
            writeId,
          ),
          ...appendEventStatements(env.DB, {
            agreementId,
            type: "EVIDENCE_ADDED",
            actorType: "SELLER",
            actorRef: opts.actorRef ?? sellerId,
            payload: { milestoneKind: "BALANCE", deliveryRound: round, sha256, mimeType: kind.mime, sizeBytes: buf.byteLength, ...(opts.via ? { via: opts.via } : {}) },
            now,
            guardWriteId: writeId,
          }),
        ]),
      );
    } catch (err) {
      await env.EVIDENCE.delete(r2Key).catch(() => undefined);
      throw err;
    }
    if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
      const row = (await loadBundle(db, agreementId))?.evidence.find((e) => e.id === evidenceId);
      if (!row) throw new Error("La evidencia no quedó registrada.");
      return evidenceView(env, row, now);
    }
    // Lost a race (state change or concurrent upload): drop the object and re-evaluate.
    await env.EVIDENCE.delete(r2Key).catch(() => undefined);
  }
  throw invalidState("El trato cambió mientras se subía la foto. Inténtalo de nuevo.");
}

export async function removeEvidence(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  evidenceId: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const row = b.evidence.find((e) => e.id === evidenceId);
    if (!row) throw notFound("No encontramos esa foto.");
    if (row.submitted) throw invalidState("Esta foto ya fue enviada a revisión y no se puede eliminar.");

    const writeId = crypto.randomUUID();
    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(env.DB, agreementId, writeId, now, "EXISTS (SELECT 1 FROM evidence WHERE id = ? AND submitted = 0)", evidenceId),
        rawStmt(env.DB, `DELETE FROM evidence WHERE id = ? AND submitted = 0 AND ${GUARD_SQL}`, evidenceId, agreementId, writeId),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: "EVIDENCE_REMOVED",
          actorType: "SELLER",
          actorRef: sellerId,
          payload: { milestoneKind: "BALANCE", deliveryRound: row.deliveryRound, sha256: row.sha256 },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes === 1) {
      await env.EVIDENCE.delete(row.r2Key).catch((err: unknown) => logger.warn("r2_delete_failed", { error: err }));
      return;
    }
  }
  throw invalidState("El trato cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
}

export async function requestReview(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  input: RequestReviewRequest,
  now: number,
  opts: ActionOpts = {},
): Promise<SellerAgreementView> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const balance = balanceOf(b);
    const unsubmitted = b.evidence.filter((e) => e.milestoneId === balance.id && !e.submitted).length;
    const t = onReviewRequested(b.agreement, snap(balance), unsubmitted);
    if (!t.ok) throw new AppError(t.code, t.message);

    const writeId = crypto.randomUUID();
    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(
          env.DB,
          agreementId,
          writeId,
          now,
          `status = ? AND EXISTS (SELECT 1 FROM milestones WHERE id = ? AND status = ? AND delivery_round = ?)
           AND (SELECT COUNT(*) FROM evidence WHERE milestone_id = ? AND submitted = 0) = ?`,
          b.agreement.status,
          balance.id,
          balance.status,
          balance.deliveryRound,
          balance.id,
          unsubmitted,
        ),
        rawStmt(
          env.DB,
          `UPDATE milestones SET status = ?, delivery_round = ? WHERE id = ? AND ${GUARD_SQL}`,
          t.balanceStatus,
          t.deliveryRound,
          balance.id,
          agreementId,
          writeId,
        ),
        rawStmt(env.DB, "UPDATE agreements SET status = ? WHERE id = ? AND write_id = ?", t.agreementStatus, agreementId, writeId),
        rawStmt(
          env.DB,
          `UPDATE evidence SET submitted = 1 WHERE milestone_id = ? AND submitted = 0 AND ${GUARD_SQL}`,
          balance.id,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: "REVIEW_REQUESTED",
          actorType: "SELLER",
          actorRef: opts.actorRef ?? sellerId,
          payload: {
            milestoneKind: "BALANCE",
            deliveryRound: t.deliveryRound,
            evidenceCount: unsubmitted,
            note: input.note ?? null,
            redelivery: t.redelivery,
            ...(opts.via ? { via: opts.via } : {}),
          },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes === 1) {
      return buildSellerView(env, await loadOwned(db, sellerId, agreementId), now);
    }
  }
  throw invalidState("El trato cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
}
