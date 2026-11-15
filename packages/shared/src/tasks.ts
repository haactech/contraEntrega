import type {
  AgreementStatus,
  BuyerNextAction,
  EvidenceKind,
  MilestoneStatus,
  SellerNextAction,
  ServiceType,
  TaskReviewDecision,
  TaskStatus,
} from "./enums";
import type { Fail, Ok, Result } from "./state-machine";

/* ------------------------------------------------------------- template */

export interface CleaningTemplateTask {
  title: string;
  description: string;
  enabledByDefault: boolean;
}

export const CLEANING_TEMPLATE = {
  title: "Limpieza de departamento",
  suggestedTotalCents: 70_000,
  tasks: [
    { title: "Limpiar baño", description: "Lavabo, regadera, inodoro, espejo y piso.", enabledByDefault: true },
    { title: "Limpiar cocina", description: "Estufa, barra, fregadero y gabinetes por fuera.", enabledByDefault: true },
    { title: "Trapear pisos", description: "Barrer y trapear todos los cuartos.", enabledByDefault: true },
    { title: "Limpiar ventanas", description: "Vidrios por dentro y marcos.", enabledByDefault: true },
    { title: "Sacudir y ordenar recámara", description: "Muebles sin polvo y cama tendida.", enabledByDefault: false },
    { title: "Sacar la basura", description: "Retirar la basura y cambiar bolsas.", enabledByDefault: false },
  ] as readonly CleaningTemplateTask[],
} as const;

export const TASK_LIMITS = {
  maxTasks: 8,
  minTasks: 1,
  maxAfterPerRevision: 3,
  maxBeforePerTask: 2,
  reasonMin: 3,
  reasonMax: 500,
} as const;

/* ---------------------------------------------------------------- types */

export interface CleaningAgreementSnapshot {
  status: AgreementStatus;
  serviceType: ServiceType;
}
export interface TaskSnapshot {
  status: TaskStatus;
  revision: number;
}

const fail = (code: Fail["code"], message: string): Fail => ({ ok: false, code, message });
const OK: Result = { ok: true };

function requireActiveCleaning(agreement: CleaningAgreementSnapshot): Result {
  if (agreement.serviceType !== "CLEANING") {
    return fail("INVALID_STATE", "Este trato no es de limpieza.");
  }
  if (agreement.status !== "IN_PROGRESS") {
    return fail("INVALID_STATE", "El trabajo todavía no está en curso o ya terminó.");
  }
  return OK;
}

/* --------------------------------------------------------------- guards */

export function canAddTaskEvidence(
  agreement: CleaningAgreementSnapshot,
  task: TaskSnapshot,
  kind: EvidenceKind,
  countInRevision: number,
): Result {
  const base = requireActiveCleaning(agreement);
  if (!base.ok) return base;
  if (kind === "BEFORE") {
    if (task.status !== "TODO") {
      return fail("INVALID_STATE", "Las fotos de antes solo se agregan antes de empezar la tarea.");
    }
    if (countInRevision >= TASK_LIMITS.maxBeforePerTask) {
      return fail("INVALID_STATE", `Máximo ${TASK_LIMITS.maxBeforePerTask} fotos de antes por tarea.`);
    }
    return OK;
  }
  if (task.status !== "TODO" && task.status !== "NEEDS_ADJUSTMENT") {
    return fail("INVALID_STATE", "Esta tarea ya está en revisión o aprobada; no se pueden agregar fotos.");
  }
  if (countInRevision >= TASK_LIMITS.maxAfterPerRevision) {
    return fail("INVALID_STATE", `Máximo ${TASK_LIMITS.maxAfterPerRevision} fotos por envío de la tarea.`);
  }
  return OK;
}

export function canSubmitTask(
  agreement: CleaningAgreementSnapshot,
  task: TaskSnapshot,
  afterCountInRevision: number,
): Result {
  const base = requireActiveCleaning(agreement);
  if (!base.ok) return base;
  if (task.status !== "TODO" && task.status !== "NEEDS_ADJUSTMENT") {
    return fail("INVALID_STATE", "Esta tarea ya fue enviada o aprobada.");
  }
  if (afterCountInRevision < 1) {
    return fail("INVALID_STATE", "Agrega al menos una foto del resultado antes de enviar la tarea.");
  }
  return OK;
}

export function canReviewTask(
  agreement: CleaningAgreementSnapshot,
  task: TaskSnapshot,
  decision?: TaskReviewDecision,
  reason?: string | null,
): Result {
  const base = requireActiveCleaning(agreement);
  if (!base.ok) return base;
  if (task.status !== "IN_REVIEW") {
    return fail("INVALID_STATE", "Esta tarea no está esperando tu revisión.");
  }
  if (decision === "REQUEST_ADJUSTMENT") {
    const len = (reason ?? "").trim().length;
    if (len < TASK_LIMITS.reasonMin) {
      return fail("VALIDATION_ERROR", "Explica brevemente qué falta para pedir un ajuste.");
    }
    if (len > TASK_LIMITS.reasonMax) {
      return fail("VALIDATION_ERROR", `El motivo no puede pasar de ${TASK_LIMITS.reasonMax} caracteres.`);
    }
  }
  return OK;
}

