import { sellerAgreement } from "@/lib/conversation";
import { EvidencePanel } from "@/routes/seller/evidence-panel";
import type { CardCtx } from "./types";

/** Seller: attach 1–3 photos and press «Ya terminé» (reuses the v0.2 evidence panel). */
export function DeliverCard({ ctx, redelivery = false }: { ctx: CardCtx; redelivery?: boolean }) {
  const sa = sellerAgreement(ctx.view);
  if (!sa) return null;
  return (
    <EvidencePanel
      view={sa}
      redelivery={redelivery}
      submitLabel="Ya terminé"
      onUpdated={ctx.refresh}
      onView={() => void ctx.refresh()}
    />
  );
}
