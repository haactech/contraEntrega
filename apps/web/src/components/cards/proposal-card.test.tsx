import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AllowedAction, ProposalView } from "@trato/shared";
import { proposalCardModel } from "@/lib/conversation";
import { proposal } from "@/lib/test-fixtures";
import { ProposalCardBody } from "./proposal-card";

function render(p: ProposalView, opts: { role: "SELLER" | "BUYER"; actions?: AllowedAction[]; active?: boolean; status?: string | null; supersededBy?: number; compact?: boolean }) {
  const model = proposalCardModel(p, {
    role: opts.role,
    agreementStatus: opts.status ?? null,
    isActive: opts.active ?? true,
    allowedActions: opts.actions ?? [],
    supersededBy: opts.supersededBy ?? 2,
  });
  return renderToStaticMarkup(<ProposalCardBody proposal={p} model={model} compact={opts.compact} acceptSlot={<button>ACCEPT-SLOT</button>} />);
}

describe("ProposalCardBody", () => {
  it("shows terms with money formatting, criteria as bullets, version and status", () => {
    const html = render(proposal(), { role: "SELLER", actions: ["CONFIRM_PROPOSAL"] });
    expect(html).toContain("Puerta de herrería");
    expect(html).toContain("$20,000");
    expect(html).toContain("$8,000");
    expect(html).toContain("$12,000");
    expect(html).toContain("versión 1");
    expect(html).toContain("<li>Medidas 90x210</li>");
    expect(html).toContain("Mariana");
  });

  it("seller with an open active proposal gets «Confirmo y compartir» and no accept button", () => {
    const html = render(proposal(), { role: "SELLER", actions: ["CONFIRM_PROPOSAL"] });
    expect(html).toContain("Confirmo y compartir");
    expect(html).not.toContain("ACCEPT-SLOT");
  });

  it("buyer gets the accept slot and the «sí» note only for a confirmed proposal on a SHARED agreement", () => {
    const html = render(proposal({ status: "SELLER_CONFIRMED" }), { role: "BUYER", actions: ["ACCEPT_TERMS"], status: "SHARED" });
    expect(html).toContain("ACCEPT-SLOT");
    expect(html).toContain("sí");
    expect(html).not.toContain("Confirmo y compartir");
    const draft = render(proposal(), { role: "BUYER" });
    expect(draft).not.toContain("ACCEPT-SLOT");
  });

  it("SUPERSEDED is dimmed and struck through with «Reemplazada por la versión N» and no actions", () => {
    const html = render(proposal({ status: "SUPERSEDED" }), { role: "SELLER", active: false, actions: ["CONFIRM_PROPOSAL"], supersededBy: 3 });
    expect(html).toContain("opacity-60");
    expect(html).toContain("line-through");
    expect(html).toContain("Reemplazada por la versión 3");
    expect(html).not.toContain("Confirmo y compartir");
  });

  it("compact mode hides actions and criteria", () => {
    const html = render(proposal(), { role: "SELLER", actions: ["CONFIRM_PROPOSAL"], compact: true });
    expect(html).not.toContain("Confirmo y compartir");
    expect(html).not.toContain("Criterios de entrega");
    expect(html).toContain("$20,000");
  });
});
