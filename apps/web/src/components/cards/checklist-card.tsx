import { buyerAgreement, sellerAgreement } from "@/lib/conversation";
import { TaskChecklistContainer } from "@/components/tasks/checklist-container";
import type { CardCtx } from "./types";

/**
 * CLEANING dock card: progress + the single contextual action; the full task list opens on demand.
 * Per-task actions (photos, send, approve, ask for adjustment) are the same ones as on /tratos/:id.
 */
export function ChecklistCard({ ctx }: { ctx: CardCtx }) {
  const sa = sellerAgreement(ctx.view);
  const ba = buyerAgreement(ctx.view);
  if (sa && ctx.source.role === "SELLER") {
    return (
      <TaskChecklistContainer
        role="SELLER"
        view={sa}
        compact
        refresh={ctx.refresh}
        {...(sa.shareUrl && sa.whatsappUrl
          ? { onShare: () => ctx.onShare({ shareUrl: sa.shareUrl ?? "", whatsappUrl: sa.whatsappUrl ?? "" }) }
          : {})}
      />
    );
  }
  if (ba && ctx.source.role === "BUYER") {
    return (
      <TaskChecklistContainer
        role="BUYER"
        view={ba}
        token={ctx.source.token}
        compact
        refresh={ctx.refresh}
        onPay={() => ctx.onFocusCard("payment")}
      />
    );
  }
  return null;
}
