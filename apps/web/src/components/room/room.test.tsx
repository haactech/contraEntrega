import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { ConversationView } from "@trato/shared";
import { ToastProvider } from "@/components/ui/toast";
import { Room } from "./room";
import {
  actions,
  buyerAgreementFixture,
  conversationView,
  eventItem,
  proposal,
  sellerAgreementFixture,
  proposalMsg,
  textMsg,
} from "@/lib/test-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: '"e1"' }, ...init });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // jsdom-less happy-dom lacks these.
  Element.prototype.scrollTo = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mount(view: ConversationView, source: Parameters<typeof Room>[0]["source"]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url.includes("/health") ? json({ ok: true, mode: "live", assistant: view.assistant }) : json(view))),
  );
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <Room source={source} />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("Room", () => {
  it("seller: renders bubbles, event cards, docked proposal with confirm button and chips", async () => {
    const p = proposal();
    const view = conversationView({
      feed: [
        textMsg("m1", 1, 0, "SELLER", "Puerta para Mariana, 20 mil"),
        proposalMsg("m2", 2, 1, p),
        eventItem("e1", 1, 2, "AGREEMENT_SHARED"),
      ],
      activeProposal: p,
      allowedActions: actions("CONFIRM_PROPOSAL"),
      assistantBusy: true,
    });
    await mount(view, { role: "SELLER", conversationId: "c1" });
    const text = host.textContent ?? "";
    expect(text).toContain("Puerta para Mariana, 20 mil");
    expect(text).toContain("Asistente IA · puede equivocarse; los estados oficiales están en las tarjetas");
    expect(text).toContain("Enlace compartido con el comprador");
    expect(text).toContain("Trato está escribiendo…");
    expect(text).toContain("Confirmo y compartir");
    expect(host.querySelector('[data-action="CONFIRM_PROPOSAL"]')?.textContent).toBe("Confirmar propuesta");
    expect(host.querySelector('[role="log"]')?.getAttribute("aria-live")).toBe("polite");
    expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("Escribe un mensaje…");
  });

  it("seller empty room: placeholder and tappable suggestions", async () => {
    await mount(conversationView(), { role: "SELLER", conversationId: "c1" });
    expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "Cuéntale a Trato qué vas a hacer, para quién y cuánto cobras",
    );
    expect(host.textContent).toContain("Puerta de herrería para Mariana, 20 mil, 8 mil para empezar, la entrego el viernes");
  });

  it("buyer: accept form appears for a confirmed proposal on a shared agreement; no camera button", async () => {
    const p = proposal({ status: "SELLER_CONFIRMED" });
    const view = conversationView({
      role: "BUYER",
      feed: [proposalMsg("m1", 1, 0, p)],
      activeProposal: p,
      agreement: buyerAgreementFixture(),
      allowedActions: actions("ACCEPT_TERMS", "EXPORT"),
    });
    await mount(view, { role: "BUYER", token: "tok" });
    expect(host.textContent).toContain("Acepto este acuerdo");
    expect(host.textContent).toContain("Escribir \"sí\" no acepta el trato");
    expect(host.querySelector('[aria-label="Adjuntar foto de la entrega"]')).toBeNull();
  });

  it("seller: confirmar la versión 1 (sin acuerdo previo) abre la hoja de compartir con el shareUrl de la respuesta", async () => {
    const p = proposal();
    const before = conversationView({
      feed: [proposalMsg("m1", 1, 0, p)],
      activeProposal: p,
      allowedActions: actions("CONFIRM_PROPOSAL"),
    });
    const sa = sellerAgreementFixture({ conversationId: "c1" });
    const after = conversationView({
      feed: [proposalMsg("m1", 1, 0, { ...p, status: "SELLER_CONFIRMED" })],
      activeProposal: { ...p, status: "SELLER_CONFIRMED" },
      agreement: sa,
      allowedActions: actions("SHARE_LINK", "EXPORT"),
    });
    const shareUrl = "https://trato.test/t/abc123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/health")) return json({ ok: true, mode: "live", assistant: before.assistant });
        if (init?.method === "POST" && url.includes("/confirm")) {
          return json({ conversation: after, shareUrl, whatsappUrl: "https://wa.me/?text=hola" });
        }
        return json(before);
      }),
    );
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ToastProvider>
            <Room source={{ role: "SELLER", conversationId: "c1" }} />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmo y compartir"));
    expect(btn).toBeTruthy();
    await act(async () => {
      btn?.click();
      await new Promise((r) => setTimeout(r, 50));
    });
    const dialog = host.querySelector("dialog");
    expect(dialog?.textContent).toContain(shareUrl);
    expect(dialog?.hasAttribute("open")).toBe(true);
  });
});

