import { describe, expect, it } from "vitest";
import { eventText } from "./events";

describe("eventText (limpieza)", () => {
  it("usa el microcopy de tareas", () => {
    const p = { taskTitle: "Limpiar baño" };
    expect(eventText({ type: "TASK_SUBMITTED", payload: p }).title).toBe("Listo para revisar: Limpiar baño");
    expect(eventText({ type: "TASK_APPROVED", payload: p }).title).toBe("Tarea aprobada: Limpiar baño");
    expect(eventText({ type: "TASK_ADJUSTMENT_REQUESTED", payload: { ...p, comment: "Falta el espejo" } }).title).toBe(
      "Hace falta un ajuste en Limpiar baño: “Falta el espejo”",
    );
    expect(eventText({ type: "ALL_TASKS_APPROVED", payload: {} }).title).toBe("Trabajo aprobado. Ya puedes pagar");
  });

  it("adapta creación, solicitud de pago y pago en CLEANING sin tocar lo genérico", () => {
    const c = { cleaning: true };
    expect(eventText({ type: "AGREEMENT_CREATED", payload: {} }, [], c).title).toBe("Así quedó el trabajo acordado");
    expect(eventText({ type: "PAYMENT_REQUEST_CREATED", payload: {} }, [], c).title).toBe(
      "Solicitud de pago lista; falta autorizar el pago",
    );
    expect(eventText({ type: "PAYMENT_CONFIRMED", payload: {} }, [], c).title).toBe("PAGADO");
    expect(eventText({ type: "AGREEMENT_CREATED", payload: {} }).title).toBe("Trato creado");
    expect(eventText({ type: "PAYMENT_CONFIRMED", payload: {} }).title).toBe("Pago confirmado");
  });
});
