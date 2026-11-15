import {
  canAddTaskEvidence,
  onTaskReviewed,
  onTaskSubmitted,
  type ActionVia,
  type BuyerAgreementView,
  type EvidenceKind,
  type EvidenceView,
  type TaskReviewDecision,
  type TaskView,
} from "@trato/shared";
import { rawStmt, type Db } from "../db/client";
import type { AppEnv } from "../env";
import { AppError, invalidState, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { GUARD_SQL, claimStmt } from "../payments/common";
import { loadBundle, type AgreementBundle, type TaskRow } from "../repos/agreements";
import { appendEventStatements, batchWithSeqRetry } from "../repos/events";
import { loadOwned } from "./agreements";
import { readImage } from "./evidence";
import { getBuyerView } from "./public";
import { evidenceView, taskViews } from "./views";

const MAX_ATTEMPTS = 3;

export interface TaskActionOpts {
  via?: ActionVia | undefined;
  actorRef?: string | undefined;
}

const NOT_CLEANING = "Este trato no es de limpieza.";

function pickTask(b: AgreementBundle, taskId: string): TaskRow {
  if (b.agreement.serviceType !== "CLEANING") throw invalidState(NOT_CLEANING);
  const t = b.tasks.find((x) => x.id === taskId);
  if (!t) throw notFound("No encontramos esa tarea.");
  return t;
}

const balanceOf = (b: AgreementBundle) => {
  const m = b.milestones.find((x) => x.kind === "BALANCE");
  if (!m) throw new Error("El trato no tiene hito de saldo.");
  return m;
};

const countIn = (b: AgreementBundle, taskId: string, revision: number, kind: EvidenceKind): number =>
  b.evidence.filter((e) => e.taskId === taskId && e.revisionNumber === revision && e.kind === kind).length;

const via = (o: TaskActionOpts) => (o.via ? { via: o.via } : {});

const isUniqueConflict = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /task_reviews/i.test(msg);
};

async function taskViewOf(env: AppEnv, db: Db, agreementId: string, taskId: string, now: number, includeDrafts: boolean): Promise<TaskView> {
  const b = await loadBundle(db, agreementId);
  const v = b ? (await taskViews(env, b, now, includeDrafts))?.find((t) => t.id === taskId) : undefined;
  if (!v) throw notFound("No encontramos esa tarea.");
  return v;
}

/** Seller uploads a photo for one task (AFTER by default). Same pipeline as the generic evidence upload. */
export async function addTaskEvidence(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  taskId: string,
  file: File,
  kind: EvidenceKind,
  now: number,
  opts: TaskActionOpts = {},
): Promise<EvidenceView> {
  const { buf, kind: img, sha256 } = await readImage(file);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const task = pickTask(b, taskId);
    const balance = balanceOf(b);
    const limit = kind === "BEFORE" ? 2 : 3;
    const can = canAddTaskEvidence(b.agreement, task, kind, countIn(b, task.id, task.revision, kind));
    if (!can.ok) throw new AppError(can.code, can.message);

    const evidenceId = crypto.randomUUID();
    const r2Key = `agreements/${agreementId}/${evidenceId}.${img.ext}`;
    await env.EVIDENCE.put(r2Key, buf, { httpMetadata: { contentType: img.mime } });

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
            `status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM agreement_tasks WHERE id = ? AND status = ? AND revision = ?)
             AND (SELECT COUNT(*) FROM evidence WHERE task_id = ? AND revision_number = ? AND kind = ?) < ?`,
            task.id,
            task.status,
            task.revision,
            task.id,
            task.revision,
            kind,
            limit,
          ),
          rawStmt(
            env.DB,
            `INSERT INTO evidence (id, agreement_id, milestone_id, delivery_round, uploaded_by, r2_key, sha256, mime_type, size_bytes, submitted, task_id, kind, revision_number, created_at)
             SELECT ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ? WHERE ${GUARD_SQL}`,
            evidenceId,
            agreementId,
            balance.id,
            sellerId,
            r2Key,
            sha256,
            img.mime,
            buf.byteLength,
            task.id,
            kind,
            task.revision,
            now,
            agreementId,
            writeId,
          ),
          ...appendEventStatements(env.DB, {
            agreementId,
            type: "EVIDENCE_ADDED",
            actorType: "SELLER",
            actorRef: opts.actorRef ?? sellerId,
            payload: {
              taskId: task.id,
              taskTitle: task.title,
              revision: task.revision,
              kind,
              sha256,
              mimeType: img.mime,
              sizeBytes: buf.byteLength,
              ...via(opts),
            },
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
    await env.EVIDENCE.delete(r2Key).catch(() => undefined);
  }
  throw invalidState("El trato cambió mientras se subía la foto. Inténtalo de nuevo.");
}

