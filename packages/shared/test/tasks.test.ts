import { describe, expect, it } from "vitest";
import {
  CLEANING_TEMPLATE,
  CreateAgreementInputSchema,
  CreateAnyAgreementInputSchema,
  CreateCleaningAgreementInputSchema,
  RequestAdjustmentRequestSchema,
  ReviewTaskMcpInputSchema,
  MCP_TOOL_NAMES,
  API_ROUTES,
  APP_ROUTES,
  EVENT_TYPES,
  BUYER_HIDDEN_EVENT_TYPES,
  TASK_LIMITS,
  allTasksApproved,
  buildCleaningAcceptanceCriteria,
  buildTermsSnapshot,
  canAddTaskEvidence,
  canReviewTask,
  canSubmitTask,
  computeCleaningBuyerNextAction,
  computeCleaningSellerNextAction,
  hashTerms,
  onAcceptedCleaning,
  onTaskReviewed,
  onTaskSubmitted,
  type CleaningAgreementSnapshot,
  type TaskSnapshot,
  type TaskStatus,
} from "../src";

const live: CleaningAgreementSnapshot = { status: "IN_PROGRESS", serviceType: "CLEANING" };
const task = (status: TaskStatus, revision = 1): TaskSnapshot => ({ status, revision });
const st = (...s: TaskStatus[]) => s.map((status) => ({ status }));

describe("CLEANING_TEMPLATE", () => {
  it("matches the spec", () => {
    expect(CLEANING_TEMPLATE.title).toBe("Limpieza de departamento");
    expect(CLEANING_TEMPLATE.suggestedTotalCents).toBe(70_000);
    expect(CLEANING_TEMPLATE.tasks.filter((t) => t.enabledByDefault).map((t) => t.title)).toEqual([
      "Limpiar baño",
      "Limpiar cocina",
      "Trapear pisos",
      "Limpiar ventanas",
    ]);
    expect(CLEANING_TEMPLATE.tasks).toHaveLength(6);
  });
});

describe("guards", () => {
  it("rejects non-cleaning or non-active agreements", () => {
    expect(canSubmitTask({ status: "IN_PROGRESS", serviceType: "GENERIC" }, task("TODO"), 1).ok).toBe(false);
    expect(canSubmitTask({ status: "SHARED", serviceType: "CLEANING" }, task("TODO"), 1).ok).toBe(false);
  });
  it("evidence: AFTER on TODO/NEEDS_ADJUSTMENT up to 3, BEFORE on TODO up to 2", () => {
    expect(canAddTaskEvidence(live, task("TODO"), "AFTER", 2).ok).toBe(true);
    expect(canAddTaskEvidence(live, task("TODO"), "AFTER", 3).ok).toBe(false);
    expect(canAddTaskEvidence(live, task("NEEDS_ADJUSTMENT", 2), "AFTER", 0).ok).toBe(true);
    expect(canAddTaskEvidence(live, task("IN_REVIEW"), "AFTER", 0).ok).toBe(false);
    expect(canAddTaskEvidence(live, task("APPROVED"), "AFTER", 0).ok).toBe(false);
    expect(canAddTaskEvidence(live, task("TODO"), "BEFORE", 1).ok).toBe(true);
    expect(canAddTaskEvidence(live, task("TODO"), "BEFORE", 2).ok).toBe(false);
    expect(canAddTaskEvidence(live, task("NEEDS_ADJUSTMENT", 2), "BEFORE", 0).ok).toBe(false);
  });
  it("cannot submit without an AFTER photo", () => {
    const r = canSubmitTask(live, task("TODO"), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/foto/);
    expect(canSubmitTask(live, task("TODO"), 1).ok).toBe(true);
    expect(canSubmitTask(live, task("IN_REVIEW"), 1).ok).toBe(false);
    expect(canSubmitTask(live, task("APPROVED"), 1).ok).toBe(false);
  });
  it("cannot review a task that is not IN_REVIEW", () => {
    for (const s of ["TODO", "NEEDS_ADJUSTMENT", "APPROVED"] as const) {
      expect(canReviewTask(live, task(s), "APPROVE").ok).toBe(false);
    }
    expect(canReviewTask(live, task("IN_REVIEW"), "APPROVE").ok).toBe(true);
  });
  it("adjustment requires a reason of 3..500 chars", () => {
    expect(canReviewTask(live, task("IN_REVIEW"), "REQUEST_ADJUSTMENT", undefined).ok).toBe(false);
    expect(canReviewTask(live, task("IN_REVIEW"), "REQUEST_ADJUSTMENT", " a ").ok).toBe(false);
    expect(canReviewTask(live, task("IN_REVIEW"), "REQUEST_ADJUSTMENT", "x".repeat(501)).ok).toBe(false);
    expect(canReviewTask(live, task("IN_REVIEW"), "REQUEST_ADJUSTMENT", "Falta el espejo").ok).toBe(true);
  });
});

