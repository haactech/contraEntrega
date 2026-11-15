import { lazy, Suspense, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowDown, ArrowLeft, ChevronDown, ChevronUp, FileText } from "lucide-react";
import { API_ROUTES, APP_ROUTES, EVIDENCE_LIMITS, type AllowedAction, type ConversationView } from "@trato/shared";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { uuid } from "@/lib/uuid";
import {
  activeCards,
  buyerAgreement,
  chipsFromActions,
  chipTargetCard,
  lastFeedKey,
  reconcilePending,
  sellerAgreement,
  submitOptimistic,
  type DockKind,
  type PendingMessage,
} from "@/lib/conversation";
import { sourceKey, useConversation, type RoomSource } from "@/hooks/use-conversation";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useMode } from "@/hooks/use-mode";
import { useToast } from "@/components/ui/toast";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorBox, NoCustodyNotice } from "@/components/layout";
import { Dock, FeedProposal } from "@/components/cards/dock";
import type { CardCtx } from "@/components/cards/types";
import { Chips } from "./chips";
import { Composer, SELLER_EMPTY_PLACEHOLDER, Suggestions, type ComposerHandle } from "./composer";
import { Feed } from "./feed";
import type { ShareLinks } from "@/routes/seller/share-sheet";

// Seller-only code: never part of the buyer's initial bundle.
const ShareSheet = lazy(() => import("@/routes/seller/share-sheet").then((m) => ({ default: m.ShareSheet })));

function roomTitle(view: ConversationView): string {
  return view.agreement?.agreement.title ?? view.activeProposal?.terms.title ?? "Nuevo trato";
}

/**
 * Shared deal room (seller and buyer): chat feed, active cards docked above the composer,
 * deterministic action chips and the composer.
 */
