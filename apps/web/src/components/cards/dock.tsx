import { useState } from "react";
import type { FeedMessage, ProposalView } from "@trato/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { friendlyError } from "@/lib/errors";
import {
  activeCards,
  buyerAgreement,
  proposalCardModel,
  sellerAgreement,
  supersededByVersion,
  type DockCard,
  type DockKind,
} from "@/lib/conversation";
import { AcceptForm, ProposalCardBody } from "./proposal-card";
import { PaymentCard } from "./payment-card";
import { DeliveryCard } from "./delivery-card";
import { DisputeCard } from "./dispute-card";
import { CompletedCard } from "./completed-card";
import { DeliverCard } from "./deliver-lazy";
import { ChecklistCard } from "./checklist-card";
import type { CardCtx } from "./types";

/** Proposal card wired to the room: confirm/share (seller) or accept (buyer). */
export function ProposalContainer({ ctx, proposal, compact }: { ctx: CardCtx; proposal: ProposalView; compact: boolean }) {
  const { view, source } = ctx;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isActive = view.activeProposal?.id === proposal.id;
  const model = proposalCardModel(proposal, {
    role: view.role,
    agreementStatus: view.agreement?.agreement.status ?? null,
    isActive,
    allowedActions: view.allowedActions,
    supersededBy: supersededByVersion(view.feed, proposal),
  });

  async function confirm() {
    if (source.role !== "SELLER") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.confirmProposal(source.conversationId, proposal.id);
      ctx.applyView(r.conversation);
      ctx.onShare({ shareUrl: r.shareUrl, whatsappUrl: r.whatsappUrl });
    } catch (e) {
      setError(friendlyError(e));
      void ctx.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function shareAgain() {
    const sa = sellerAgreement(view);
    if (!sa) return;
    if (sa.shareUrl && sa.whatsappUrl) {
      ctx.onShare({ shareUrl: sa.shareUrl, whatsappUrl: sa.whatsappUrl });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.shareAgreement(sa.agreement.id);
      ctx.onShare({ shareUrl: r.shareUrl, whatsappUrl: r.whatsappUrl });
      await ctx.refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const ba = buyerAgreement(view);
  return (
    <ProposalCardBody
      proposal={proposal}
      model={model}
      compact={compact}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onShareAgain={() => void shareAgain()}
      onOpen={() => ctx.onFocusCard("proposal")}
      acceptSlot={
        source.role === "BUYER" && ba ? (
          <AcceptForm
            token={source.token}
            termsSha256={ba.agreement.termsSha256}
            onDone={ctx.refresh}
            singlePayment={ba.serviceType === "CLEANING"}
          />
        ) : null
      }
    />
  );
}

/** A proposal message in the transcript: the active one is compact (its actions live in the dock). */
export function FeedProposal({ ctx, item }: { ctx: CardCtx; item: FeedMessage }) {
  if (!item.proposal) return null;
  const isActive = ctx.view.activeProposal?.id === item.proposal.id;
  return (
    <ProposalContainer
      ctx={ctx}
      proposal={item.proposal}
      compact={isActive && activeCards(ctx.view).some((c) => c.kind === "proposal")}
    />
  );
}

function renderCard(card: DockCard, ctx: CardCtx) {
  switch (card.kind) {
    case "proposal":
      return ctx.view.activeProposal ? <ProposalContainer ctx={ctx} proposal={ctx.view.activeProposal} compact={false} /> : null;
    case "payment":
      return <PaymentCard ctx={ctx} milestone={card.milestone} />;
    case "delivery":
      return <DeliveryCard ctx={ctx} />;
    case "deliver":
      return <DeliverCard ctx={ctx} />;
    case "dispute":
      return <DisputeCard ctx={ctx} />;
    case "completed":
      return <CompletedCard ctx={ctx} />;
    case "checklist":
      return <ChecklistCard ctx={ctx} />;
  }
}

const LABEL: Record<DockKind, string> = {
  proposal: "Propuesta",
  payment: "Pago",
  delivery: "Entrega",
  deliver: "Entregar trabajo",
  dispute: "Problema reportado",
  completed: "Trato completado",
  checklist: "Checklist",
};

/** Active cards anchored above the composer so the pending action is always visible. */
export function Dock({ ctx, flash }: { ctx: CardCtx; collapsed: boolean; flash: DockKind | null }) {
  const cards = activeCards(ctx.view);
  return (
    <>
      {cards.map((c) => (
        <section
          key={c.kind === "payment" ? `payment-${c.milestone}` : c.kind}
          id={`card-${c.kind}`}
          tabIndex={-1}
          aria-label={LABEL[c.kind]}
          className={cn("scroll-mt-2 rounded-2xl outline-none transition-shadow", flash === c.kind && "ring-4 ring-brand-600/60")}
        >
          {renderCard(c, ctx)}
        </section>
      ))}
    </>
  );
}
