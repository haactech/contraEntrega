import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ListChecks, TriangleAlert } from "lucide-react";
import { ReviewRequestSchema, formatMxn } from "@trato/shared";
import { api } from "@/lib/api";
import { buyerAgreement } from "@/lib/conversation";
import { parseCriteria } from "@/lib/criteria";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { ErrorBox } from "@/components/layout";
import { Gallery } from "@/routes/buyer/gallery";
import type { CardCtx } from "./types";

/** Reading checklist of the agreement's delivery criteria. Local only: it never changes state. */
export function CriteriaChecklist({ criteria }: { criteria: readonly string[] }) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  if (criteria.length === 0) return null;
  return (
    <fieldset className="space-y-1">
      <legend className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
        <ListChecks className="size-4" aria-hidden /> Criterios de entrega
      </legend>
      <p className="text-xs text-slate-600">Para tu revisión: marca lo que ya verificaste en las fotos. No se envía.</p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {criteria.map((c) => (
          <li key={c}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={checked.has(c)}
                onChange={(e) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c);
                    else next.delete(c);
                    return next;
                  })
                }
                className="mt-0.5 size-5 shrink-0 accent-brand-700"
              />
              <span className={checked.has(c) ? "text-slate-600 line-through" : ""}>{c}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Buyer: review the delivery (photos, note, criteria checklist) and approve or report a problem. */
export function DeliveryCard({ ctx }: { ctx: CardCtx }) {
  const ba = buyerAgreement(ctx.view);
  const token = ctx.source.role === "BUYER" ? ctx.source.token : null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | undefined>();
  const [busy, setBusy] = useState<"APPROVE" | "DISPUTE" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastForced = useRef(0);

  // A chip («Recibido, todo bien» / «Reportar problema») opens the matching dialog.
  const nonce = ctx.reviewRequest?.nonce;
  const kind = ctx.reviewRequest?.kind;
  useEffect(() => {
    if (!nonce || !kind) return;
    if (kind === "APPROVE") setConfirmOpen(true);
    else setProblemOpen(true);
  }, [nonce, kind]);

  if (!ba || !token) return null;
  const balance = ba.milestones.find((m) => m.kind === "BALANCE");
  const round = balance?.deliveryRound ?? 0;
  const photos = ba.evidence.filter((e) => balance && e.milestoneId === balance.id && e.deliveryRound === round);
  const noteRaw = [...ba.events].reverse().find((e) => e.type === "REVIEW_REQUESTED")?.payload["note"];
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw : null;
  const criteria = parseCriteria(ba.agreement.acceptanceCriteria);
  const buyerName = ba.agreement.buyerAcceptedName ?? ba.agreement.buyerName;

  // Signed photo URLs expire; a failed image forces a full (non-304) refresh, throttled.
  function onImageError() {
    const now = Date.now();
    if (now - lastForced.current < 30_000) return;
    lastForced.current = now;
    void ctx.refresh();
  }

  async function send(decision: "APPROVE" | "DISPUTE") {
    if (!token) return;
    setError(null);
    setCommentError(undefined);
    const parsed = ReviewRequestSchema.safeParse(
      decision === "APPROVE" ? { decision, buyerName } : { decision, buyerName, comment },
    );
    if (!parsed.success) {
      setCommentError(parsed.error.issues[0]?.message);
      return;
    }
    setBusy(decision);
    try {
      await api.submitReview(token, parsed.data);
      setConfirmOpen(false);
      setProblemOpen(false);
      setComment("");
      await ctx.refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3 border-brand-600">
      <CardTitle>El prestador entregó el trabajo</CardTitle>
      {photos.length > 0 ? (
        <Gallery items={photos} onImageError={onImageError} />
      ) : (
        <p className="text-sm text-slate-700">No hay fotos en esta entrega.</p>
      )}
      {note && (
        <blockquote className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800">
          <span className="mb-0.5 block text-xs font-bold text-slate-600">Nota del prestador</span>
          {note}
        </blockquote>
      )}
      <CriteriaChecklist criteria={criteria} />
      {error && !confirmOpen && !problemOpen && <ErrorBox message={error} />}
      <Button size="lg" block onClick={() => setConfirmOpen(true)}>
        <CheckCircle2 className="size-5" aria-hidden /> Recibido, todo bien
      </Button>
      <Button size="lg" block variant="outline" onClick={() => setProblemOpen(true)}>
        <TriangleAlert className="size-5" aria-hidden /> Reportar problema
      </Button>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="¿Recibiste el trabajo?">
        <div className="space-y-3">
          <p>
            Confirmas que el trabajo cumple lo acordado. Esto no paga el saldo: después podrás liberarlo (
            {formatMxn(balance?.amountCents ?? 0)}).
          </p>
          {error && <ErrorBox message={error} />}
          <Button size="lg" block loading={busy === "APPROVE"} onClick={() => void send("APPROVE")}>
            Sí, todo bien
          </Button>
          <Button size="lg" block variant="ghost" onClick={() => setConfirmOpen(false)}>
            Volver
          </Button>
        </div>
      </Dialog>

      <Dialog open={problemOpen} onClose={() => setProblemOpen(false)} title="Reportar un problema">
        <div className="space-y-3">
          <Field
            id="problem"
            label="¿Qué pasó?"
            hint="Entre 5 y 1000 caracteres. El prestador podrá corregir y volver a entregar."
            error={commentError}
          >
            <Textarea
              id="problem"
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
              invalid={!!commentError}
              aria-describedby="problem-msg"
            />
          </Field>
          {error && <ErrorBox message={error} />}
          <Button size="lg" block loading={busy === "DISPUTE"} onClick={() => void send("DISPUTE")}>
            Enviar reporte
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
