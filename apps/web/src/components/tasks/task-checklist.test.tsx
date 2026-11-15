import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EvidenceView, TaskView } from "@trato/shared";
import { byText, click, setValue } from "@/lib/dom-test";
import { checklistPrimary, proposalCleaningTasks } from "@/lib/cleaning";
import { TaskChecklist, type ChecklistActions, type TaskChecklistProps } from "./task-checklist";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHA = "a".repeat(64);
const photo = (id: string, revisionNumber: number, submitted = true): EvidenceView => ({
  id, milestoneId: "m1", deliveryRound: 0, url: `https://img/${id}.jpg`, mimeType: "image/jpeg", sizeBytes: 10, sha256: SHA,
  submitted, taskId: "t", kind: "AFTER", revisionNumber, createdAt: "2026-11-15T10:00:00.000Z",
});
function task(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return {
    position: 1, description: null, status: "TODO", revision: 1, submittedAt: null, approvedAt: null, evidence: [], reviews: [], ...over,
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(over: Partial<TaskChecklistProps> & Pick<TaskChecklistProps, "role" | "tasks">, actions: ChecklistActions = {}) {
  const approved = over.tasks.filter((t) => t.status === "APPROVED").length;
  return act(async () => {
    root.render(
      <TaskChecklist
        title="Limpieza de departamento"
        totalCents={70_000}
        agreementStatus="IN_PROGRESS"
        balance={{ status: "WAITING_DELIVERY", amountCents: 70_000 }}
        progress={{ approved, total: over.tasks.length }}
        counterpartName="Mariana"
        actions={actions}
        {...over}
      />,
    );
  });
}

describe("TaskChecklist: prestador", () => {
  const tasks = [
    task({ id: "t1", title: "Limpiar baño", status: "TODO" }),
    task({ id: "t2", title: "Limpiar cocina", position: 2, status: "IN_REVIEW", evidence: [photo("p1", 1)] }),
  ];

  it("muestra cabecera, progreso y estados; sin Aprobar ni Pedir ajuste", async () => {
    await mount({ role: "SELLER", tasks });
    const text = host.textContent ?? "";
    expect(text).toContain("Limpieza de departamento · $700.00");
    expect(text).toContain("0/2 tareas aprobadas");
    expect(text).toContain("Por hacer");
    expect(text).toContain("Esperando aprobación");
    expect(byText(host, "button", "Aprobar")).toBeNull();
    expect(byText(host, "button", "Pedir ajuste")).toBeNull();
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(host.querySelector("[data-primary]")?.textContent).toBe("Siguiente: Limpiar baño");
  });

  it("Enviar para revisión está deshabilitado sin fotos y se habilita con una; la subida acepta imágenes con cámara", async () => {
    await mount({ role: "SELLER", tasks });
    const submit = byText<HTMLButtonElement>(host, "button", "Enviar para revisión");
    expect(submit?.disabled).toBe(true);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toBe("image/*");
    expect(input?.getAttribute("capture")).toBe("environment");

    const submitTask = vi.fn().mockResolvedValue(undefined);
    await mount({ role: "SELLER", tasks: [task({ id: "t1", title: "Limpiar baño", evidence: [photo("p9", 1, false)] })] }, { submitTask });
    const enabled = byText<HTMLButtonElement>(host, "button", "Enviar para revisión");
    expect(enabled?.disabled).toBe(false);
    await click(enabled);
    expect(submitTask).toHaveBeenCalledOnce();
  });

  it("máximo 3 fotos por intento: deshabilita la subida", async () => {
    const t = task({ id: "t1", title: "Limpiar baño", evidence: [photo("a", 1, false), photo("b", 1, false), photo("c", 1, false)] });
    await mount({ role: "SELLER", tasks: [t] });
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
  });

  it("puede quitar una foto sin enviar", async () => {
    const removePhoto = vi.fn().mockResolvedValue(undefined);
    await mount({ role: "SELLER", tasks: [task({ id: "t1", title: "Limpiar baño", evidence: [photo("p1", 1, false)] })] }, { removePhoto });
    await click(host.querySelector('button[aria-label="Quitar foto 1"]'));
    expect(removePhoto).toHaveBeenCalledOnce();
  });

  it("resalta el último motivo de ajuste y colapsa los intentos anteriores", async () => {
    const t = task({
      id: "t1", title: "Limpiar baño", status: "NEEDS_ADJUSTMENT", revision: 2,
      evidence: [photo("old", 1)],
      reviews: [{ id: "r1", revisionNumber: 1, decision: "REQUEST_ADJUSTMENT", comment: "Falta el espejo", reviewerName: "Mariana", createdAt: "2026-11-15T10:00:00.000Z" }],
    });
    await mount({ role: "SELLER", tasks: [t] });
    expect(host.querySelector('[role="note"]')?.textContent).toContain("Falta el espejo");
    expect(host.textContent).toContain("Necesita ajuste");
    expect(host.querySelector("details summary")?.textContent).toBe("Intento 1");
    expect(host.querySelector("[data-primary]")?.textContent).toBe("Corregir: Limpiar baño");
  });

  it("todas aprobadas: Listo para cobrar", async () => {
    await mount({ role: "SELLER", tasks: [task({ id: "t1", title: "A", status: "APPROVED" })], balance: { status: "READY_TO_CHARGE", amountCents: 70_000 } });
    expect(host.querySelector("[data-primary]")?.textContent).toBe("Listo para cobrar");
    expect(host.textContent).toContain("1/1 tareas aprobadas");
  });
});

describe("TaskChecklist: cliente", () => {
  const tasks = [
    task({ id: "t1", title: "Limpiar baño", status: "IN_REVIEW", evidence: [photo("p1", 1)] }),
    task({ id: "t2", title: "Limpiar cocina", position: 2, status: "APPROVED", evidence: [photo("p2", 1)] }),
  ];

  it("no ve controles de subida; la acción principal es Revisar 1 tarea", async () => {
    await mount({ role: "BUYER", tasks, counterpartName: "Rosa" });
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(byText(host, "button", "Subir foto")).toBeNull();
    expect(byText(host, "button", "Enviar para revisión")).toBeNull();
    expect(host.querySelector("[data-primary]")?.textContent).toBe("Revisar 1 tarea");
  });

  it("Revisar expande, Aprobar pide confirmación y no paga por sí solo", async () => {
    const approveTask = vi.fn().mockResolvedValue(undefined);
    await mount({ role: "BUYER", tasks, counterpartName: "Rosa" }, { approveTask });
    expect(byText(host, "button", "Aprobar")).toBeNull();
    await click(byText(host, "button", "Revisar"));
    await click(byText(host, "button", "Aprobar"));
    expect(host.textContent).toContain("no paga por sí solo");
    expect(approveTask).not.toHaveBeenCalled();
    await click(byText(host, "button", "Sí, aprobar"));
    expect(approveTask).toHaveBeenCalledOnce();
  });

  it("Pedir ajuste exige un motivo de 3 a 500 caracteres", async () => {
    const requestAdjustment = vi.fn().mockResolvedValue(undefined);
    await mount({ role: "BUYER", tasks, counterpartName: "Rosa" }, { requestAdjustment });
    await click(byText(host, "button", "Revisar"));
    await click(byText(host, "button", "Pedir ajuste"));
    await click(byText(host, "button", "Enviar ajuste"));
    expect(requestAdjustment).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Explica brevemente qué falta.");
    await act(async () => setValue(host.querySelector("textarea") as HTMLTextAreaElement, "ab"));
    await click(byText(host, "button", "Enviar ajuste"));
    expect(requestAdjustment).not.toHaveBeenCalled();
    await act(async () => setValue(host.querySelector("textarea") as HTMLTextAreaElement, "Falta el espejo"));
    await click(byText(host, "button", "Enviar ajuste"));
    expect(requestAdjustment).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "Falta el espejo");
  });

  it("con N = M la acción principal es Pagar $700 y llama onPay", async () => {
    const onPay = vi.fn();
    await mount(
      { role: "BUYER", tasks: tasks.map((t) => ({ ...t, status: "APPROVED" as const })), counterpartName: "Rosa", balance: { status: "READY_TO_CHARGE", amountCents: 70_000 } },
      { onPay },
    );
    const primary = host.querySelector("[data-primary]");
    expect(primary?.textContent).toBe("Pagar $700.00");
    await click(primary);
    expect(onPay).toHaveBeenCalledOnce();
  });
});

describe("checklistPrimary / proposalCleaningTasks", () => {
  it("cliente: PAGADO al completar", () => {
    const p = checklistPrimary({ role: "BUYER", agreementStatus: "COMPLETED", balanceStatus: "PAID", tasks: [], totalCents: 70_000, counterpartName: "Rosa" });
    expect(p.label).toBe("PAGADO");
  });

  it("recupera las tareas de los criterios generados de la propuesta", () => {
    const terms = {
      title: "Limpieza", description: "", buyerName: "Mariana", dueDate: null, totalCents: 70_000, advanceCents: 0, balanceCents: 70_000,
      acceptanceCriteria: "Cada tarea se revisa y aprueba por separado: 1) Limpiar baño; 2) Limpiar cocina.",
    };
    expect(proposalCleaningTasks(terms)?.map((t) => t.title)).toEqual(["Limpiar baño", "Limpiar cocina"]);
    expect(proposalCleaningTasks({ ...terms, acceptanceCriteria: "Pintura pareja" })).toBeNull();
  });
});
