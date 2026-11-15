import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, Copy, FileDown, Link2, MessageSquare, RefreshCw, Share2, TriangleAlert } from "lucide-react";
import {
  API_ROUTES,
  APP_ROUTES,
  formatMxn,
  type SellerAgreementView,
} from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { usePolling } from "@/hooks/use-polling";
import { computeProgress, PROGRESS_STEPS } from "@/lib/progress";
import {
  MILESTONE_STATUS_LABEL,
  MILESTONE_TITLE,
  SELLER_ACTION_TEXT,
  chipFor,
  formatDate,
} from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Stepper } from "@/components/ui/stepper";
import { useToast } from "@/components/ui/toast";
import { ErrorBox, NoCustodyNotice, Page } from "@/components/layout";
import { Timeline } from "@/components/timeline";
import { EvidencePanel } from "./evidence-panel";
import { ShareSheet, type ShareLinks } from "./share-sheet";
import type { AgreementLocationState } from "./new-agreement";

export default function AgreementRoute() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const initialShare = (location.state as AgreementLocationState | null)?.share ?? null;

  const { data, error, loading, refresh, setData } = usePolling<SellerAgreementView>(
    (_prev, signal) => api.getAgreement(id, signal),
    () => false,
    [id],
  );

  const [shareOpen, setShareOpen] = useState(initialShare !== null);
  const [links, setLinks] = useState<ShareLinks | null>(initialShare);
  const [regenOpen, setRegenOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (isApiError(error, "UNAUTHORIZED")) navigate(APP_ROUTES.home, { replace: true });
  }, [error, navigate]);

  // Every agreement has a room (v0.3). The v0.2 view has no conversation id, so look it up.
  const [roomId, setRoomId] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setRoomId(null);
    api
      .listConversations(c.signal)
      .then((r) => setRoomId(r.conversations.find((x) => x.agreementId === id)?.id ?? null))
      .catch(() => undefined); // endpoint not deployed yet: no link
    return () => c.abort();
  }, [id]);

  const currentLinks: ShareLinks | null = useMemo(() => {
    if (data?.shareUrl && data.whatsappUrl) return { shareUrl: data.shareUrl, whatsappUrl: data.whatsappUrl };
    return links;
  }, [data, links]);

  if (loading && !data) {
    return (
      <Page title="Trato">
        <PageSkeleton />
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Trato">
        <ErrorBox
          message={isApiError(error, "NOT_FOUND") ? "No encontramos este trato." : friendlyError(error)}
          onRetry={() => void refresh()}
        />
        <Link to={APP_ROUTES.home} className="inline-block min-h-11 font-bold text-brand-800 underline">
          Volver a mis tratos
        </Link>
      </Page>
    );
  }

  const a = data.agreement;
  const progress = computeProgress(data);
  const balance = data.milestones.find((m) => m.kind === "BALANCE");
  const action = SELLER_ACTION_TEXT[data.nextAction];
  const canDeliver = data.nextAction === "UPLOAD_EVIDENCE" || data.nextAction === "RESOLVE_DISPUTE";
  const dispute = [...data.reviews].reverse().find((r) => r.decision === "DISPUTE");
  const chip = chipFor({ nextAction: data.nextAction });

  async function share(regenerate: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      const r = await api.shareAgreement(id, regenerate);
      setData(r.agreement);
      setLinks({ shareUrl: r.shareUrl, whatsappUrl: r.whatsappUrl });
      setShareOpen(true);
      setRegenOpen(false);
      if (regenerate) toast.show("Enlace nuevo listo. El anterior ya no funciona.", "success");
    } catch (e) {
      setActionError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!currentLinks) return;
    try {
      await navigator.clipboard.writeText(currentLinks.shareUrl);
      toast.show("Enlace copiado", "success");
    } catch {
      setShareOpen(true);
    }
  }

  return (
    <Page
      title={a.code}
      back={
        <Link to={APP_ROUTES.home} aria-label="Volver a mis tratos" className="grid size-11 place-items-center rounded-full hover:bg-slate-200">
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
      }
    >
      <div>
        <h2 className="text-2xl font-extrabold leading-tight">{a.title}</h2>
        <p className="text-sm text-slate-700">
          Para {a.buyerName}
          {a.buyerPhoneMasked ? ` · ${a.buyerPhoneMasked}` : ""} · {formatMxn(a.totalCents)}
          {a.dueDate ? ` · entrega ${formatDate(a.dueDate)}` : ""}
        </p>
      </div>

      {roomId && (
        <Link
          to={APP_ROUTES.room(roomId)}
          className="flex min-h-11 items-center gap-2 rounded-xl bg-brand-50 px-3 font-semibold text-brand-800"
        >
          <MessageSquare className="size-5" aria-hidden /> Abrir la sala de este trato
        </Link>
      )}

      <Card>
        <Stepper steps={[...PROGRESS_STEPS]} current={progress.current} done={progress.done} />
      </Card>

      {!!error && !isApiError(error, "UNAUTHORIZED") && (
        <p role="status" className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">
          Sin conexión. Seguimos intentando…
        </p>
      )}

      <Card className="space-y-3 border-brand-600 bg-brand-50">
        <div className="flex items-center gap-2">
          <Badge tone={chip.tone}>{chip.label}</Badge>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Siguiente paso</span>
        </div>
        <CardTitle>{action.title}</CardTitle>
        <p className="text-slate-800">{action.body}</p>
        {data.nextAction === "SHARE" && (
          <Button size="lg" block loading={busy} onClick={() => void (currentLinks ? setShareOpen(true) : share(false))}>
            <Share2 className="size-5" aria-hidden /> Compartir enlace
          </Button>
        )}
        {actionError && <ErrorBox message={actionError} />}
      </Card>

      {data.nextAction === "RESOLVE_DISPUTE" && dispute && (
        <Card className="space-y-2 border-red-300 bg-red-50">
          <p className="flex items-center gap-2 font-bold text-red-800">
            <TriangleAlert className="size-5" aria-hidden /> Motivo que reportó {dispute.buyerName}
          </p>
          <blockquote className="whitespace-pre-wrap border-l-4 border-red-300 pl-3 text-slate-900">
            {dispute.comment}
          </blockquote>
        </Card>
      )}

      {canDeliver && (
        <EvidencePanel
          view={data}
          redelivery={data.nextAction === "RESOLVE_DISPUTE"}
          onUpdated={refresh}
          onView={setData}
        />
      )}

      {a.sharedAt && (
        <Card className="space-y-3">
          <CardTitle>Enlace para el comprador</CardTitle>
          {currentLinks ? (
            <>
              <p className="break-all rounded-xl bg-slate-100 p-3 font-mono text-sm">{currentLinks.shareUrl}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setShareOpen(true)}>
                  <Share2 className="size-4" aria-hidden /> Compartir
                </Button>
                <Button variant="outline" onClick={() => void copyLink()}>
                  <Copy className="size-4" aria-hidden /> Copiar
                </Button>
              </div>
            </>
          ) : (
            <Button variant="outline" block loading={busy} onClick={() => void share(false)}>
              <Link2 className="size-4" aria-hidden /> Obtener enlace
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRegenOpen(true)}>
            <RefreshCw className="size-4" aria-hidden /> Regenerar enlace
          </Button>
        </Card>
      )}

      <Card className="space-y-3">
        <CardTitle>Cobros</CardTitle>
        <ul className="divide-y divide-slate-200">
          {data.milestones.map((m) => {
            const st = MILESTONE_STATUS_LABEL[m.status];
            return (
              <li key={m.id} className="flex items-center justify-between gap-2 py-3">
                <span>
                  <span className="block font-semibold">{MILESTONE_TITLE[m.kind]}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </span>
                <span className="text-lg font-bold">{formatMxn(m.amountCents)}</span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-slate-700">
          Cobras en {data.account.alias} •••• {data.account.last4}.
        </p>
      </Card>

      {balance && data.evidence.some((e) => e.submitted) && (
        <Card className="space-y-2">
          <CardTitle>Fotos enviadas</CardTitle>
          <ul className="grid grid-cols-3 gap-2">
            {data.evidence
              .filter((e) => e.submitted)
              .map((e, i) => (
                <li key={e.id} className="aspect-square overflow-hidden rounded-xl bg-slate-200">
                  <img src={e.url} alt={`Foto enviada ${i + 1}, entrega ${e.deliveryRound + 1}`} loading="lazy" className="size-full object-cover" />
                </li>
              ))}
          </ul>
        </Card>
      )}

      <Card className="space-y-3">
        <CardTitle>Historial</CardTitle>
        <Timeline events={data.events} milestones={data.milestones} />
        <a
          href={API_ROUTES.agreementExport(id)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-2 font-semibold text-brand-800 underline"
        >
          <FileDown className="size-5" aria-hidden /> Exportar
        </a>
      </Card>

      <NoCustodyNotice />

      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} links={currentLinks} title={a.title} />
      <Dialog open={regenOpen} onClose={() => setRegenOpen(false)} title="¿Regenerar el enlace?">
        <div className="space-y-3">
          <p>El enlace anterior dejará de funcionar. Tendrás que enviar el nuevo a tu comprador.</p>
          <Button size="lg" block variant="danger" loading={busy} onClick={() => void share(true)}>
            Sí, regenerar
          </Button>
          <Button size="lg" block variant="ghost" onClick={() => setRegenOpen(false)}>
            Cancelar
          </Button>
        </div>
      </Dialog>
    </Page>
  );
}
