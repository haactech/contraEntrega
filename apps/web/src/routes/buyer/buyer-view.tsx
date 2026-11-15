import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { CheckCircle2, FileDown, Hourglass, PartyPopper, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  API_ROUTES,
  AcceptAgreementRequestSchema,
  ReviewRequestSchema,
  formatMxn,
  type BuyerAgreementView,
  type MilestoneKind,
  type MilestoneView,
} from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { usePolling } from "@/hooks/use-polling";
import { BUYER_ACTION_TEXT, MILESTONE_STATUS_LABEL, MILESTONE_TITLE, formatDate } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorBox, NoCustodyNotice, Page } from "@/components/layout";
import { Timeline } from "@/components/timeline";
import { Gallery } from "./gallery";
import { PaymentPanel } from "./payment-panel";

export default function BuyerRoute() {
  const { token = "" } = useParams();
  const etag = useRef<string | null>(null);

  const { data, error, loading, refresh, setData } = usePolling<BuyerAgreementView>(
    async (prev, signal) => {
      if (!prev) etag.current = null;
      const r = await api.getPublicAgreement(token, etag.current, signal);
      if (r.notModified) return null;
      etag.current = r.etag;
      return r.data;
    },
    (d) => d?.activePaymentRequest?.status === "AWAITING_PAYMENT",
    [token],
  );

  const accept = useCallback(
    (v: BuyerAgreementView) => {
      etag.current = `"v${v.agreement.version}"`;
      setData(v);
    },
    [setData],
  );

  // Signed evidence URLs expire after 15 min and a 304 would keep the stale ones:
  // force a GET without If-None-Match on image errors (throttled) or after a long hidden spell.
  const lastForced = useRef(0);
  const forceRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastForced.current < 30_000) return;
    lastForced.current = now;
    etag.current = null;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt > 10 * 60_000) {
        hiddenAt = null;
        forceRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [forceRefresh]);

  // Detect transitions to PAID to confirm clearly ("Anticipo recibido" / "Saldo pagado").
  const prevPaid = useRef<Set<MilestoneKind> | null>(null);
  const [justPaid, setJustPaid] = useState<MilestoneKind | null>(null);
  useEffect(() => {
    if (!data) return;
    const paid = new Set(data.milestones.filter((m) => m.status === "PAID").map((m) => m.kind));
    if (prevPaid.current) {
      for (const k of paid) if (!prevPaid.current.has(k)) setJustPaid(k);
    }
    prevPaid.current = paid;
  }, [data]);
  useEffect(() => {
    prevPaid.current = null;
    setJustPaid(null);
  }, [token]);

  useEffect(() => {
    if (data) document.title = `Trato ${data.agreement.code}`;
  }, [data]);

  if (loading && !data) {
    return (
      <Page>
        <PageSkeleton />
      </Page>
    );
  }
  if (!data) {
    const notFound = isApiError(error, "NOT_FOUND");
    return (
      <Page>
        <ErrorBox
          message={notFound ? "Este enlace no es válido o ya no está activo. Pide uno nuevo al prestador." : friendlyError(error)}
          onRetry={notFound ? undefined : () => void refresh()}
        />
      </Page>
    );
  }

  const advance = data.milestones.find((m) => m.kind === "ADVANCE");
  const balance = data.milestones.find((m) => m.kind === "BALANCE");
  const a = data.agreement;
  const done = data.nextAction === "DONE" || a.status === "COMPLETED";
  const round = balance?.deliveryRound ?? 0;
  const deliveryPhotos = data.evidence.filter((e) => balance && e.milestoneId === balance.id && e.deliveryRound === round);
  const showDelivery = deliveryPhotos.length > 0 && (data.nextAction === "REVIEW" || data.nextAction === "PAY_BALANCE" || done);

  return (
    <Page>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-600">
          {a.code} · {data.seller.displayName} ({data.seller.trade})
        </p>
        <h1 className="text-2xl font-extrabold leading-tight">{a.title}</h1>
      </div>

      {error ? (
        <p role="status" className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">
          Sin conexión. Seguimos intentando…
        </p>
      ) : null}

      <div role="status" aria-live="polite" className="space-y-2">
        {justPaid && (
          <div className="flex items-start gap-3 rounded-2xl border-2 border-brand-700 bg-brand-50 p-4">
            <PartyPopper className="size-7 shrink-0 text-brand-700" aria-hidden />
            <div>
              <p className="text-lg font-extrabold text-brand-800">
                {justPaid === "ADVANCE" ? "Anticipo recibido" : "Saldo pagado"}
              </p>
              <p className="text-sm text-slate-800">
                {justPaid === "ADVANCE"
                  ? "Tu pago llegó. El prestador ya puede empezar el trabajo."
                  : "Tu pago llegó. Gracias por cerrar el trato."}
              </p>
            </div>
          </div>
        )}
      </div>

      <NextActionCard view={data} />

      {data.nextAction === "ACCEPT" && (
        <>
          <TermsCard view={data} advance={advance} balance={balance} />
          <AcceptCard token={token} view={data} onDone={accept} />
        </>
      )}

      {data.nextAction === "PAY_ADVANCE" && advance && (
        <PaymentPanel
          token={token}
          milestone={advance}
          activeRequest={data.activePaymentRequest}
          viewVersion={a.version}
          onChanged={() => void refresh()}
        />
      )}

      {showDelivery && (
        <Card className="space-y-3">
          <CardTitle>Entrega del prestador</CardTitle>
          <Gallery items={deliveryPhotos} onImageError={forceRefresh} />
          {latestReviewRequestNote(data) && (
            <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800">{latestReviewRequestNote(data)}</p>
          )}
        </Card>
      )}

      {data.nextAction === "REVIEW" && <ReviewCard token={token} view={data} onDone={accept} />}

      {data.nextAction === "PAY_BALANCE" && balance && (
        <PaymentPanel
          token={token}
          milestone={balance}
          activeRequest={data.activePaymentRequest}
          viewVersion={a.version}
          onChanged={() => void refresh()}
        />
      )}

      {done && (
        <Card className="space-y-3 text-center">
          <CheckCircle2 className="mx-auto size-12 text-brand-700" aria-hidden />
          <CardTitle>Trato completado</CardTitle>
          <p className="text-sm text-slate-700">Guarda el comprobante con las condiciones, pagos y fotos.</p>
          <ExportLink token={token} />
        </Card>
      )}

      {data.nextAction !== "ACCEPT" && <TermsCard view={data} advance={advance} balance={balance} />}

      <Card className="space-y-3">
        <CardTitle>Historial</CardTitle>
        <Timeline events={data.events} milestones={data.milestones} />
        {!done && <ExportLink token={token} subtle />}
      </Card>

      <NoCustodyNotice />
    </Page>
  );
}

