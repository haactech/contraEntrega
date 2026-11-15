import { TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { sellerAgreement } from "@/lib/conversation";
import { DeliverCard } from "./deliver-card";
import type { CardCtx } from "./types";

/** Dispute: the buyer's reason (as reported, no judgement) and, for the seller, the redelivery CTA. */
export function DisputeCard({ ctx }: { ctx: CardCtx }) {
  const a = ctx.view.agreement;
  if (!a) return null;
  const dispute = [...a.reviews].reverse().find((r) => r.decision === "DISPUTE");
  const canRedeliver =
    ctx.view.role === "SELLER" &&
    sellerAgreement(ctx.view) !== null &&
    (ctx.view.allowedActions.includes("REDELIVER") || ctx.view.allowedActions.includes("UPLOAD_EVIDENCE"));
  return (
    <div className="space-y-2">
      <Card className="space-y-2 border-red-300 bg-red-50">
        <p className="flex items-center gap-2 font-bold text-red-800">
          <TriangleAlert className="size-5" aria-hidden /> Problema reportado
          {dispute ? ` por ${dispute.buyerName}` : ""}
        </p>
        {dispute?.comment ? (
          <blockquote className="whitespace-pre-wrap border-l-4 border-red-300 pl-3 text-slate-900">{dispute.comment}</blockquote>
        ) : (
          <p className="text-sm text-slate-800">El comprador reportó un problema con la entrega.</p>
        )}
        {ctx.view.role === "BUYER" && (
          <p className="text-sm text-slate-800">El prestador puede corregir y volver a entregar. Te avisaremos aquí.</p>
        )}
      </Card>
      {canRedeliver && <DeliverCard ctx={ctx} redelivery />}
    </div>
  );
}
