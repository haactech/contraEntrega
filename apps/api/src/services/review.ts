import { onReviewed, type BuyerAgreementView, type ReviewRequest } from "@trato/shared";
import { rawStmt, type Db } from "../db/client";
import type { AppEnv } from "../env";
import { AppError, invalidState, notFound } from "../lib/errors";
import { GUARD_SQL, claimStmt } from "../payments/common";
import { loadBundle } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { getBuyerView } from "./public";

const MAX_ATTEMPTS = 3;

/** Buyer decision on the delivery: APPROVE makes the balance chargeable (never PAID); DISPUTE blocks it. */
export async function submitReview(
  db: Db,
  env: AppEnv,
  agreementId: string,
  input: ReviewRequest,
  now: number,
): Promise<BuyerAgreementView> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadBundle(db, agreementId);
    if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
    const balance = b.milestones.find((m) => m.kind === "BALANCE");
    if (!balance) throw new Error("El trato no tiene hito de saldo.");
    const t = onReviewed(input.decision, b.agreement, {
      kind: balance.kind,
      status: balance.status,
      deliveryRound: balance.deliveryRound,
    });
    if (!t.ok) throw new AppError(t.code, t.message);

    const comment = input.comment && input.comment.length > 0 ? input.comment : null;
    const writeId = crypto.randomUUID();
    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(
          env.DB,
          agreementId,
          writeId,
          now,
          `status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM milestones WHERE id = ? AND status = 'WAITING_BUYER_REVIEW' AND delivery_round = ?)`,
          balance.id,
          balance.deliveryRound,
        ),
        rawStmt(
          env.DB,
          `UPDATE milestones SET status = ?, approved_at = CASE WHEN ? = 1 THEN ? ELSE approved_at END WHERE id = ? AND ${GUARD_SQL}`,
          t.balanceStatus,
          t.approved ? 1 : 0,
          now,
          balance.id,
          agreementId,
          writeId,
        ),
        rawStmt(env.DB, "UPDATE agreements SET status = ? WHERE id = ? AND write_id = ?", t.agreementStatus, agreementId, writeId),
        rawStmt(
          env.DB,
          `INSERT INTO reviews (id, milestone_id, delivery_round, decision, comment, buyer_name, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD_SQL}`,
          crypto.randomUUID(),
          balance.id,
          balance.deliveryRound,
          t.decision,
          comment,
          input.buyerName,
          now,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: t.eventType,
          actorType: "BUYER",
          actorRef: input.buyerName,
          payload: {
            milestoneKind: "BALANCE",
            deliveryRound: balance.deliveryRound,
            buyerName: input.buyerName,
            ...(comment ? { comment } : {}),
          },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes === 1) return getBuyerView(db, env, agreementId, now);
  }
  throw invalidState("La entrega cambió mientras se procesaba tu respuesta. Recarga la página.");
}
