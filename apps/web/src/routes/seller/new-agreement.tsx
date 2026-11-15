import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import {
  APP_ROUTES,
  CreateAgreementInputSchema,
  checkSplit,
  formatMxn,
  type CreateAgreementInput,
} from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { centsToInputValue, parseMxnToCents, percentOfCents } from "@/lib/money";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ErrorBox, NoCustodyNotice, Page } from "@/components/layout";
import type { ShareLinks } from "./share-sheet";

const PRESETS = [30, 50, 70] as const;

export interface AgreementLocationState {
  share?: ShareLinks;
}

type Errors = Partial<Record<keyof CreateAgreementInput, string>>;

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function NewAgreementRoute() {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [total, setTotal] = useState("");
  const [advance, setAdvance] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const totalCents = parseMxnToCents(total);
  const advanceCents = parseMxnToCents(advance);

  const input = useMemo(
    () => ({
      title,
      description,
      acceptanceCriteria: criteria,
      buyerName,
      buyerPhone: buyerPhone === "" ? undefined : buyerPhone,
      dueDate: dueDate === "" ? undefined : dueDate,
      totalCents: totalCents ?? Number.NaN,
      advanceCents: advanceCents ?? Number.NaN,
    }),
    [title, description, criteria, buyerName, buyerPhone, dueDate, totalCents, advanceCents],
  );

  const errors: Errors = useMemo(() => {
    const out: Errors = {};
    const r = CreateAgreementInputSchema.safeParse(input);
    if (!r.success) {
      for (const issue of r.error.issues) {
        const key = issue.path[0] as keyof CreateAgreementInput | undefined;
        if (key && !out[key]) out[key] = issue.message;
      }
    }
    if (totalCents === null) {
      out.totalCents = total === "" ? "Escribe el total del trato." : "Escribe un monto válido, por ejemplo 1500 o 1500.50.";
    }
    if (advanceCents === null) {
      out.advanceCents = advance === "" ? "Elige o escribe el anticipo." : "Escribe un monto válido.";
    }
    return out;
  }, [input, total, advance, totalCents, advanceCents]);

  const split = totalCents !== null && advanceCents !== null ? checkSplit(totalCents, advanceCents) : null;
  const show = (k: keyof CreateAgreementInput, touched: boolean) => (submitted || touched ? errors[k] : undefined);
  const [touched, setTouched] = useState<Partial<Record<keyof CreateAgreementInput, boolean>>>({});
  const touch = (k: keyof CreateAgreementInput) => () => setTouched((t) => ({ ...t, [k]: true }));

  function applyPreset(pct: number) {
    if (totalCents === null) return;
    setAdvance(centsToInputValue(percentOfCents(totalCents, pct)));
    setTouched((t) => ({ ...t, advanceCents: true }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const parsed = CreateAgreementInputSchema.safeParse(input);
    if (!parsed.success || Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const created = await api.createAgreement(parsed.data);
      const id = created.agreement.id;
      try {
        const shared = await api.shareAgreement(id);
        const state: AgreementLocationState = {
          share: { shareUrl: shared.shareUrl, whatsappUrl: shared.whatsappUrl },
        };
        navigate(APP_ROUTES.agreement(id), { state });
      } catch {
        toast.show("El trato se creó, pero no pudimos generar el enlace. Inténtalo desde el detalle.", "error");
        navigate(APP_ROUTES.agreement(id));
      }
    } catch (err) {
      if (isApiError(err, "UNAUTHORIZED")) navigate(APP_ROUTES.home);
      setFormError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const activePct = PRESETS.find(
    (p) => totalCents !== null && advanceCents !== null && percentOfCents(totalCents, p) === advanceCents,
  );

  return (
    <Page
      title="Nuevo trato"
      back={
        <Link to={APP_ROUTES.home} aria-label="Volver" className="grid size-11 place-items-center rounded-full hover:bg-slate-200">
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
        <Field id="title" label="¿Qué vas a hacer?" error={show("title", !!touched.title)} hint="Ej. Reja de herrería para ventana">
          <Input id="title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onBlur={touch("title")}
            invalid={!!show("title", !!touched.title)} aria-describedby="title-msg" />
        </Field>
        <Field id="description" label="Descripción (opcional)" error={show("description", !!touched.description)}>
          <Textarea id="description" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)}
            onBlur={touch("description")} invalid={!!show("description", !!touched.description)} />
        </Field>
        <Field id="criteria" label="Criterios de entrega" error={show("acceptanceCriteria", !!touched.acceptanceCriteria)}
          hint="¿Cómo sabrá tu comprador que el trabajo está bien hecho?">
          <Textarea id="criteria" value={criteria} maxLength={1000} onChange={(e) => setCriteria(e.target.value)}
            onBlur={touch("acceptanceCriteria")} invalid={!!show("acceptanceCriteria", !!touched.acceptanceCriteria)}
            aria-describedby="criteria-msg" />
        </Field>
        <Field id="buyerName" label="Nombre del comprador" error={show("buyerName", !!touched.buyerName)}>
          <Input id="buyerName" autoComplete="off" value={buyerName} maxLength={80} onChange={(e) => setBuyerName(e.target.value)}
            onBlur={touch("buyerName")} invalid={!!show("buyerName", !!touched.buyerName)} aria-describedby="buyerName-msg" />
        </Field>
        <Field id="buyerPhone" label="Teléfono del comprador (opcional)" error={show("buyerPhone", !!touched.buyerPhone)}
          hint="10 dígitos. Permite que reciba la solicitud de pago en su teléfono.">
          <Input id="buyerPhone" type="tel" inputMode="numeric" autoComplete="off" value={buyerPhone} maxLength={10}
            onChange={(e) => setBuyerPhone(e.target.value.replace(/\D/g, ""))} onBlur={touch("buyerPhone")}
            invalid={!!show("buyerPhone", !!touched.buyerPhone)} aria-describedby="buyerPhone-msg" />
        </Field>
        <Field id="dueDate" label="Fecha estimada de entrega (opcional)" error={show("dueDate", !!touched.dueDate)}>
          <Input id="dueDate" type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            onBlur={touch("dueDate")} invalid={!!show("dueDate", !!touched.dueDate)} />
        </Field>

        <Card className="space-y-4">
          <Field id="total" label="Total del trato (MXN)" error={show("totalCents", !!touched.totalCents)}>
            <Input id="total" inputMode="decimal" autoComplete="off" placeholder="1500.00" value={total}
              onChange={(e) => setTotal(e.target.value)} onBlur={touch("totalCents")}
              invalid={!!show("totalCents", !!touched.totalCents)} aria-describedby="total-msg" />
          </Field>

          <div>
            <p className="mb-1 text-sm font-semibold text-slate-800" id="presets-label">Anticipo</p>
            <div role="group" aria-labelledby="presets-label" className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={totalCents === null}
                  aria-pressed={activePct === p}
                  onClick={() => applyPreset(p)}
                  className={cn(
                    "min-h-11 rounded-xl border-2 font-bold disabled:opacity-40",
                    activePct === p ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-900",
                  )}
                >
                  {p} %
                </button>
              ))}
            </div>
          </div>
          <Field id="advance" label="Monto del anticipo (MXN)" error={show("advanceCents", !!touched.advanceCents)}>
            <Input id="advance" inputMode="decimal" autoComplete="off" placeholder="750.00" value={advance}
              onChange={(e) => setAdvance(e.target.value)} onBlur={touch("advanceCents")}
              invalid={!!show("advanceCents", !!touched.advanceCents)} aria-describedby="advance-msg" />
          </Field>

          <dl className="space-y-1 rounded-xl bg-brand-50 p-3 text-sm" aria-live="polite">
            <div className="flex justify-between">
              <dt>Anticipo (al aceptar)</dt>
              <dd className="font-bold">{split?.ok ? formatMxn(split.advanceCents) : advanceCents !== null ? formatMxn(advanceCents) : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Saldo (al recibir el trabajo)</dt>
              <dd className="font-bold">{split?.ok ? formatMxn(split.balanceCents) : "—"}</dd>
            </div>
            <div className="flex justify-between border-t border-brand-100 pt-1">
              <dt>Total</dt>
              <dd className="font-bold">{totalCents !== null ? formatMxn(totalCents) : "—"}</dd>
            </div>
          </dl>
        </Card>

        {formError && <ErrorBox message={formError} />}
        <Button type="submit" size="lg" block loading={busy}>
          Crear y compartir
        </Button>
        <NoCustodyNotice />
      </form>
    </Page>
  );
}