function latestReviewRequestNote(view: BuyerAgreementView): string | null {
  const ev = [...view.events].reverse().find((e) => e.type === "REVIEW_REQUESTED");
  const note = ev?.payload["note"];
  return typeof note === "string" && note.trim() ? note : null;
}

function ExportLink({ token, subtle }: { token: string; subtle?: boolean }) {
  return (
    <a
      href={API_ROUTES.publicExport(token)}
      target="_blank"
      rel="noopener noreferrer"
      className={
        subtle
          ? "inline-flex min-h-11 items-center gap-2 font-semibold text-brand-800 underline"
          : "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-700 px-5 font-semibold text-white"
      }
    >
      <FileDown className="size-5" aria-hidden /> Exportar comprobante
    </a>
  );
}

function NextActionCard({ view }: { view: BuyerAgreementView }) {
  const waiting = ["WAIT_DELIVERY", "WAIT_SELLER"].includes(view.nextAction);
  return (
    <div
      className={
        "flex items-start gap-3 rounded-2xl p-4 " +
        (view.nextAction === "DONE" ? "bg-brand-50" : waiting ? "bg-slate-100" : "bg-brand-100")
      }
    >
      {waiting ? (
        <Hourglass className="size-6 shrink-0 text-slate-600" aria-hidden />
      ) : (
        <ShieldCheck className="size-6 shrink-0 text-brand-700" aria-hidden />
      )}
      <p className="font-semibold">{BUYER_ACTION_TEXT[view.nextAction]}</p>
    </div>
  );
}