export function Room({ source, fallback }: { source: RoomSource; fallback?: (error: unknown) => ReactNode | null }) {
  const convo = useConversation(source);
  const { data: view, error, loading, applyView, forceRefresh } = convo;
  const toast = useToast();
  const mode = useMode();

  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [share, setShare] = useState<ShareLinks | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [flash, setFlash] = useState<DockKind | null>(null);
  const [reviewRequest, setReviewRequest] = useState<CardCtx["reviewRequest"]>(null);
  const [busyAction, setBusyAction] = useState<AllowedAction | null>(null);
  const [attachStatus, setAttachStatus] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const key = sourceKey(source);
  useEffect(() => {
    setPending([]);
    setShare(null);
  }, [key]);

  const visiblePending = useMemo(
    () => (view ? reconcilePending(view.feed, pending, view.role) : pending),
    [view, pending],
  );

  const stick = useStickToBottom(view ? `${lastFeedKey(view.feed)}|${visiblePending.length}|${view.assistantBusy}` : null);

  useEffect(() => {
    if (view) document.title = `${roomTitle(view)} · Trato`;
  }, [view]);

  const send = useCallback(
    (text: string, existingId?: string) => {
      if (!view) return;
      void submitOptimistic(
        {
          text,
          role: view.role,
          feed: view.feed,
          post: convo.post,
          setPending,
          onView: applyView,
          newId: uuid,
          now: Date.now,
          onError: friendlyError,
        },
        existingId,
      );
      window.setTimeout(() => stick.scrollToBottom(true), 0);
      composer.current?.focus();
    },
    [view, convo.post, applyView, stick],
  );

  const ctx: CardCtx | null = useMemo(
    () =>
      view
        ? {
            view,
            source,
            refresh: forceRefresh,
            applyView,
            onShare: (links) => {
              setShare(links);
              setShareOpen(true);
            },
            reviewRequest,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, source.role, forceRefresh, applyView, reviewRequest],
  );

  const focusCard = useCallback((kind: DockKind) => {
    setDockCollapsed(false);
    window.setTimeout(() => {
      const el = document.getElementById(`card-${kind}`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el?.focus({ preventScroll: true });
      setFlash(kind);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
    }, 30);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const attach = useCallback(
    async (files: File[]) => {
      if (!view) return;
      const sa = sellerAgreement(view);
      if (!sa) return;
      const balance = sa.milestones.find((m) => m.kind === "BALANCE");
      const used = sa.evidence.filter((e) => !e.submitted && e.milestoneId === balance?.id).length;
      const remaining = Math.max(0, EVIDENCE_LIMITS.maxPerRound - used);
      if (remaining === 0) {
        toast.show(`Ya hay ${EVIDENCE_LIMITS.maxPerRound} fotos por enviar. Borra una si quieres cambiarla.`, "error");
        return;
      }
      if (files.length > remaining) toast.show(`Máximo ${EVIDENCE_LIMITS.maxPerRound} fotos por entrega. Se agregan solo ${remaining}.`, "info");
      const batch = files.slice(0, remaining);
      try {
        const { compressImage } = await import("@/lib/image");
        for (const [i, file] of batch.entries()) {
          setAttachStatus(`Subiendo foto ${i + 1} de ${batch.length}…`);
          const out = await compressImage(file);
          await api.uploadEvidence(sa.agreement.id, out.blob, out.filename);
        }
        toast.show(batch.length === 1 ? "Foto agregada." : "Fotos agregadas.", "success");
      } catch (e) {
        toast.show(friendlyError(e), "error");
      } finally {
        setAttachStatus(null);
        await forceRefresh();
      }
    },
    [view, toast, forceRefresh],
  );

  const onChip = useCallback(
    async (action: AllowedAction) => {
      if (!view) return;
      const cards = activeCards(view);
      if (action === "APPROVE_DELIVERY" || action === "DISPUTE_DELIVERY") {
        setReviewRequest({ kind: action === "APPROVE_DELIVERY" ? "APPROVE" : "DISPUTE", nonce: Date.now() });
      }
      if (action === "UPLOAD_EVIDENCE") {
        composer.current?.openFilePicker();
        return;
      }
      if (action === "EXPORT") {
        const href =
          source.role === "SELLER"
            ? view.agreement
              ? API_ROUTES.agreementExport(view.agreement.agreement.id)
              : null
            : API_ROUTES.publicExport(source.token);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      if (action === "SHARE_LINK") {
        const sa = sellerAgreement(view);
        if (!sa) return;
        if (sa.shareUrl && sa.whatsappUrl) {
          setShare({ shareUrl: sa.shareUrl, whatsappUrl: sa.whatsappUrl });
          setShareOpen(true);
          return;
        }
        setBusyAction(action);
        try {
          const r = await api.shareAgreement(sa.agreement.id);
          setShare({ shareUrl: r.shareUrl, whatsappUrl: r.whatsappUrl });
          setShareOpen(true);
          await forceRefresh();
        } catch (e) {
          toast.show(friendlyError(e), "error");
        } finally {
          setBusyAction(null);
        }
        return;
      }
      if (action === "REFRESH_PAYMENT" && source.role === "BUYER") {
        const pr = buyerAgreement(view)?.activePaymentRequest;
        if (pr) {
          setBusyAction(action);
          try {
            await api.refreshPaymentRequest(source.token, pr.id);
            await forceRefresh();
          } catch (e) {
            toast.show(friendlyError(e), "error");
          } finally {
            setBusyAction(null);
          }
        }
      }
      const target = chipTargetCard(action, cards);
      if (target) focusCard(target);
    },
    [view, source, toast, forceRefresh, focusCard],
  );

  if (loading && !view) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 pt-6">
        <PageSkeleton />
      </div>
    );
  }
  if (!view || !ctx) {
    const alt = fallback?.(error) ?? null;
    if (alt) return <>{alt}</>;
    return (
      <div className="mx-auto w-full max-w-xl space-y-3 px-4 pt-6">
        <ErrorBox message={friendlyError(error)} onRetry={() => void convo.refresh()} />
        <Link to={APP_ROUTES.home} className="inline-flex min-h-11 items-center font-bold text-brand-800 underline">
          Ir al inicio
        </Link>
      </div>
    );
  }

  const isSeller = view.role === "SELLER";
  const agreementId = view.agreement?.agreement.id ?? null;
  const cards = activeCards(view);
  const chips = chipsFromActions(view.allowedActions);
  const emptyRoom = view.feed.length === 0 && visiblePending.length === 0;
  const canAttach = isSeller && (view.allowedActions.includes("UPLOAD_EVIDENCE") || view.allowedActions.includes("REDELIVER"));
  const placeholder = isSeller && view.feed.length === 0 ? SELLER_EMPTY_PLACEHOLDER : "Escribe un mensaje…";
  const sub = isSeller
    ? view.agreement
      ? `${view.agreement.agreement.code} · para ${view.agreement.agreement.buyerName}`
      : "Sala nueva"
    : view.agreement
      ? `${view.agreement.agreement.code} · ${buyerAgreement(view)?.seller.displayName ?? ""}`
      : "Sala del trato";

  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col bg-slate-50"
      style={{ height: mode === "mock" ? "calc(100dvh - 1.75rem)" : "100dvh" }}
    >
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        {isSeller ? (
          <Link to={APP_ROUTES.home} aria-label="Volver a mis tratos" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-slate-100">
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
        ) : (
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-700 text-xs font-extrabold text-white">
            T
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-extrabold leading-tight">{roomTitle(view)}</h1>
          <p className="truncate text-xs text-slate-600">{sub}</p>
        </div>
        {isSeller && agreementId && (
          <Link
            to={APP_ROUTES.agreement(agreementId)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-brand-800 hover:bg-brand-50"
          >
            <FileText className="size-4" aria-hidden /> Detalle
          </Link>
        )}
      </header>

      {error ? (
        <p role="status" className="bg-amber-100 px-3 py-1.5 text-center text-sm font-medium text-amber-900">
          Sin conexión. Seguimos intentando…
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={stick.ref}
          onScroll={stick.onScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Mensajes del trato"
          className="h-full overflow-y-auto overscroll-contain px-3"
        >
          <Feed
            view={view}
            pending={visiblePending}
            onRetry={(id) => {
              const p = pending.find((x) => x.clientId === id);
              if (p) send(p.text, id);
            }}
            renderProposal={(item) => <FeedProposal ctx={ctx} item={item} />}
            empty={
              isSeller ? (
                <div className="space-y-4 rounded-2xl bg-white p-4 shadow-sm">
                  <div>
                    <p className="text-lg font-extrabold">Cuéntale a Trato tu trato</p>
                    <p className="text-sm text-slate-700">
                      Escribe qué vas a hacer, para quién y cuánto cobras. Trato arma la propuesta; tú la confirmas antes de compartirla.
                    </p>
                  </div>
                  {view.assistant.enabled ? (
                    <Suggestions onPick={(t) => composer.current?.setText(t)} />
                  ) : (
                    <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                      El asistente no está disponible ahora.{" "}
                      <Link to={APP_ROUTES.newAgreementForm} className="font-bold underline">
                        Usa el formulario
                      </Link>
                      .
                    </p>
                  )}
                </div>
              ) : (
                <p className="rounded-2xl bg-white p-4 text-center text-sm text-slate-700 shadow-sm">
                  Aún no hay mensajes. Cuando el prestador comparta la propuesta, la verás aquí.
                </p>
              )
            }
          />
          {!emptyRoom && <NoCustodyNotice className="mb-3 text-xs" />}
        </div>
        {stick.hasNew && (
          <button
            type="button"
            onClick={() => stick.scrollToBottom(true)}
            className="absolute bottom-3 left-1/2 inline-flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full bg-slate-900 px-4 text-sm font-bold text-white shadow-lg"
          >
            Nuevos mensajes <ArrowDown className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {cards.length > 0 && (
        <div className="border-t border-slate-200 bg-slate-100">
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            aria-expanded={!dockCollapsed}
            aria-controls="room-dock"
            className="flex min-h-11 w-full items-center justify-center gap-1.5 text-xs font-bold text-slate-700"
          >
            {dockCollapsed ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
            {dockCollapsed ? "Mostrar acción pendiente" : "Ocultar tarjetas"}
          </button>
          <div id="room-dock" hidden={dockCollapsed} className="max-h-[50dvh] space-y-2 overflow-y-auto px-3 pb-2">
            <Dock ctx={ctx} collapsed={dockCollapsed} flash={flash} />
          </div>
        </div>
      )}

      {attachStatus && (
        <p role="status" className="border-t border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
          {attachStatus}
        </p>
      )}
      <Chips chips={chips} busy={busyAction} onChip={(a) => void onChip(a)} />
      <Composer
        ref={composer}
        placeholder={placeholder}
        canAttach={canAttach}
        attachBusy={attachStatus !== null}
        onSend={(t) => send(t)}
        onFiles={(f) => void attach(f)}
      />

      {isSeller && share && (
        <Suspense fallback={null}>
          <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} links={share} title={roomTitle(view)} />
        </Suspense>
      )}
    </div>
  );
}