/** Seller removes a photo that was not submitted yet. Submitted photos are never deleted. */
export async function removeTaskEvidence(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  taskId: string,
  evidenceId: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const task = pickTask(b, taskId);
    const row = b.evidence.find((e) => e.id === evidenceId && e.taskId === task.id);
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
          payload: { taskId: task.id, taskTitle: task.title, revision: row.revisionNumber, sha256: row.sha256 },
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

/** Seller sends one task to the client's review: TODO|NEEDS_ADJUSTMENT -> IN_REVIEW; its photos become visible. */
export async function submitTask(
  db: Db,
  env: AppEnv,
  sellerId: string,
  agreementId: string,
  taskId: string,
  note: string | undefined,
  now: number,
  opts: TaskActionOpts = {},
): Promise<TaskView> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadOwned(db, sellerId, agreementId);
    const task = pickTask(b, taskId);
    const afterCount = countIn(b, task.id, task.revision, "AFTER");
    const t = onTaskSubmitted(b.agreement, task, afterCount);
    if (!t.ok) throw new AppError(t.code, t.message);

    const writeId = crypto.randomUUID();
    const results = await batchWithSeqRetry(() =>
      env.DB.batch([
        claimStmt(
          env.DB,
          agreementId,
          writeId,
          now,
          `status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM agreement_tasks WHERE id = ? AND status = ? AND revision = ?)
           AND (SELECT COUNT(*) FROM evidence WHERE task_id = ? AND revision_number = ? AND kind = 'AFTER') >= 1`,
          task.id,
          task.status,
          task.revision,
          task.id,
          task.revision,
        ),
        rawStmt(
          env.DB,
          `UPDATE agreement_tasks SET status = 'IN_REVIEW', submitted_at = ?, updated_at = ? WHERE id = ? AND status = ? AND ${GUARD_SQL}`,
          now,
          now,
          task.id,
          task.status,
          agreementId,
          writeId,
        ),
        rawStmt(
          env.DB,
          `UPDATE evidence SET submitted = 1 WHERE task_id = ? AND revision_number = ? AND submitted = 0 AND ${GUARD_SQL}`,
          task.id,
          task.revision,
          agreementId,
          writeId,
        ),
        ...appendEventStatements(env.DB, {
          agreementId,
          type: "TASK_SUBMITTED",
          actorType: "SELLER",
          actorRef: opts.actorRef ?? sellerId,
          payload: {
            taskId: task.id,
            taskTitle: task.title,
            revision: task.revision,
            ...(note ? { note } : {}),
            ...via(opts),
          },
          now,
          guardWriteId: writeId,
        }),
      ]),
    );
    if (results[0]?.meta.changes === 1) return taskViewOf(env, db, agreementId, task.id, now, true);
  }
  throw invalidState("El trato cambió mientras se procesaba la solicitud. Inténtalo de nuevo.");
}

/**
 * Client decision on one submitted task. Everything (task status, the single TaskReview row, the
 * BALANCE milestone becoming chargeable when no task is left unapproved, and the events) goes in
 * one guarded batch. The "all approved" check is evaluated by SQL after this task's own update, so two
 * concurrent last approvals can't both miss it. UNIQUE(task_id, revision_number) is the backstop.
 */
