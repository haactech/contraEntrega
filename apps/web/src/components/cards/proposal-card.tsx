import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Share2 } from "lucide-react";
import { AcceptAgreementRequestSchema, formatMxn, type ProposalView } from "@trato/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { parseCriteria } from "@/lib/criteria";
import { proposalCleaningTasks } from "@/lib/cleaning";
import { friendlyError } from "@/lib/errors";
import { formatDate } from "@/lib/labels";
import { YES_NOTE, type ProposalCardModel } from "@/lib/conversation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";

function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
      {message}
    </p>
  );
}

/**
 * Presentational proposal card. Buttons come from the pure `proposalCardModel` so role/state
 * rules live in one tested place; behaviour is injected through `acceptSlot` and the handlers.
 */
export function ProposalCardBody({
  proposal,
  model,
  compact = false,
  busy = false,
  error,
  onConfirm,
  onShareAgain,
  acceptSlot,
  onOpen,
}: {
  proposal: ProposalView;
  model: ProposalCardModel;
  compact?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm?: () => void;
  onShareAgain?: () => void;
  /** Rendered when `model.primary === "ACCEPT"` (the buyer's name + consent form). */
  acceptSlot?: ReactNode;
  /** Compact mode: bring the full card (docked above the composer) into view. */
  onOpen?: () => void;
}) {
  const t = proposal.terms;
  const criteria = parseCriteria(t.acceptanceCriteria);
  const tasks = proposalCleaningTasks(t);
  const strike = model.strike ? "line-through decoration-slate-400" : "";

  return (
    <article
      aria-label={`Propuesta versión ${proposal.version}: ${t.title}`}
      data-status={proposal.status}
      className={cn(
        "space-y-3 rounded-2xl border bg-white p-4 shadow-sm",
        model.dimmed ? "border-slate-200 opacity-60" : "border-brand-600",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-600">Propuesta · versión {proposal.version}</span>
        <Badge tone={model.tone}>{model.statusLabel}</Badge>
      </div>
      <h3 className={cn("text-lg font-extrabold leading-tight", strike)}>{t.title}</h3>

      {model.strike && model.banner && <p className="text-sm font-semibold text-slate-700">{model.banner}</p>}

      {compact ? (
        tasks ? (
          <p className={cn("text-sm text-slate-800", strike)}>
            Total <b>{formatMxn(t.totalCents)}</b> · pago único al terminar · <b>{tasks.length}</b> {tasks.length === 1 ? "tarea" : "tareas"}
          </p>
        ) : (
          <p className={cn("text-sm text-slate-800", strike)}>
            Total <b>{formatMxn(t.totalCents)}</b> · anticipo <b>{formatMxn(t.advanceCents)}</b> · saldo <b>{formatMxn(t.balanceCents)}</b>
          </p>
        )
      ) : (
        <>
          {t.description && <p className={cn("whitespace-pre-wrap text-sm text-slate-800", strike)}>{t.description}</p>}
          {tasks && (
            <div>
              <h4 className="text-sm font-bold text-slate-600">Tareas</h4>
              <ul aria-label="Tareas de la limpieza" className={cn("mt-1 list-disc space-y-0.5 pl-5 text-sm", strike)}>
                {tasks.map((task) => (
                  <li key={task.title}>{task.title}</li>
                ))}
              </ul>
            </div>
          )}
          {!tasks && criteria.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-slate-600">Criterios de entrega</h4>
              <ul className={cn("mt-1 list-disc space-y-0.5 pl-5 text-sm", strike)}>
                {criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {tasks ? (
            <dl className={cn("grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-center", strike)}>
              <div>
                <dt className="text-xs font-semibold text-slate-600">Total</dt>
                <dd className="font-extrabold">{formatMxn(t.totalCents)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-600">Pago</dt>
                <dd className="font-extrabold">Pago único al terminar</dd>
              </div>
            </dl>
          ) : (
            <dl className={cn("grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-center", strike)}>
              <div>
                <dt className="text-xs font-semibold text-slate-600">Total</dt>
                <dd className="font-extrabold">{formatMxn(t.totalCents)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-600">Anticipo</dt>
                <dd className="font-extrabold">{formatMxn(t.advanceCents)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-600">Saldo</dt>
                <dd className="font-extrabold">{formatMxn(t.balanceCents)}</dd>
              </div>
            </dl>
          )}
          <p className={cn("text-sm text-slate-700", strike)}>
            Para <b>{t.buyerName}</b>
            {t.dueDate ? ` · entrega ${formatDate(t.dueDate)}` : " · sin fecha de entrega"}
          </p>
        </>
      )}

      {!model.strike && model.banner && (
        <p role="status" className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-800">
          {model.banner}
        </p>
      )}
      {error && <ErrorBox message={error} />}

      {!compact && model.primary === "CONFIRM_AND_SHARE" && (
        <Button size="lg" block loading={busy} onClick={onConfirm}>
          <Check className="size-5" aria-hidden /> Confirmo y compartir
        </Button>
      )}
      {!compact && model.primary === "SHARE_AGAIN" && (
        <Button size="lg" block variant="outline" loading={busy} onClick={onShareAgain}>
          <Share2 className="size-5" aria-hidden /> Compartir enlace
        </Button>
      )}
      {!compact && model.primary === "ACCEPT" && acceptSlot}
      {!compact && model.showYesNote && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">{YES_NOTE}</p>
      )}
      {compact && onOpen && model.primary !== null && (
        <Button variant="secondary" block onClick={onOpen}>
          Ver la tarjeta para actuar
        </Button>
      )}
    </article>
  );
}

/** Buyer: name + consent -> `POST accept` with the agreement's current `termsSha256`. */
export function AcceptForm({
  token,
  termsSha256,
  onDone,
  singlePayment = false,
}: {
  token: string;
  termsSha256: string;
  onDone: () => void | Promise<void>;
  /** Cleaning: single payment at the end, no advance. */
  singlePayment?: boolean;
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
    const parsed = AcceptAgreementRequestSchema.safeParse({ buyerName: name, termsSha256, consent });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === "buyerName") setNameError(issue.message);
      else setError(issue?.message ?? "Revisa los datos.");
      return;
    }
    setBusy(true);
    try {
      await api.acceptAgreement(token, parsed.data);
      await onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
      <p className="text-sm text-slate-700">
        {singlePayment
          ? "Aceptar no es un pago: pagas una sola vez, cuando apruebes todas las tareas."
          : "Aceptar no es un pago: el anticipo se paga en el siguiente paso."}
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
          Leí y acepto las condiciones de esta propuesta (huella <span className="font-mono">{termsSha256.slice(0, 8)}</span>).
        </span>
      </label>
      {error && <ErrorBox message={error} />}
      <Button type="submit" size="lg" block loading={busy} disabled={!consent || name.trim().length < 2}>
        Acepto este acuerdo
      </Button>
    </form>
  );
}
