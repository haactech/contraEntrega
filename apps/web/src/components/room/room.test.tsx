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
});
