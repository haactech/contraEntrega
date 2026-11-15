import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ToastProvider } from "@/components/ui/toast";
import { buildCleaningPayload, templateFormTasks } from "@/lib/cleaning";
import { byText, click, setValue } from "@/lib/dom-test";
import { sellerAgreementFixture } from "@/lib/test-fixtures";
import NewCleaningRoute from "./new-cleaning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("buildCleaningPayload", () => {
  const base = { total: "700", buyerName: "Mariana", buyerPhone: "", dueDate: "", tasks: templateFormTasks() };

  it("arma el payload CLEANING con solo las tareas activas", () => {
    const r = buildCleaningPayload(base, 70_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.serviceType).toBe("CLEANING");
    expect(r.payload.totalCents).toBe(70_000);
    expect(r.payload.tasks.map((t) => t.title)).toEqual(["Limpiar baño", "Limpiar cocina", "Trapear pisos", "Limpiar ventanas"]);
  });

  it("exige nombre, precio y entre 1 y 8 tareas", () => {
    const none = base.tasks.map((t) => ({ ...t, enabled: false }));
    const r = buildCleaningPayload({ ...base, buyerName: "", tasks: none }, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.buyerName).toBeTruthy();
    expect(r.errors.totalCents).toBeTruthy();
    expect(r.errors.tasks).toBe("Elige al menos una tarea.");

    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, title: `Tarea ${i}`, description: "", enabled: true, custom: true }));
    const r9 = buildCleaningPayload({ ...base, tasks: nine }, 70_000);
    expect(r9.ok).toBe(false);
  });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + JSON.stringify((l.state as { share?: unknown } | null)?.share ?? null)}</p>;
}

describe("NewCleaningRoute", () => {
  it("muestra $700 por defecto, valida y envía crear + compartir y navega con la hoja abierta", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
        if (url.endsWith("/share")) return ok({ shareUrl: "https://t/x", whatsappUrl: "https://wa/x", agreement: sellerAgreementFixture({ conversationId: "c1" }) });
        return ok(sellerAgreementFixture({ conversationId: "c1" }));
      }),
    );
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/tratos/nuevo/limpieza"]}>
          <ToastProvider>
            <Routes>
              <Route path="/tratos/nuevo/limpieza" element={<NewCleaningRoute />} />
              <Route path="/tratos/:id" element={<Where />} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    // lazy-free route: wait for first paint
    expect((host.querySelector("#total") as HTMLInputElement).value).toBe("700");
    const submit = byText(host, "button[type=submit]", "Crear y compartir trato");
    expect(submit).not.toBeNull();

    // sin nombre: muestra error y no llama a la API
    await click(submit);
    expect(host.textContent).toContain("Escribe el nombre del cliente.");
    expect(calls.length).toBe(0);

    await act(async () => setValue(host.querySelector("#buyerName") as HTMLInputElement, "Mariana"));
    await act(async () => setValue(host.querySelector("#new-task") as HTMLInputElement, "Limpiar balcón"));
    await click(byText(host, "button", "Agregar"));
    await click(byText(host, "button[type=submit]", "Crear y compartir trato"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const create = calls.find((c) => c.url === "/api/agreements");
    expect(create?.body).toMatchObject({
      serviceType: "CLEANING",
      buyerName: "Mariana",
      totalCents: 70_000,
      tasks: [{ title: "Limpiar baño" }, { title: "Limpiar cocina" }, { title: "Trapear pisos" }, { title: "Limpiar ventanas" }, { title: "Limpiar balcón" }],
    });
    expect(host.querySelector("[data-testid=where]")?.textContent).toContain(`/tratos/${sellerAgreementFixture().agreement.id}{"shareUrl":"https://t/x"`);
  });
});
