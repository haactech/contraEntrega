import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, CheckCircle2, ChevronDown, ChevronUp, Trash2, TriangleAlert } from "lucide-react";
import {
  RequestAdjustmentRequestSchema,
  TASK_LIMITS,
  formatMxn,
  type EventView,
  type EvidenceView,
  type MilestoneView,
  type TaskView,
} from "@trato/shared";
import { friendlyError } from "@/lib/errors";
import {
  checklistPrimary,
  currentAfterPhotos,
  groupPhotosByRevision,
  lastAdjustment,
  type ChecklistPrimary,
} from "@/lib/cleaning";
import { TASK_STATUS_LABEL } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { Timeline } from "@/components/timeline";
import { Gallery } from "@/routes/buyer/gallery";

export type ChecklistRole = "SELLER" | "BUYER";

/** Side effects are injected so the component is pure UI (and testable). Each one rejects with an Error on failure. */
export interface ChecklistActions {
  /** Seller: upload one already-compressed photo for the current attempt. */
  uploadPhoto?: (task: TaskView, file: File) => Promise<void>;
  /** Seller: remove an unsubmitted photo. */
  removePhoto?: (task: TaskView, photo: EvidenceView) => Promise<void>;
  /** Seller: «Enviar para revisión». */
  submitTask?: (task: TaskView) => Promise<void>;
  /** Buyer: approve. */
  approveTask?: (task: TaskView) => Promise<void>;
  /** Buyer: ask for an adjustment with a reason. */
  requestAdjustment?: (task: TaskView, reason: string) => Promise<void>;
  /** Buyer primary «Pagar $N» (the room scrolls to the payment card). */
  onPay?: () => void;
  /** Seller primary «Compartir» when still a draft. */
  onShare?: () => void;
}

export interface TaskChecklistProps {
  role: ChecklistRole;
  title: string;
  totalCents: number;
  agreementStatus: Parameters<typeof checklistPrimary>[0]["agreementStatus"];
  balance: Pick<MilestoneView, "status" | "amountCents"> | null;
  tasks: readonly TaskView[];
  progress: { approved: number; total: number };
  /** Seller sees the client's name; buyer sees the provider's. */
  counterpartName: string;
  actions: ChecklistActions;
  /** Dock mode: header + primary action, the list behind «Ver las N tareas». */
  compact?: boolean;
  /** Mini timeline (last 3 events + «Ver todo»). */
  events?: readonly EventView[];
  milestones?: readonly MilestoneView[];
  /** Photo URLs are signed and expire: ask the owner for a fresh view. */
  onImageError?: () => void;
}

const MAX_PHOTOS = TASK_LIMITS.maxAfterPerRevision;

function ProgressBar({ approved, total }: { approved: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Tareas aprobadas"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={approved}
        className="h-2.5 overflow-hidden rounded-full bg-slate-200"
      >
        <div className="h-full rounded-full bg-brand-700 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-sm font-semibold text-slate-800">
        {approved}/{total} tareas aprobadas
      </p>
    </div>
  );
}

function PrimaryAction({ primary, onAct }: { primary: ChecklistPrimary; onAct: (() => void) | null }) {
  const tone =
    primary.kind === "PAID"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : primary.kind === "READY_TO_CHARGE"
        ? "border-brand-600 bg-brand-50 text-brand-800"
        : "border-slate-200 bg-slate-50 text-slate-800";
  if (onAct) {
    return (
      <Button size="lg" block onClick={onAct} data-primary={primary.kind}>
        {primary.label}
      </Button>
    );
  }
  return (
    <p role="status" data-primary={primary.kind} className={cn("rounded-xl border px-3 py-3 text-center text-base font-extrabold", tone)}>
      {primary.kind === "PAID" && <CheckCircle2 className="mr-1.5 inline size-5 align-text-bottom" aria-hidden />}
      {primary.label}
    </p>
  );
}

/* ------------------------------------------------------------------------------ task card */

