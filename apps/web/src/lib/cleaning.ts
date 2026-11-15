import {
  CLEANING_TEMPLATE,
  CreateCleaningAgreementInputSchema,
  TASK_LIMITS,
  formatMxn,
  type AgreementStatus,
  type EvidenceView,
  type MilestoneStatus,
  type ProposalTerms,
  type TaskView,
} from "@trato/shared";

/* ------------------------------------------------------------------ task helpers */

export function unfinishedTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((t) => t.status === "TODO" || t.status === "NEEDS_ADJUSTMENT");
}

/** Photos of the attempt in progress (current revision, AFTER kind). */
export function currentAfterPhotos(task: Pick<TaskView, "evidence" | "revision">): EvidenceView[] {
  return task.evidence.filter((e) => e.kind === "AFTER" && e.revisionNumber === task.revision);
}

export interface PhotoGroup {
  revision: number;
  photos: EvidenceView[];
  current: boolean;
}

/** Photos grouped by attempt, latest first. The current attempt is always listed first (even if empty is skipped). */
export function groupPhotosByRevision(task: Pick<TaskView, "evidence" | "revision">): PhotoGroup[] {
  const by = new Map<number, EvidenceView[]>();
  for (const e of task.evidence) {
    const rev = e.revisionNumber ?? 1;
    by.set(rev, [...(by.get(rev) ?? []), e]);
  }
  return [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([revision, photos]) => ({ revision, photos, current: revision === task.revision }));
}

/** Last adjustment reason, only meaningful while the task needs an adjustment. */
export function lastAdjustment(task: Pick<TaskView, "status" | "reviews">): { comment: string; reviewer: string } | null {
  if (task.status !== "NEEDS_ADJUSTMENT") return null;
  const r = [...task.reviews].reverse().find((x) => x.decision === "REQUEST_ADJUSTMENT");
  return r ? { comment: r.comment ?? "", reviewer: r.reviewerName } : null;
}

/* ------------------------------------------------------------------ primary action */

export type ChecklistPrimary =
  | { kind: "SHARE"; label: string }
  | { kind: "WAIT_ACCEPT"; label: string }
  | { kind: "WORK"; label: string; taskId: string }
  | { kind: "WAIT_REVIEW"; label: string }
  | { kind: "READY_TO_CHARGE"; label: string }
  | { kind: "REVIEW"; label: string; taskId: string; count: number }
  | { kind: "PAY"; label: string }
  | { kind: "WAIT_SELLER"; label: string }
  | { kind: "PAID"; label: string };

export interface PrimaryInput {
  role: "SELLER" | "BUYER";
  agreementStatus: AgreementStatus;
  balanceStatus: MilestoneStatus | null;
  tasks: readonly TaskView[];
  totalCents: number;
  /** The other party (seller sees the client's name, buyer sees the provider's). */
  counterpartName: string;
}

/** The single contextual action shown at the top of the checklist, per role. */
export function checklistPrimary(i: PrimaryInput): ChecklistPrimary {
  const paid = i.agreementStatus === "COMPLETED" || i.balanceStatus === "PAID";
  if (paid) return { kind: "PAID", label: "PAGADO" };
  const allApproved = i.tasks.length > 0 && i.tasks.every((t) => t.status === "APPROVED");
  const inReview = i.tasks.filter((t) => t.status === "IN_REVIEW");

  if (i.role === "SELLER") {
    if (i.agreementStatus === "DRAFT") return { kind: "SHARE", label: `Comparte el enlace con ${i.counterpartName}` };
    if (i.agreementStatus === "SHARED") return { kind: "WAIT_ACCEPT", label: `Esperando a que ${i.counterpartName} acepte` };
    const next = unfinishedTasks(i.tasks)[0];
    if (next) {
      return {
        kind: "WORK",
        taskId: next.id,
        label: next.status === "NEEDS_ADJUSTMENT" ? `Corregir: ${next.title}` : `Siguiente: ${next.title}`,
      };
    }
    if (inReview.length > 0) return { kind: "WAIT_REVIEW", label: `Esperando a que ${i.counterpartName} revise` };
    if (allApproved) return { kind: "READY_TO_CHARGE", label: "Listo para cobrar" };
    return { kind: "WAIT_REVIEW", label: `Esperando a que ${i.counterpartName} revise` };
  }

  if (i.agreementStatus === "DRAFT" || i.agreementStatus === "SHARED") {
    return { kind: "WAIT_ACCEPT", label: "Revisa la lista y acepta el trabajo" };
  }
  const first = inReview[0];
  if (first) {
    return {
      kind: "REVIEW",
      taskId: first.id,
      count: inReview.length,
      label: `Revisar ${inReview.length} ${inReview.length === 1 ? "tarea" : "tareas"}`,
    };
  }
  if (allApproved) return { kind: "PAY", label: `Pagar ${formatMxn(i.totalCents)}` };
  return { kind: "WAIT_SELLER", label: `Esperando a que ${i.counterpartName} termine` };
}

