import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  agreementEvents,
  agreementTasks,
  agreements,
  buyerAccess,
  conversations,
  demoBankAccounts,
  evidence,
  milestones,
  paymentRequests,
  reviews,
  sellers,
  taskReviews,
} from "../db/schema";

export type AgreementRow = typeof agreements.$inferSelect;
export type TaskRow = typeof agreementTasks.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;
export type SellerRow = typeof sellers.$inferSelect;
export type AccountRow = typeof demoBankAccounts.$inferSelect;

export interface AgreementBundle {
  agreement: AgreementRow;
  seller: SellerRow;
  account: AccountRow;
  milestones: MilestoneRow[];
  paymentRequests: (typeof paymentRequests.$inferSelect)[];
  evidence: (typeof evidence.$inferSelect)[];
  reviews: (typeof reviews.$inferSelect)[];
  /** Cleaning checklist (empty for GENERIC), ordered by position. */
  tasks: TaskRow[];
  taskReviews: (typeof taskReviews.$inferSelect)[];
  events: (typeof agreementEvents.$inferSelect)[];
  activeAccess: typeof buyerAccess.$inferSelect | null;
  conversationId: string | null;
}

/** Loads the whole agreement: 10 independent reads issued in parallel. */
export async function loadBundle(db: Db, agreementId: string): Promise<AgreementBundle | null> {
  const [head, ms, prs, ev, rv, evs, acc, conv, tks, trs] = await Promise.all([
    db
      .select({ agreement: agreements, seller: sellers, account: demoBankAccounts })
      .from(agreements)
      .innerJoin(sellers, eq(sellers.id, agreements.sellerId))
      .innerJoin(demoBankAccounts, eq(demoBankAccounts.id, sellers.demoBankAccountId))
      .where(eq(agreements.id, agreementId))
      .limit(1),
    db.select().from(milestones).where(eq(milestones.agreementId, agreementId)),
    db
      .select({ pr: paymentRequests })
      .from(paymentRequests)
      .innerJoin(milestones, eq(milestones.id, paymentRequests.milestoneId))
      .where(eq(milestones.agreementId, agreementId))
      .orderBy(paymentRequests.createdAt),
    db.select().from(evidence).where(eq(evidence.agreementId, agreementId)).orderBy(evidence.createdAt),
    db
      .select({ rv: reviews })
      .from(reviews)
      .innerJoin(milestones, eq(milestones.id, reviews.milestoneId))
      .where(eq(milestones.agreementId, agreementId))
      .orderBy(reviews.createdAt),
    db.select().from(agreementEvents).where(eq(agreementEvents.agreementId, agreementId)).orderBy(agreementEvents.seq),
    db
      .select()
      .from(buyerAccess)
      .where(and(eq(buyerAccess.agreementId, agreementId), isNull(buyerAccess.revokedAt)))
      .orderBy(desc(buyerAccess.issuedAt))
      .limit(1),
    db.select({ id: conversations.id }).from(conversations).where(eq(conversations.agreementId, agreementId)).limit(1),
    db.select().from(agreementTasks).where(eq(agreementTasks.agreementId, agreementId)).orderBy(agreementTasks.position),
    db
      .select({ tr: taskReviews })
      .from(taskReviews)
      .innerJoin(agreementTasks, eq(agreementTasks.id, taskReviews.taskId))
      .where(eq(agreementTasks.agreementId, agreementId))
      .orderBy(taskReviews.createdAt),
  ]);
  const h = head[0];
  if (!h) return null;
  return {
    agreement: h.agreement,
    seller: h.seller,
    account: h.account,
    milestones: ms,
    paymentRequests: prs.map((r) => r.pr),
    evidence: ev,
    reviews: rv.map((r) => r.rv),
    tasks: tks,
    taskReviews: trs.map((r) => r.tr),
    events: evs,
    activeAccess: acc[0] ?? null,
    conversationId: conv[0]?.id ?? null,
  };
}

export async function listBySeller(db: Db, sellerId: string) {
  const rows = await db
    .select()
    .from(agreements)
    .where(eq(agreements.sellerId, sellerId))
    .orderBy(desc(agreements.updatedAt));
  if (rows.length === 0) return [];
  const balances = await db
    .select({ agreementId: milestones.agreementId, status: milestones.status })
    .from(milestones)
    .where(and(inArray(milestones.agreementId, rows.map((r) => r.id)), eq(milestones.kind, "BALANCE")));
  const byId = new Map(balances.map((b) => [b.agreementId, b.status]));
  const convs = await db
    .select({ id: conversations.id, agreementId: conversations.agreementId })
    .from(conversations)
    .where(inArray(conversations.agreementId, rows.map((r) => r.id)));
  const convBy = new Map(convs.map((c) => [c.agreementId, c.id]));
  const cleaningIds = rows.filter((r) => r.serviceType === "CLEANING").map((r) => r.id);
  const taskRows = cleaningIds.length
    ? await db
        .select({ agreementId: agreementTasks.agreementId, status: agreementTasks.status })
        .from(agreementTasks)
        .where(inArray(agreementTasks.agreementId, cleaningIds))
    : [];
  const tasksBy = new Map<string, { status: TaskRow["status"] }[]>();
  for (const t of taskRows) tasksBy.set(t.agreementId, [...(tasksBy.get(t.agreementId) ?? []), { status: t.status }]);
  return rows.map((a) => ({
    agreement: a,
    tasks: tasksBy.get(a.id) ?? [],
    balanceStatus: byId.get(a.id) ?? "WAITING_DELIVERY",
    conversationId: convBy.get(a.id) ?? null,
  }));
}

export async function nextCounter(db: Db, name: string): Promise<number> {
  const res = await db.all<{ value: number }>(
    sql`INSERT INTO counters (name, value) VALUES (${name}, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
  );
  const row = res[0];
  if (!row) throw new Error("No se pudo incrementar el contador.");
  return row.value;
}

export async function findAccessByHash(db: Db, tokenHash: string) {
  const rows = await db.select().from(buyerAccess).where(eq(buyerAccess.tokenHash, tokenHash)).limit(1);
  return rows[0] ?? null;
}

export async function findSeller(db: Db, sellerId: string) {
  const rows = await db
    .select({ seller: sellers, account: demoBankAccounts })
    .from(sellers)
    .innerJoin(demoBankAccounts, eq(demoBankAccounts.id, sellers.demoBankAccountId))
    .where(eq(sellers.id, sellerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listSellers(db: Db) {
  return db
    .select({ seller: sellers, account: demoBankAccounts })
    .from(sellers)
    .innerJoin(demoBankAccounts, eq(demoBankAccounts.id, sellers.demoBankAccountId))
    .orderBy(sellers.id);
}
