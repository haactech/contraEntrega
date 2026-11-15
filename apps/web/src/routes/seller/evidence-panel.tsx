import { useRef, useState, type ChangeEvent } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { EVIDENCE_LIMITS, type EvidenceView, type SellerAgreementView } from "@trato/shared";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/form";
import { ErrorBox } from "@/components/layout";

interface Pending {
  localId: string;
  previewUrl: string;
  failed: string | null;
}

/**
 * Evidence upload for the balance milestone: 1–3 photos, compressed on the client
 * (max 1600 px, WebP/JPEG q≈0.8, EXIF dropped by the canvas re-encode), then
 * "Solicitar revisión" (or "Corregir y volver a entregar" after a dispute).
 */
export function EvidencePanel({
  view,
  redelivery,
  onUpdated,
  onView,
}: {
  view: SellerAgreementView;
  redelivery: boolean;
  /** Re-fetch the agreement after an upload/delete. */
  onUpdated: () => Promise<void>;
  onView: (v: SellerAgreementView) => void;
}) {
  const id = view.agreement.id;
  const balance = view.milestones.find((m) => m.kind === "BALANCE");
  const saved: EvidenceView[] = view.evidence.filter((e) => !e.submitted && e.milestoneId === balance?.id);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const counter = useRef(0);

  const used = saved.length + pending.filter((p) => !p.failed).length;
  const remaining = Math.max(0, EVIDENCE_LIMITS.maxPerRound - used);
  const busyUploading = pending.some((p) => !p.failed);

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);
    if (files.length > remaining) {
      setError(`Máximo ${EVIDENCE_LIMITS.maxPerRound} fotos por entrega. Se agregarán solo ${remaining}.`);
    }
    const { compressImage } = await import("@/lib/image");
    for (const file of files.slice(0, remaining)) {
      const localId = `p${++counter.current}`;
      const previewUrl = URL.createObjectURL(file);
      setPending((p) => [...p, { localId, previewUrl, failed: null }]);
      try {
        const out = await compressImage(file);
        await api.uploadEvidence(id, out.blob, out.filename);
        await onUpdated();
        setPending((p) => p.filter((x) => x.localId !== localId));
        URL.revokeObjectURL(previewUrl);
      } catch (err) {
        setPending((p) => p.map((x) => (x.localId === localId ? { ...x, failed: friendlyError(err) } : x)));
      }
    }
  }

  function dismiss(localId: string) {
    setPending((p) => {
      const item = p.find((x) => x.localId === localId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return p.filter((x) => x.localId !== localId);
    });
  }

  async function remove(ev: EvidenceView) {
    setDeleting(ev.id);
    setError(null);
    try {
      await api.deleteEvidence(id, ev.id);
      await onUpdated();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setDeleting(null);
    }
  }

  async function requestReview() {
    setSending(true);
    setError(null);
    try {
      const next = await api.requestReview(id, note.trim() || undefined);
      setNote("");
      onView(next);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSending(false);
    }
  }

  const failedItems = pending.filter((p) => p.failed);

  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>{redelivery ? "Corregir y volver a entregar" : "Evidencia de la entrega"}</CardTitle>
        <p className="text-sm text-slate-700">
          Sube de 1 a {EVIDENCE_LIMITS.maxPerRound} fotos del trabajo terminado. Las fotos se reducen en tu teléfono y se
          les quitan los datos de ubicación.
        </p>
      </div>

      {(saved.length > 0 || pending.length > 0) && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Fotos por enviar">
          {saved.map((ev, i) => (
            <li key={ev.id} className="relative aspect-square overflow-hidden rounded-xl bg-slate-200">
              <img src={ev.url} alt={`Foto ${i + 1} por enviar`} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => void remove(ev)}
                disabled={deleting === ev.id}
                aria-label={`Borrar foto ${i + 1}`}
                className="absolute right-1 top-1 grid size-11 place-items-center rounded-full bg-black/65 text-white disabled:opacity-50"
              >
                <Trash2 className="size-5" aria-hidden />
              </button>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.localId} className="relative aspect-square overflow-hidden rounded-xl bg-slate-200">
              <img src={p.previewUrl} alt="Foto subiendo" className={p.failed ? "size-full object-cover opacity-40" : "size-full animate-pulse object-cover opacity-70"} />
              {p.failed && (
                <button
                  type="button"
                  onClick={() => dismiss(p.localId)}
                  aria-label="Descartar foto con error"
                  className="absolute right-1 top-1 grid size-11 place-items-center rounded-full bg-black/65 text-white"
                >
                  <Trash2 className="size-5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {failedItems.map((p) => (
        <ErrorBox key={p.localId} message={p.failed ?? ""} />
      ))}

      {remaining > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand-700 px-3 font-semibold text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700">
            <Camera className="size-5" aria-hidden /> Tomar foto
            <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => void onFiles(e)} />
          </label>
          <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700">
            <ImagePlus className="size-5" aria-hidden /> Galería
            <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => void onFiles(e)} />
          </label>
        </div>
      )}
      <p className="text-xs text-slate-600" aria-live="polite">
        {used} de {EVIDENCE_LIMITS.maxPerRound} fotos
      </p>

      <Field id="review-note" label="Nota para el comprador (opcional)" hint="Máximo 500 caracteres.">
        <Textarea id="review-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-describedby="review-note-msg" />
      </Field>

      {error && <ErrorBox message={error} />}
      <Button size="lg" block loading={sending} disabled={saved.length < 1 || busyUploading} onClick={() => void requestReview()}>
        {redelivery ? "Volver a entregar y solicitar revisión" : "Solicitar revisión"}
      </Button>
    </Card>
  );
}