describe("Room: limpieza", () => {
  const SHA = "a".repeat(64);
  const task = (id: string, title: string, status: "TODO" | "IN_REVIEW" | "APPROVED", position: number) => ({
    id, position, title, description: null, status, revision: 1, submittedAt: null, approvedAt: null,
    evidence: status === "IN_REVIEW"
      ? [{ id: `e-${id}`, milestoneId: "m1", deliveryRound: 0, url: "https://img/x.jpg", mimeType: "image/jpeg", sizeBytes: 1, sha256: SHA, submitted: true, taskId: id, kind: "AFTER" as const, revisionNumber: 1, createdAt: at0 }]
      : [],
    reviews: [],
  });
  const at0 = "2026-11-15T10:00:00.000Z";
  const balance = { id: "m1", kind: "BALANCE" as const, amountCents: 70_000, description: "Pago al terminar", status: "WAITING_DELIVERY" as const, deliveryRound: 0, approvedAt: null, paidAt: null };

  it("vendedor: la tarjeta Checklist reemplaza la de entrega y no ofrece aprobar", async () => {
    const tasks = [task("t1", "Limpiar baño", "TODO", 1), task("t2", "Limpiar cocina", "IN_REVIEW", 2)];
    const view = conversationView({
      agreement: sellerAgreementFixture({
        agreement: { ...sellerAgreementFixture().agreement, status: "IN_PROGRESS", title: "Limpieza de departamento", totalCents: 70_000 },
        serviceType: "CLEANING", paymentStrategy: "ON_COMPLETION", tasks, taskProgress: { approved: 0, total: 2 },
        milestones: [balance], conversationId: "c1", nextAction: "UPLOAD_EVIDENCE",
      }),
      allowedActions: actions("SUBMIT_TASK", "EXPORT"),
    });
    await mount(view, { role: "SELLER", conversationId: "c1" });
    const text = host.textContent ?? "";
    expect(text).toContain("Limpieza de departamento · $700.00");
    expect(text).toContain("0/2 tareas aprobadas");
    expect(text).toContain("Siguiente: Limpiar baño");
    expect(text).not.toContain("Ya terminé");
    expect(host.querySelector('[data-action="SUBMIT_TASK"]')?.textContent).toBe("Enviar para revisión");
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "Aprobar")).toBe(false);
  });

  it("cliente: con todo aprobado ve «Pagar $700» y el pago único", async () => {
    const tasks = [task("t1", "Limpiar baño", "APPROVED", 1), task("t2", "Limpiar cocina", "APPROVED", 2)];
    const view = conversationView({
      role: "BUYER",
      agreement: buyerAgreementFixture({
        agreement: { ...buyerAgreementFixture().agreement, status: "IN_PROGRESS", title: "Limpieza de departamento", totalCents: 70_000 },
        serviceType: "CLEANING", paymentStrategy: "ON_COMPLETION", tasks, taskProgress: { approved: 2, total: 2 },
        milestones: [{ ...balance, status: "READY_TO_CHARGE" }], nextAction: "PAY_BALANCE",
      }),
      allowedActions: actions("PAY_BALANCE", "EXPORT"),
    });
    await mount(view, { role: "BUYER", token: "tok" });
    const text = host.textContent ?? "";
    expect(text).toContain("2/2 tareas aprobadas");
    expect(host.querySelector('[data-primary="PAY"]')?.textContent).toBe("Pagar $700.00");
    expect(text).toContain("Aprobaste todas las tareas");
    expect(text).not.toContain("anticipo");
    expect(Array.from(host.querySelectorAll("button")).some((b) => /Subir foto|Enviar para revisión/.test(b.textContent ?? ""))).toBe(false);
  });
});