function TermsCard({
  view,
  advance,
  balance,
}: {
  view: BuyerAgreementView;
  advance: MilestoneView | undefined;
  balance: MilestoneView | undefined;
}) {
  const a = view.agreement;
  return (
    <Card className="space-y-4">
      <CardTitle>Condiciones del acuerdo</CardTitle>
      {a.description && (
        <div>
          <h3 className="text-sm font-bold text-slate-600">Descripción</h3>
          <p className="whitespace-pre-wrap">{a.description}</p>
        </div>
      )}
      <div>
        <h3 className="text-sm font-bold text-slate-600">Criterios de entrega</h3>
        <p className="whitespace-pre-wrap">{a.acceptanceCriteria}</p>
      </div>
      {a.dueDate && (
        <div>
          <h3 className="text-sm font-bold text-slate-600">Fecha estimada</h3>
          <p>{formatDate(a.dueDate)}</p>
        </div>
      )}
      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200">
        {[advance, balance].map(
          (m) =>
            m && (
              <li key={m.id} className="flex items-center justify-between gap-2 p-3">
                <span>
                  <span className="block font-semibold">{MILESTONE_TITLE[m.kind]}</span>
                  <Badge tone={MILESTONE_STATUS_LABEL[m.status].tone}>{MILESTONE_STATUS_LABEL[m.status].label}</Badge>
                </span>
                <span className="font-bold">{formatMxn(m.amountCents)}</span>
              </li>
            ),
        )}
        <li className="flex justify-between p-3 font-extrabold">
          <span>Total</span>
          <span>{formatMxn(a.totalCents)}</span>
        </li>
      </ul>
      <div className="rounded-xl bg-slate-100 p-3 text-sm">
        <p>
          <span className="font-bold">Quién cobra:</span> {view.seller.displayName} · {view.payee.alias} ••••{" "}
          {view.payee.last4}
        </p>
        <p className="mt-1">
          <span className="font-bold">Huella del acuerdo:</span>{" "}
          <span className="font-mono">{a.termsSha256.slice(0, 8)}</span>{" "}
          <span className="text-slate-600">(identifica estas condiciones exactas)</span>
        </p>
      </div>
    </Card>
  );
}

function AcceptCard({
  token,
  view,
  onDone,
}: {
  token: string;
  view: BuyerAgreementView;
  onDone: (v: BuyerAgreementView) => void;
}) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNameError(undefined);
    const parsed = AcceptAgreementRequestSchema.safeParse({
      buyerName: name,
      termsSha256: view.agreement.termsSha256,
      consent,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === "buyerName") setNameError(issue.message);
      else setError(issue?.message ?? "Revisa los datos.");
      return;
    }
    setBusy(true);
    try {
      onDone(await api.acceptAgreement(token, parsed.data));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <CardTitle>Aceptar el acuerdo</CardTitle>
        <p className="text-sm text-slate-700">
          Al aceptar, confirmas que leíste las condiciones de abajo. Aceptar no es un pago: el anticipo se paga en el siguiente paso.
        </p>
        <Field id="accept-name" label="Tu nombre completo" error={nameError}>
          <Input
            id="accept-name"
            autoComplete="name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            invalid={!!nameError}
            aria-describedby="accept-name-msg"
          />
        </Field>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 size-6 shrink-0 accent-brand-700"
          />
          <span>
            Leí y acepto las condiciones del acuerdo (huella <span className="font-mono">{view.agreement.termsSha256.slice(0, 8)}</span>).
          </span>
        </label>
        {error && <ErrorBox message={error} />}
        <Button type="submit" size="lg" block loading={busy} disabled={!consent || name.trim().length < 2}>
          Aceptar acuerdo
        </Button>
      </form>
    </Card>
  );
}

function ReviewCard({
  token,
  view,
  onDone,
}: {
  token: string;
  view: BuyerAgreementView;
  onDone: (v: BuyerAgreementView) => void;
}) {
  const buyerName = view.agreement.buyerAcceptedName ?? view.agreement.buyerName;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | undefined>();
  const [busy, setBusy] = useState<"APPROVE" | "DISPUTE" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(decision: "APPROVE" | "DISPUTE") {
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
      const v = await api.submitReview(token, parsed.data);
      setConfirmOpen(false);
      setProblemOpen(false);
      onDone(v);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3">
      <CardTitle>¿Cómo quedó el trabajo?</CardTitle>
      <p className="text-sm text-slate-700">Revisa las fotos y los criterios de entrega.</p>
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
            Confirmas que el trabajo cumple lo acordado. Esto no paga el saldo: después podrás pagarlo
            ({formatMxn(view.milestones.find((m) => m.kind === "BALANCE")?.amountCents ?? 0)}).
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
