import type { Context } from "hono";
import { logger } from "../lib/logger";

/**
 * Background assistant runs. In production `executionCtx.waitUntil` keeps the Worker alive; the
 * registry additionally lets tests (which call `app.fetch(req, env)` without an execution context)
 * wait for them with `settleAssistantTasks()`.
 */
const pending = new Set<Promise<unknown>>();

export function runInBackground(c: Context, task: Promise<void>): void {
  const safe = task.catch((err: unknown) => logger.error("assistant_task_failed", { error: err }));
  pending.add(safe);
  void safe.finally(() => pending.delete(safe));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No ExecutionContext (tests): the registry above is the only handle.
  }
}

/** Resolves when every background assistant run (including coalesced follow-ups) has finished. */
export async function settleAssistantTasks(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
