import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Plus, Sparkles } from "lucide-react";
import { APP_ROUTES, CLEANING_TEMPLATE, TASK_LIMITS, formatMxn } from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { buildCleaningPayload, templateFormTasks, type FormTask } from "@/lib/cleaning";
import { friendlyError } from "@/lib/errors";
import { centsToInputValue, parseMxnToCents } from "@/lib/money";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { ErrorBox, NoCustodyNotice, Page } from "@/components/layout";
import type { AgreementLocationState } from "./new-agreement";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Surface A: `/tratos/nuevo/limpieza`. Price, client, checklist and a single CTA. */
export default function NewCleaningRoute() {
  const navigate = useNavigate();
  const toast = useToast();
  const [total, setTotal] = useState(centsToInputValue(CLEANING_TEMPLATE.suggestedTotalCents));
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [tasks, setTasks] = useState<FormTask[]>(templateFormTasks);
  const [newTask, setNewTask] = useState("");
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const totalCents = parseMxnToCents(total);
  const result = useMemo(
    () => buildCleaningPayload({ total, buyerName, buyerPhone, dueDate, tasks }, totalCents),
    [total, buyerName, buyerPhone, dueDate, tasks, totalCents],
  );
  const errors = result.ok ? {} : result.errors;
  const enabledCount = tasks.filter((t) => t.enabled).length;
  const err = (k: keyof typeof errors) => (submitted ? errors[k] : undefined);

  function toggle(key: string) {
    setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, enabled: !t.enabled } : t)));
  }

  function addTask() {
    const title = newTask.trim();
    setNewTaskError(null);
    if (title.length < 2) return setNewTaskError("Escribe el nombre de la tarea.");
    if (tasks.length >= TASK_LIMITS.maxTasks) return setNewTaskError(`Máximo ${TASK_LIMITS.maxTasks} tareas.`);
    if (tasks.some((t) => t.title.toLowerCase() === title.toLowerCase())) return setNewTaskError("Esa tarea ya está en la lista.");
    setTasks((ts) => [...ts, { key: `custom-${Date.now()}-${ts.length}`, title, description: "", enabled: true, custom: true }]);
    setNewTask("");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    if (!result.ok) return;
    setBusy(true);
    try {
      const created = await api.createCleaningAgreement(result.payload);
      const id = created.agreement.id;
      try {
        const shared = await api.shareAgreement(id);
        const state: AgreementLocationState = { share: { shareUrl: shared.shareUrl, whatsappUrl: shared.whatsappUrl } };
        navigate(APP_ROUTES.agreement(id), { state });
      } catch {
        toast.show("El trato se creó, pero no pudimos generar el enlace. Inténtalo desde el detalle.", "error");
        navigate(APP_ROUTES.agreement(id));
      }
    } catch (e2) {
      if (isApiError(e2, "UNAUTHORIZED")) navigate(APP_ROUTES.home);
      setFormError(friendlyError(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Nuevo trato de limpieza"
      back={
        <Link to={APP_ROUTES.home} aria-label="Volver" className="grid size-11 place-items-center rounded-full hover:bg-slate-200">
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
        <Card className="flex items-start gap-3 border-brand-600 bg-brand-50">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden />
          <div>
            <p className="font-extrabold">{CLEANING_TEMPLATE.title}</p>
            <p className="text-sm text-slate-700">
              Una lista de tareas con un solo pago al terminar. El cliente aprueba cada tarea con fotos y paga al final.
            </p>
          </div>
        </Card>

        <Field id="total" label="Precio total (MXN)" error={err("totalCents")} hint="Se paga una sola vez, cuando todas las tareas estén aprobadas.">
          <Input id="total" inputMode="decimal" autoComplete="off" value={total} onChange={(e) => setTotal(e.target.value)}
            invalid={!!err("totalCents")} aria-describedby="total-msg" />
        </Field>
        <Field id="buyerName" label="Nombre del cliente" error={err("buyerName")}>
          <Input id="buyerName" autoComplete="off" value={buyerName} maxLength={80} onChange={(e) => setBuyerName(e.target.value)}
            invalid={!!err("buyerName")} aria-describedby="buyerName-msg" />
        </Field>
        <Field id="buyerPhone" label="Teléfono del cliente (opcional)" error={err("buyerPhone")}
          hint="10 dígitos. Permite que reciba la solicitud de pago en su teléfono.">
          <Input id="buyerPhone" type="tel" inputMode="numeric" autoComplete="off" value={buyerPhone} maxLength={10}
            onChange={(e) => setBuyerPhone(e.target.value.replace(/\D/g, ""))} invalid={!!err("buyerPhone")} aria-describedby="buyerPhone-msg" />
        </Field>
        <Field id="dueDate" label="Fecha (opcional)" error={err("dueDate")}>
          <Input id="dueDate" type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} invalid={!!err("dueDate")} />
        </Field>

        <Card className="space-y-3">
          <div>
            <h2 className="text-lg font-bold">Tareas</h2>
            <p className="text-sm text-slate-700" aria-live="polite">
              {enabledCount} de {TASK_LIMITS.maxTasks} como máximo. Apaga las que no vas a hacer.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {tasks.map((t) => (
              <li key={t.key}>
                <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={t.enabled}
                    onChange={() => toggle(t.key)}
                    className="size-6 shrink-0 accent-brand-700"
                  />
                  <span className="min-w-0">
                    <span className={cn("block font-semibold", !t.enabled && "text-slate-500")}>{t.title}</span>
                    {t.description && <span className="block text-xs text-slate-600">{t.description}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {err("tasks") && (
            <p role="alert" className="text-sm font-medium text-red-700">
              {err("tasks")}
            </p>
          )}
          <div className="space-y-1">
            <label htmlFor="new-task" className="block text-sm font-semibold text-slate-800">
              Agregar tarea
            </label>
            <div className="flex gap-2">
              <Input
                id="new-task"
                value={newTask}
                maxLength={80}
                placeholder="Ej. Limpiar el balcón"
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTask();
                  }
                }}
                invalid={!!newTaskError}
              />
              <Button type="button" variant="outline" onClick={addTask} aria-label="Agregar tarea a la lista">
                <Plus className="size-5" aria-hidden /> Agregar
              </Button>
            </div>
            {newTaskError && (
              <p role="alert" className="text-sm font-medium text-red-700">
                {newTaskError}
              </p>
            )}
          </div>
        </Card>

        {formError && <ErrorBox message={formError} />}
        <Button type="submit" size="lg" block loading={busy}>
          Crear y compartir trato{totalCents !== null && totalCents > 0 ? ` · ${formatMxn(totalCents)}` : ""}
        </Button>
        <NoCustodyNotice />
      </form>
    </Page>
  );
}
