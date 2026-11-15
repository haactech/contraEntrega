import { buyerAgreement } from "@/lib/conversation";
import { PaymentPanel } from "@/routes/buyer/payment-panel";
import type { CardCtx } from "./types";

/**
 * Payment card (advance or balance). Reuses the v0.2 `PaymentPanel` (QR, push, «Ya pagué,
 * verificar», demo simulation). The balance after approval is titled «Liberar el saldo».
 */
export function PaymentCard({ ctx, milestone }: { ctx: CardCtx; milestone: "ADVANCE" | "BALANCE" }) {
  const ba = buyerAgreement(ctx.view);
  if (!ba || ctx.source.role !== "BUYER") return null;
  const m = ba.milestones.find((x) => x.kind === milestone);
  if (!m) return null;
  return (
    <PaymentPanel
      token={ctx.source.token}
      milestone={m}
      activeRequest={ba.activePaymentRequest}
      viewVersion={ba.agreement.version}
      release={milestone === "BALANCE" && m.approvedAt !== null}
      onChanged={() => void ctx.refresh()}
    />
  );
}