describe("transitions", () => {
  it("submit moves to IN_REVIEW keeping the revision", () => {
    expect(onTaskSubmitted(live, task("NEEDS_ADJUSTMENT", 2), 1)).toEqual({
      ok: true,
      taskStatus: "IN_REVIEW",
      revision: 2,
    });
    expect(onTaskSubmitted(live, task("APPROVED"), 1).ok).toBe(false);
  });
  it("adjustment increments the revision and never completes", () => {
    const r = onTaskReviewed("REQUEST_ADJUSTMENT", "Falta el espejo", live, task("IN_REVIEW", 1), st("APPROVED"));
    expect(r).toEqual({ ok: true, taskStatus: "NEEDS_ADJUSTMENT", revision: 2, allApproved: false });
  });
  it("approve of a non-last task does not flip the balance", () => {
    const r = onTaskReviewed("APPROVE", null, live, task("IN_REVIEW"), st("TODO", "APPROVED"));
    expect(r).toEqual({ ok: true, taskStatus: "APPROVED", revision: 1, allApproved: false });
  });
  it("approving the last task flips allApproved and READY_TO_CHARGE", () => {
    const r = onTaskReviewed("APPROVE", null, live, task("IN_REVIEW", 3), st("APPROVED", "APPROVED"));
    expect(r).toEqual({
      ok: true,
      taskStatus: "APPROVED",
      revision: 3,
      allApproved: true,
      balanceStatus: "READY_TO_CHARGE",
    });
  });
  it("invalid jumps fail", () => {
    expect(onTaskReviewed("APPROVE", null, live, task("TODO"), []).ok).toBe(false);
    expect(onTaskReviewed("REQUEST_ADJUSTMENT", "ok bien", live, task("APPROVED"), []).ok).toBe(false);
    expect(onTaskReviewed("REQUEST_ADJUSTMENT", "", live, task("IN_REVIEW"), []).ok).toBe(false);
  });
  it("accepting goes SHARED -> IN_PROGRESS with balance waiting", () => {
    expect(onAcceptedCleaning({ status: "SHARED", serviceType: "CLEANING" })).toEqual({
      ok: true,
      agreementStatus: "IN_PROGRESS",
      balanceStatus: "WAITING_DELIVERY",
    });
    expect(onAcceptedCleaning({ status: "IN_PROGRESS", serviceType: "CLEANING" }).ok).toBe(false);
    expect(onAcceptedCleaning({ status: "SHARED", serviceType: "GENERIC" }).ok).toBe(false);
  });
  it("allTasksApproved needs at least one task", () => {
    expect(allTasksApproved([])).toBe(false);
    expect(allTasksApproved(st("APPROVED", "IN_REVIEW"))).toBe(false);
    expect(allTasksApproved(st("APPROVED"))).toBe(true);
  });
});