/* ------------------------------------------------------------------ proposal tasks (chat) */

const CRITERIA_PREFIX = "Cada tarea se revisa y aprueba por separado:";

export interface ProposalTask {
  title: string;
  description?: string | null;
}

/**
 * Tasks of a CLEANING proposal. Prefers explicit `terms.tasks` (when the contract exposes them) and
 * otherwise recovers the list from the generated acceptance criteria («Cada tarea se revisa…: 1) A; 2) B.»).
 */
export function proposalCleaningTasks(terms: ProposalTerms): ProposalTask[] | null {
  const explicit = (terms as { tasks?: unknown; serviceType?: unknown }).tasks;
  const st = (terms as { serviceType?: unknown }).serviceType;
  if (Array.isArray(explicit) && explicit.length > 0 && (st === undefined || st === "CLEANING")) {
    return explicit.filter((t): t is ProposalTask => typeof t === "object" && t !== null && typeof (t as ProposalTask).title === "string");
  }
  if (st === "GENERIC") return null;
  const c = terms.acceptanceCriteria.trim();
  if (!c.startsWith(CRITERIA_PREFIX)) return null;
  const list = c.slice(CRITERIA_PREFIX.length).trim().replace(/\.$/, "");
  const tasks = list
    .split(";")
    .map((x) => x.replace(/^\s*\d+\)\s*/, "").trim())
    .filter(Boolean)
    .map((title) => ({ title }));
  return tasks.length > 0 ? tasks : null;
}

/* ------------------------------------------------------------------ creation form */

export const ROOM_TEMPLATE_EXAMPLE =
  "Limpieza del departamento para Mariana, $700: baño, cocina, trapear pisos y ventanas";

export interface FormTask {
  key: string;
  title: string;
  description: string;
  enabled: boolean;
  custom: boolean;
}

export function templateFormTasks(): FormTask[] {
  return CLEANING_TEMPLATE.tasks.map((t, i) => ({
    key: `tpl-${i}`,
    title: t.title,
    description: t.description,
    enabled: t.enabledByDefault,
    custom: false,
  }));
}

export interface CleaningFormValues {
  total: string;
  buyerName: string;
  buyerPhone: string;
  dueDate: string;
  tasks: readonly FormTask[];
}

export type CleaningFormErrors = Partial<Record<"totalCents" | "buyerName" | "buyerPhone" | "dueDate" | "tasks", string>>;

/** Validates with the shared schema and builds the exact POST /api/agreements payload. */
export function buildCleaningPayload(
  v: CleaningFormValues,
  totalCents: number | null,
):
  | { ok: true; payload: ReturnType<typeof CreateCleaningAgreementInputSchema.parse> }
  | { ok: false; errors: CleaningFormErrors } {
  const errors: CleaningFormErrors = {};
  const enabled = v.tasks.filter((t) => t.enabled);
  if (totalCents === null) {
    errors.totalCents = v.total.trim() === "" ? "Escribe cuánto cobras." : "Escribe un monto válido, por ejemplo 700.";
  }
  if (enabled.length < TASK_LIMITS.minTasks) errors.tasks = "Elige al menos una tarea.";
  const r = CreateCleaningAgreementInputSchema.safeParse({
    serviceType: "CLEANING",
    title: CLEANING_TEMPLATE.title,
    buyerName: v.buyerName,
    ...(v.buyerPhone === "" ? {} : { buyerPhone: v.buyerPhone }),
    ...(v.dueDate === "" ? {} : { dueDate: v.dueDate }),
    totalCents: totalCents ?? Number.NaN,
    tasks: enabled.map((t) => {
      const description = t.description.trim();
      return description ? { title: t.title, description } : { title: t.title };
    }),
  });
  if (!r.success) {
    for (const issue of r.error.issues) {
      const k = issue.path[0];
      if (k === "totalCents" || k === "buyerName" || k === "buyerPhone" || k === "dueDate" || k === "tasks") {
        errors[k] ??= issue.message;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !r.success) return { ok: false, errors };
  return { ok: true, payload: r.data };
}