export async function reviewTask(
  db: Db,
  env: AppEnv,
  agreementId: string,
  taskId: string,
  decision: TaskReviewDecision,
  reason: string | null | undefined,
  now: number,
  opts: TaskActionOpts = {},
): Promise<BuyerAgreementView> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const b = await loadBundle(db, agreementId);
    if (!b) throw notFound("Este enlace no existe o ya no está vigente.");
    const task = pickTask(b, taskId);
    const balance = balanceOf(b);
    const t = onTaskReviewed(
      decision,
      reason,
      b.agreement,
      task,
      b.tasks.filter((x) => x.id !== task.id),
    );
    if (!t.ok) throw new AppError(t.code, t.message);

    const comment = decision === "REQUEST_ADJUSTMENT" ? (reason ?? "").trim() : null;
    const reviewerName = b.agreement.buyerAcceptedName ?? b.agreement.buyerName;
    const writeId = crypto.randomUUID();
    const payload = {
      taskId: task.id,
      taskTitle: task.title,
      revision: task.revision,
      ...(comment ? { comment } : {}),
      ...via(opts),
    };
    const approve = decision === "APPROVE";
    let results: D1Result[];
    try {
      results = await batchWithSeqRetry(() =>
        env.DB.batch([
          claimStmt(
            env.DB,
            agreementId,
            writeId,
            now,
            `status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM agreement_tasks WHERE id = ? AND status = 'IN_REVIEW' AND revision = ?)`,
            task.id,
            task.revision,
          ),
          rawStmt(
            env.DB,
            `INSERT INTO task_reviews (id, task_id, revision_number, decision, comment, reviewer_name, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD_SQL}`,
            crypto.randomUUID(),
            task.id,
            task.revision,
            decision,
            comment,
            reviewerName,
            now,
            agreementId,
            writeId,
          ),
          rawStmt(
            env.DB,
            `UPDATE agreement_tasks SET status = ?, revision = ?, approved_at = CASE WHEN ? = 1 THEN ? ELSE approved_at END, updated_at = ?
             WHERE id = ? AND status = 'IN_REVIEW' AND ${GUARD_SQL}`,
            t.taskStatus,
            t.revision,
            approve ? 1 : 0,
            now,
            now,
            task.id,
            agreementId,
            writeId,
          ),
          // Only when no task is left unapproved (evaluated after this task's own update).
          rawStmt(
            env.DB,
            `UPDATE milestones SET status = 'READY_TO_CHARGE', approved_at = ?
             WHERE id = ? AND status = 'WAITING_DELIVERY' AND ? = 1
               AND NOT EXISTS (SELECT 1 FROM agreement_tasks WHERE agreement_id = ? AND status <> 'APPROVED')
               AND ${GUARD_SQL}`,
            now,
            balance.id,
            approve ? 1 : 0,
            agreementId,
            agreementId,
            writeId,
          ),
          ...appendEventStatements(env.DB, {
            agreementId,
            type: approve ? "TASK_APPROVED" : "TASK_ADJUSTMENT_REQUESTED",
            actorType: "BUYER",
            actorRef: reviewerName,
            payload,
            now,
            guardWriteId: writeId,
          }),
          ...(approve
            ? appendEventStatements(env.DB, {
                agreementId,
                type: "ALL_TASKS_APPROVED",
                actorType: "SYSTEM",
                payload: { taskCount: b.tasks.length, ...via(opts) },
                now,
                guardWriteId: writeId,
                extraWhere: {
                  sql: "EXISTS (SELECT 1 FROM milestones WHERE id = ? AND status = 'READY_TO_CHARGE' AND approved_at = ?) AND NOT EXISTS (SELECT 1 FROM agreement_events WHERE agreement_id = ? AND event_type = 'ALL_TASKS_APPROVED')",
                  params: [balance.id, now, agreementId],
                },
              })
            : []),
        ]),
      );
    } catch (err) {
      if (isUniqueConflict(err)) throw invalidState("Esta tarea ya fue revisada.");
      throw err;
    }
    if (results[0]?.meta.changes === 1) return getBuyerView(db, env, agreementId, now);
  }
  throw invalidState("La tarea cambió mientras se procesaba tu respuesta. Recarga la página.");
}