describe("next actions", () => {
  const s = (agreementStatus: any, balanceStatus: any, ...t: TaskStatus[]) =>
    ({ agreementStatus, balanceStatus, tasks: st(...t) }) as const;
  it("seller", () => {
    expect(computeCleaningSellerNextAction(s("DRAFT", "WAITING_DELIVERY", "TODO"))).toBe("SHARE");
    expect(computeCleaningSellerNextAction(s("SHARED", "WAITING_DELIVERY", "TODO"))).toBe("WAIT_ACCEPTANCE");
    expect(computeCleaningSellerNextAction(s("IN_PROGRESS", "WAITING_DELIVERY", "IN_REVIEW", "TODO"))).toBe("UPLOAD_EVIDENCE");
    expect(computeCleaningSellerNextAction(s("IN_PROGRESS", "WAITING_DELIVERY", "IN_REVIEW", "NEEDS_ADJUSTMENT"))).toBe("UPLOAD_EVIDENCE");
    expect(computeCleaningSellerNextAction(s("IN_PROGRESS", "WAITING_DELIVERY", "IN_REVIEW", "APPROVED"))).toBe("WAIT_REVIEW");
    expect(computeCleaningSellerNextAction(s("IN_PROGRESS", "READY_TO_CHARGE", "APPROVED"))).toBe("WAIT_BALANCE");
    expect(computeCleaningSellerNextAction(s("IN_PROGRESS", "AWAITING_PAYMENT", "APPROVED"))).toBe("WAIT_BALANCE");
    expect(computeCleaningSellerNextAction(s("COMPLETED", "PAID", "APPROVED"))).toBe("DONE");
  });
  it("buyer", () => {
    expect(computeCleaningBuyerNextAction(s("SHARED", "WAITING_DELIVERY", "TODO"))).toBe("ACCEPT");
    expect(computeCleaningBuyerNextAction(s("IN_PROGRESS", "WAITING_DELIVERY", "TODO", "IN_REVIEW"))).toBe("REVIEW");
    expect(computeCleaningBuyerNextAction(s("IN_PROGRESS", "WAITING_DELIVERY", "TODO", "APPROVED"))).toBe("WAIT_DELIVERY");
    expect(computeCleaningBuyerNextAction(s("IN_PROGRESS", "READY_TO_CHARGE", "APPROVED"))).toBe("PAY_BALANCE");
    expect(computeCleaningBuyerNextAction(s("IN_PROGRESS", "AWAITING_PAYMENT", "APPROVED"))).toBe("PAY_BALANCE");
    expect(computeCleaningBuyerNextAction(s("COMPLETED", "PAID", "APPROVED"))).toBe("DONE");
  });
});

describe("acceptance criteria text", () => {
  it("lists the tasks", () => {
    expect(buildCleaningAcceptanceCriteria([{ title: "Limpiar baño" }, { title: "Trapear pisos" }])).toBe(
      "Cada tarea se revisa y aprueba por separado: 1) Limpiar baño; 2) Trapear pisos.",
    );
  });
});

