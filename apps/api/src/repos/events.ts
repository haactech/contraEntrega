import type { ActorType, EventType } from "@trato/shared";
import { rawStmt } from "../db/client";

export interface AppendEventInput {
  agreementId: string;
  type: EventType;
  actorType: ActorType;
  actorRef?: string | null;
  payload?: Record<string, unknown>;
  now: number;
  /**
   * When set, the event only takes effect if `agreements.write_id` equals this nonce, i.e. the
   * caller's own guarded UPDATE (which already bumped the version) won the optimistic lock.
   * When omitted the event is unconditional and `agreements.version` is incremented.
   */
  guardWriteId?: string;
  /** Extra `WHERE` condition (raw SQL fragment, no leading AND) that must hold for the event to be written. Only with `guardWriteId`. */
  extraWhere?: { sql: string; params: unknown[] };
}

/**
 * Batch statements that append an event with a stable `seq` (MAX(seq)+1, computed inside the
 * same INSERT ... SELECT so it is atomic) and bump `agreements.version`.
 * Concurrent writers collide on UNIQUE(agreement_id, seq): use `batchWithSeqRetry`.
 */
export function appendEventStatements(d1: D1Database, e: AppendEventInput): D1PreparedStatement[] {
  const id = crypto.randomUUID();
  const payload = JSON.stringify(e.payload ?? {});
  const guarded = e.guardWriteId !== undefined;
  // The guard must live in the outer WHERE: an aggregate SELECT always yields one row.
  const insert = rawStmt(
    d1,
    `INSERT INTO agreement_events (id, agreement_id, seq, event_type, actor_type, actor_ref, payload_json, occurred_at)
     SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agreement_events WHERE agreement_id = ?), ?, ?, ?, ?, ?${
       guarded ? ` WHERE EXISTS (SELECT 1 FROM agreements WHERE id = ? AND write_id = ?)${e.extraWhere ? ` AND ${e.extraWhere.sql}` : ""}` : ""
     }`,
    id,
    e.agreementId,
    e.agreementId,
    e.type,
    e.actorType,
    e.actorRef ?? null,
    payload,
    e.now,
    ...(guarded ? [e.agreementId, e.guardWriteId, ...(e.extraWhere?.params ?? [])] : []),
  );
  if (guarded) return [insert];
  return [
    insert,
    rawStmt(d1, "UPDATE agreements SET version = version + 1, updated_at = ? WHERE id = ?", e.now, e.agreementId),
  ];
}

const isSeqConflict = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /agreement_events/i.test(msg);
};

/** Runs `run()` (which must build fresh statements and execute a batch); retries on seq conflicts. */
export async function batchWithSeqRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (err) {
      if (!isSeqConflict(err)) throw err;
      last = err;
    }
  }
  throw last;
}