function TaskCard({
  task,
  role,
  inProgress,
  actions,
  open,
  onToggle,
  onImageError,
}: {
  task: TaskView;
  role: ChecklistRole;
  /** Agreement is IN_PROGRESS: tasks can be worked on / reviewed. */
  inProgress: boolean;
  actions: ChecklistActions;
  open: boolean;
  onToggle: () => void;
  onImageError?: () => void;
}) {
  const st = TASK_STATUS_LABEL[task.status];
  const [busy, setBusy] = useState<null | "upload" | "remove" | "submit" | "approve" | "adjust">(null);
  const [error, setError] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const file = useRef<HTMLInputElement>(null);

  const drafts = currentAfterPhotos(task);
  const sellerCanWork = role === "SELLER" && inProgress && (task.status === "TODO" || task.status === "NEEDS_ADJUSTMENT");
  const buyerCanReview = role === "BUYER" && inProgress && task.status === "IN_REVIEW";
  const adjustment = lastAdjustment(task);
  const groups = groupPhotosByRevision(task);
  const latest = groups.find((g) => g.current);
  const older = groups.filter((g) => !g.current);
  const photoCount = task.evidence.length;

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<boolean> {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0 || !actions.uploadPhoto) return;
    const room = Math.max(0, MAX_PHOTOS - drafts.length);
    if (room === 0) return setError(`Máximo ${MAX_PHOTOS} fotos por envío.`);
    await run("upload", async () => {
      for (const f of files.slice(0, room)) await actions.uploadPhoto?.(task, f);
    });
  }

  async function approve() {
    if (await run("approve", async () => void (await actions.approveTask?.(task)))) setApproveOpen(false);
  }

  async function adjust() {
    setReasonError(undefined);
    const parsed = RequestAdjustmentRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? "Explica brevemente qué falta.");
      return;
    }
    if (await run("adjust", async () => void (await actions.requestAdjustment?.(task, parsed.data.reason)))) {
      setAdjustOpen(false);
      setReason("");
    }
  }

  return (
    <li
      data-task-id={task.id}
      data-status={task.status}
      className={cn(
        "space-y-2 rounded-2xl border bg-white p-3",
        task.status === "NEEDS_ADJUSTMENT" ? "border-red-300" : task.status === "APPROVED" ? "border-emerald-200" : "border-slate-200",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-bold leading-tight">{task.title}</h3>
          {task.description && <p className="text-sm text-slate-700">{task.description}</p>}
        </div>
        <Badge tone={st.tone} className="shrink-0">
          {st.label}
        </Badge>
      </div>

      {adjustment && (
        <div role="note" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p className="flex items-center gap-1.5 font-bold">
            <TriangleAlert className="size-4" aria-hidden /> Hace falta un ajuste
          </p>
          <p className="mt-0.5 whitespace-pre-wrap">“{adjustment.comment}”</p>
        </div>
      )}

      {/* seller: current attempt photos (removable until sent) */}
      {sellerCanWork && (
        <>
          {drafts.length > 0 && (
            <ul className="grid grid-cols-3 gap-2" aria-label={`Fotos por enviar de ${task.title}`}>
              {drafts.map((p, i) => (
                <li key={p.id} className="relative aspect-square overflow-hidden rounded-xl bg-slate-200">
                  <img src={p.url} alt={`Foto ${i + 1} por enviar`} onError={onImageError} className="size-full object-cover" />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run("remove", async () => void (await actions.removePhoto?.(task, p)))}
                    aria-label={`Quitar foto ${i + 1}`}
                    className="absolute right-1 top-1 grid size-11 place-items-center rounded-full bg-black/65 text-white disabled:opacity-50"
                  >
                    <Trash2 className="size-5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-600" aria-live="polite">
            {drafts.length} de {MAX_PHOTOS} fotos
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-brand-700",
                (drafts.length >= MAX_PHOTOS || busy !== null) && "pointer-events-none opacity-50",
              )}
            >
              <Camera className="size-5" aria-hidden /> {busy === "upload" ? "Subiendo…" : "Subir foto"}
              <input
                ref={file}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="sr-only"
                disabled={drafts.length >= MAX_PHOTOS || busy !== null}
                onChange={(e) => void onFile(e)}
              />
            </label>
            <Button
              loading={busy === "submit"}
              disabled={drafts.length < 1 || busy !== null}
              onClick={() => void run("submit", async () => void (await actions.submitTask?.(task)))}
            >
              Enviar para revisión
            </Button>
          </div>
        </>
      )}

      {/* photos: buyer reviewing, or anyone looking at history */}
      {!sellerCanWork && photoCount > 0 && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-800"
        >
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
          {buyerCanReview ? "Revisar" : open ? "Ocultar fotos" : "Ver fotos"}
        </button>
      )}
      {!sellerCanWork && open && (
        <div className="space-y-2">
          {latest && latest.photos.length > 0 && <Gallery items={latest.photos} onImageError={onImageError} />}
        </div>
      )}
      {/* older attempts, collapsed */}
      {older.length > 0 && (open || sellerCanWork) && (
        <div className="space-y-1">
          {older.map((g) => (
            <details key={g.revision} className="rounded-xl bg-slate-50 px-3 py-1">
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-700">Intento {g.revision}</summary>
              <div className="pb-2">
                <Gallery items={g.photos} onImageError={onImageError} />
              </div>
            </details>
          ))}
        </div>
      )}

      {buyerCanReview && open && (
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setApproveOpen(true)}>Aprobar</Button>
          <Button variant="outline" onClick={() => setAdjustOpen(true)}>
            Pedir ajuste
          </Button>
        </div>
      )}
      {error && !approveOpen && !adjustOpen && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-2 text-sm font-medium text-red-800">
          {error}
        </p>
      )}

      <Dialog open={approveOpen} onClose={() => setApproveOpen(false)} title={`¿Aprobar «${task.title}»?`}>
        <div className="space-y-3">
          <p>Aprobar esta tarea no paga por sí solo. El pago se libera hasta que todas las tareas estén aprobadas.</p>
          {error && <p role="alert" className="rounded-xl bg-red-50 p-2 text-sm font-medium text-red-800">{error}</p>}
          <Button size="lg" block loading={busy === "approve"} onClick={() => void approve()}>
            Sí, aprobar
          </Button>
          <Button size="lg" block variant="ghost" onClick={() => setApproveOpen(false)}>
            Volver
          </Button>
        </div>
      </Dialog>

      <Dialog open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Pedir un ajuste">
        <div className="space-y-3">
          <Field
            id={`reason-${task.id}`}
            label="¿Qué hace falta?"
            hint={`Entre ${TASK_LIMITS.reasonMin} y ${TASK_LIMITS.reasonMax} caracteres. El prestador podrá corregir y volver a enviar.`}
            error={reasonError}
          >
            <Textarea
              id={`reason-${task.id}`}
              value={reason}
              maxLength={TASK_LIMITS.reasonMax}
              onChange={(e) => setReason(e.target.value)}
              invalid={!!reasonError}
              aria-describedby={`reason-${task.id}-msg`}
            />
          </Field>
          {error && <p role="alert" className="rounded-xl bg-red-50 p-2 text-sm font-medium text-red-800">{error}</p>}
          <Button size="lg" block loading={busy === "adjust"} onClick={() => void adjust()}>
            Enviar ajuste
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

/* ------------------------------------------------------------------------------ checklist */

export function TaskChecklist(props: TaskChecklistProps) {
  const { role, tasks, progress, actions, compact = false, events, milestones = [] } = props;
  const [expanded, setExpanded] = useState(!compact);
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(new Set());
  const [allEvents, setAllEvents] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const primary = checklistPrimary({
    role,
    agreementStatus: props.agreementStatus,
    balanceStatus: props.balance?.status ?? null,
    tasks,
    totalCents: props.balance?.amountCents ?? props.totalCents,
    counterpartName: props.counterpartName,
  });

  const inProgress = props.agreementStatus === "IN_PROGRESS";
  const ordered = [...tasks].sort((a, b) => a.position - b.position);

  // Tasks needing action by the viewer start expanded where it helps (seller work is always inline).
  useEffect(() => setExpanded(!compact), [compact]);

  function openTask(id: string) {
    setExpanded(true);
    setOpenTasks((s) => new Set(s).add(id));
    window.setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
      el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, 30);
  }

  let onAct: (() => void) | null = null;
  if (primary.kind === "WORK" || primary.kind === "REVIEW") {
    const id = primary.taskId;
    onAct = () => openTask(id);
  } else if (primary.kind === "PAY" && actions.onPay) onAct = actions.onPay;
  else if (primary.kind === "SHARE" && actions.onShare) onAct = actions.onShare;

  const shownEvents = events ? [...events].sort((a, b) => b.seq - a.seq) : [];
  const timelineEvents = allEvents ? shownEvents : shownEvents.slice(0, 3);

  return (
    <Card className="space-y-3 border-brand-600" aria-label="Checklist de tareas" role="region">
      <div>
        <h2 className="text-lg font-extrabold leading-tight">
          {props.title} · {formatMxn(props.totalCents)}
        </h2>
        <p className="text-sm text-slate-700">Un solo pago al terminar, cuando todas las tareas estén aprobadas.</p>
      </div>
      <ProgressBar approved={progress.approved} total={progress.total} />
      <PrimaryAction primary={primary} onAct={onAct} />

      {compact && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-800"
        >
          {expanded ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
          {expanded ? "Ocultar tareas" : `Ver las ${tasks.length} tareas`}
        </button>
      )}

      {expanded && (
        <ul ref={listRef} className="space-y-2" aria-label="Tareas">
          {ordered.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              role={role}
              inProgress={inProgress}
              actions={actions}
              open={openTasks.has(t.id)}
              onToggle={() =>
                setOpenTasks((s) => {
                  const n = new Set(s);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
              onImageError={props.onImageError}
            />
          ))}
        </ul>
      )}

      {events && shownEvents.length > 0 && !compact && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-slate-700">Últimos movimientos</h3>
          <Timeline events={timelineEvents} milestones={milestones} cleaning />
          {shownEvents.length > 3 && (
            <button
              type="button"
              onClick={() => setAllEvents((a) => !a)}
              className="inline-flex min-h-11 items-center font-bold text-brand-800 underline"
            >
              {allEvents ? "Ver menos" : "Ver todo"}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