describe("terms snapshot", () => {
  const base = {
    code: "TR-0001",
    title: "Limpieza de departamento",
    description: "",
    acceptanceCriteria: "criterios",
    buyerName: "Mariana",
    totalCents: 70_000,
    advanceCents: 0,
    sellerDisplayName: "Rosa",
    payeeAlias: "Cuenta demo",
    payeeLast4: "1234",
  };
  const tasks = [
    { position: 1, title: "Limpiar baño", description: null },
    { position: 2, title: "Limpiar cocina" },
  ];
  it("CLEANING includes serviceType and tasks, with advance 0", () => {
    const snap = buildTermsSnapshot({ ...base, serviceType: "CLEANING", tasks });
    expect(snap.advanceCents).toBe(0);
    expect(snap.balanceCents).toBe(70_000);
    expect(snap.serviceType).toBe("CLEANING");
    expect(snap.tasks).toEqual([
      { position: 1, title: "Limpiar baño", description: null },
      { position: 2, title: "Limpiar cocina", description: null },
    ]);
  });
  it("hash changes when a task changes", async () => {
    const a = await hashTerms(buildTermsSnapshot({ ...base, serviceType: "CLEANING", tasks }));
    const b = await hashTerms(
      buildTermsSnapshot({ ...base, serviceType: "CLEANING", tasks: [tasks[0]!, { position: 2, title: "Limpiar cocina y sala" }] }),
    );
    const c = await hashTerms(buildTermsSnapshot({ ...base, serviceType: "CLEANING", tasks }));
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
  it("GENERIC snapshot has no new keys (hash unchanged)", () => {
    const snap = buildTermsSnapshot({ ...base, advanceCents: 20_000, serviceType: "GENERIC", tasks });
    expect(Object.keys(snap)).not.toContain("serviceType");
    expect(Object.keys(snap)).not.toContain("tasks");
    expect(snap).toEqual(buildTermsSnapshot({ ...base, advanceCents: 20_000 }));
  });
  it("CLEANING rejects a non-zero advance", () => {
    expect(() => buildTermsSnapshot({ ...base, advanceCents: 100, serviceType: "CLEANING", tasks })).toThrow(RangeError);
  });
});

describe("create schemas", () => {
  const ok = {
    serviceType: "CLEANING" as const,
    buyerName: "Mariana",
    totalCents: 70_000,
    tasks: [{ title: "Limpiar baño" }, { title: " Limpiar cocina ", description: "  x " }],
  };
  it("applies defaults and trims", () => {
    const r = CreateCleaningAgreementInputSchema.parse(ok);
    expect(r.title).toBe("Limpieza de departamento");
    expect(r.description).toBe("");
    expect(r.tasks[1]).toEqual({ title: "Limpiar cocina", description: "x" });
  });
  it("rejects 0 and 9 tasks, long titles, bad totals", () => {
    expect(CreateCleaningAgreementInputSchema.safeParse({ ...ok, tasks: [] }).success).toBe(false);
    const nine = Array.from({ length: TASK_LIMITS.maxTasks + 1 }, (_, i) => ({ title: `Tarea ${i}` }));
    expect(CreateCleaningAgreementInputSchema.safeParse({ ...ok, tasks: nine }).success).toBe(false);
    expect(CreateCleaningAgreementInputSchema.safeParse({ ...ok, tasks: [{ title: "x".repeat(81) }] }).success).toBe(false);
    expect(CreateCleaningAgreementInputSchema.safeParse({ ...ok, totalCents: 0 }).success).toBe(false);
  });
  it("rejects duplicate titles case-insensitively", () => {
    const r = CreateCleaningAgreementInputSchema.safeParse({
      ...ok,
      tasks: [{ title: "Limpiar baño" }, { title: "limpiar BAÑO" }],
    });
    expect(r.success).toBe(false);
  });
  it("CreateAny dispatches and keeps generic unchanged", () => {
    expect((CreateAnyAgreementInputSchema.parse(ok) as { serviceType?: string }).serviceType).toBe("CLEANING");
    const generic = {
      title: "Portón",
      acceptanceCriteria: "criterios",
      buyerName: "Ana",
      totalCents: 100_000,
      advanceCents: 30_000,
    };
    expect(CreateAnyAgreementInputSchema.parse(generic)).toEqual(CreateAgreementInputSchema.parse(generic));
    expect(CreateAnyAgreementInputSchema.safeParse({ ...generic, advanceCents: 0 }).success).toBe(false);
    expect(CreateAnyAgreementInputSchema.safeParse({ ...ok, tasks: [] }).success).toBe(false);
  });
  it("adjustment request needs a reason", () => {
    expect(RequestAdjustmentRequestSchema.safeParse({ reason: "ab" }).success).toBe(false);
    expect(RequestAdjustmentRequestSchema.safeParse({ reason: "Falta el espejo" }).success).toBe(true);
  });
});

describe("routes, events, mcp", () => {
  it("exposes new routes", () => {
    expect(API_ROUTES.agreementTaskEvidence("a", "t")).toBe("/api/agreements/a/tasks/t/evidence");
    expect(API_ROUTES.agreementTaskEvidenceItem("a", "t", "e")).toBe("/api/agreements/a/tasks/t/evidence/e");
    expect(API_ROUTES.agreementTaskSubmit("a", "t")).toBe("/api/agreements/a/tasks/t/submit");
    expect(API_ROUTES.publicTaskApprove("tok", "t")).toBe("/api/public/tratos/tok/tasks/t/approve");
    expect(API_ROUTES.publicTaskRequestAdjustment("tok", "t")).toBe("/api/public/tratos/tok/tasks/t/request-adjustment");
    expect(APP_ROUTES.newCleaning).toBe("/tratos/nuevo/limpieza");
  });
  it("new events are buyer-visible", () => {
    for (const t of ["TASK_SUBMITTED", "TASK_APPROVED", "TASK_ADJUSTMENT_REQUESTED", "ALL_TASKS_APPROVED"] as const) {
      expect(EVENT_TYPES).toContain(t);
      expect((BUYER_HIDDEN_EVENT_TYPES as readonly string[]).includes(t)).toBe(false);
    }
  });
  it("registers MCP tools; review_task needs reason for adjustment", () => {
    expect(MCP_TOOL_NAMES).toContain("submit_task");
    expect(MCP_TOOL_NAMES).toContain("review_task");
    const base = { buyerToken: "abcdefgh", taskId: "t1" };
    expect(ReviewTaskMcpInputSchema.safeParse({ ...base, decision: "APPROVE" }).success).toBe(true);
    expect(ReviewTaskMcpInputSchema.safeParse({ ...base, decision: "REQUEST_ADJUSTMENT" }).success).toBe(false);
    expect(ReviewTaskMcpInputSchema.safeParse({ ...base, decision: "REQUEST_ADJUSTMENT", reason: "Falta el espejo" }).success).toBe(true);
  });
});
