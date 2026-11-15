import { CheckCircle2, FileDown } from "lucide-react";
import { API_ROUTES, formatMxn } from "@trato/shared";
import { Card, CardTitle } from "@/components/ui/card";
import type { CardCtx } from "./types";

/** Completed: short summary and «Exportar comprobante». */
export function CompletedCard({ ctx }: { ctx: CardCtx }) {
  const a = ctx.view.agreement;
  if (!a) return null;
  const href =
    ctx.source.role === "SELLER" ? API_ROUTES.agreementExport(a.agreement.id) : API_ROUTES.publicExport(ctx.source.token);
  return (
    <Card className="space-y-2 border-emerald-300 bg-emerald-50 text-center">
      <CheckCircle2 className="mx-auto size-10 text-brand-700" aria-hidden />
      <CardTitle>Trato completado</CardTitle>
      <p className="text-sm text-slate-800">
        {a.agreement.title} · {formatMxn(a.agreement.totalCents)}. Anticipo y saldo pagados. El comprobante incluye la conversación,
        las versiones de la propuesta, las evidencias, las revisiones y los pagos.
      </p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-700 px-5 font-semibold text-white"
      >
        <FileDown className="size-5" aria-hidden /> Exportar comprobante
      </a>
    </Card>
  );
}