export function allTasksApproved(tasks: readonly { status: TaskStatus }[]): boolean {
  return tasks.length >= 1 && tasks.every((t) => t.status === "APPROVED");
}

/* ---------------------------------------------------------- transitions */

export type TaskSubmittedTransition = Ok & { taskStatus: "IN_REVIEW"; revision: number };

export function onTaskSubmitted(
  agreement: CleaningAgreementSnapshot,
  task: TaskSnapshot,
  afterCountInRevision: number,
): Fail | TaskSubmittedTransition {
  const g = canSubmitTask(agreement, task, afterCountInRevision);
  if (!g.ok) return g;
  return { ok: true, taskStatus: "IN_REVIEW", revision: task.revision };
}

export type TaskReviewedTransition = Ok & {
  taskStatus: "APPROVED" | "NEEDS_ADJUSTMENT";
  revision: number;
  allApproved: boolean;
  /** Present only when the last task was approved: the BALANCE milestone becomes chargeable. */
  balanceStatus?: "READY_TO_CHARGE";
};

export function onTaskReviewed(
  decision: TaskReviewDecision,
  reason: string | null | undefined,
  agreement: CleaningAgreementSnapshot,
  task: TaskSnapshot,
  otherTasks: readonly { status: TaskStatus }[],
): Fail | TaskReviewedTransition {
  const g = canReviewTask(agreement, task, decision, reason);
  if (!g.ok) return g;
  if (decision === "REQUEST_ADJUSTMENT") {
    return { ok: true, taskStatus: "NEEDS_ADJUSTMENT", revision: task.revision + 1, allApproved: false };
  }
  const allApproved = allTasksApproved([...otherTasks, { status: "APPROVED" }]);
  return {
    ok: true,
    taskStatus: "APPROVED",
    revision: task.revision,
    allApproved,
    ...(allApproved ? { balanceStatus: "READY_TO_CHARGE" as const } : {}),
  };
}

export type CleaningAcceptedTransition = Ok & {
  agreementStatus: "IN_PROGRESS";
  balanceStatus: "WAITING_DELIVERY";
};

/** Accepting a CLEANING agreement skips the advance: SHARED -> IN_PROGRESS. */
export function onAcceptedCleaning(agreement: CleaningAgreementSnapshot): Fail | CleaningAcceptedTransition {
  if (agreement.serviceType !== "CLEANING") return fail("INVALID_STATE", "Este trato no es de limpieza.");
  if (agreement.status !== "SHARED") {
    return fail(
      "INVALID_STATE",
      agreement.status === "DRAFT" ? "Este trato todavía no está disponible." : "Este acuerdo ya fue aceptado.",
    );
  }
  return { ok: true, agreementStatus: "IN_PROGRESS", balanceStatus: "WAITING_DELIVERY" };
}

/* ---------------------------------------------------------- next actions */

export interface CleaningState {
  agreementStatus: AgreementStatus;
  balanceStatus: MilestoneStatus;
  tasks: readonly { status: TaskStatus }[];
}

const payable = (b: MilestoneStatus) => b === "READY_TO_CHARGE" || b === "AWAITING_PAYMENT";

export function computeCleaningSellerNextAction(state: CleaningState): SellerNextAction {
  const { agreementStatus: a, balanceStatus: b, tasks } = state;
  if (a === "COMPLETED" || b === "PAID") return "DONE";
  switch (a) {
    case "DRAFT":
      return "SHARE";
    case "SHARED":
      return "WAIT_ACCEPTANCE";
    case "IN_PROGRESS":
      if (tasks.some((t) => t.status === "TODO" || t.status === "NEEDS_ADJUSTMENT")) return "UPLOAD_EVIDENCE";
      if (tasks.some((t) => t.status === "IN_REVIEW")) return "WAIT_REVIEW";
      return "WAIT_BALANCE";
    default:
      return "WAIT_ACCEPTANCE";
  }
}

export function computeCleaningBuyerNextAction(state: CleaningState): BuyerNextAction {
  const { agreementStatus: a, balanceStatus: b, tasks } = state;
  if (a === "COMPLETED" || b === "PAID") return "DONE";
  switch (a) {
    case "DRAFT":
      return "WAIT_SELLER";
    case "SHARED":
      return "ACCEPT";
    case "IN_PROGRESS":
      if (tasks.some((t) => t.status === "IN_REVIEW")) return "REVIEW";
      if (payable(b)) return "PAY_BALANCE";
      return "WAIT_DELIVERY";
    default:
      return "WAIT_SELLER";
  }
}

/* ------------------------------------------------------ acceptance text */

export function buildCleaningAcceptanceCriteria(tasks: readonly { title: string }[]): string {
  const list = tasks.map((t, i) => `${i + 1}) ${t.title.trim()}`).join("; ");
  return `Cada tarea se revisa y aprueba por separado: ${list}.`;
}
