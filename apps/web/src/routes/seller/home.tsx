import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Bot, ChevronRight, LogOut, Plus, UserRound } from "lucide-react";
import {
  APP_ROUTES,
  formatMxn,
  type AgreementSummary,
  type ConversationSummary,
  type SellerSummary,
} from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { isMissingEndpoint } from "@/lib/endpoint";
import { friendlyError } from "@/lib/errors";
import { chipFor, formatDate } from "@/lib/labels";
import { AGENTS_ROUTE } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, NoCustodyNotice, Page } from "@/components/layout";

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; seller: SellerSummary }
  | { status: "error"; message: string };

export default function HomeRoute() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });

  const load = useCallback(async () => {
    setSession({ status: "loading" });
    try {
      const { seller } = await api.getSession();
      setSession({ status: "authenticated", seller });
    } catch (e) {
      if (isApiError(e, "UNAUTHORIZED")) setSession({ status: "anonymous" });
      else setSession({ status: "error", message: friendlyError(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  const toAnonymous = useCallback(() => setSession({ status: "anonymous" }), []);

  if (session.status === "loading") {
    return (
      <Page>
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </Page>
    );
  }
  if (session.status === "error") {
    return (
      <Page>
        <ErrorBox message={session.message} onRetry={() => void load()} />
      </Page>
    );
  }
  if (session.status === "anonymous") {
    return <LoginScreen onLoggedIn={(seller) => setSession({ status: "authenticated", seller })} />;
  }
  return <AgreementList seller={session.seller} onLogout={toAnonymous} />;
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: (s: SellerSummary) => void }) {
  const [sellers, setSellers] = useState<SellerSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSellers = useCallback(() => {
    setLoadError(null);
    api
      .demoSellers()
      .then((r) => setSellers(r.sellers))
      .catch((e: unknown) => setLoadError(friendlyError(e)));
  }, []);
  useEffect(loadSellers, [loadSellers]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const { seller } = await api.login({ sellerId: selected, pin });
      onLoggedIn(seller);
    } catch (err) {
      setError(
        isApiError(err, "UNAUTHORIZED") || isApiError(err, "FORBIDDEN")
          ? "PIN incorrecto. Intenta de nuevo."
          : friendlyError(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Page>
      <div>
        <h1 className="text-2xl font-extrabold">Acuerda, cobra por etapas y guarda evidencia</h1>
        <p className="mt-1 text-slate-700">Elige tu perfil de demostración para entrar.</p>
      </div>

      {loadError && <ErrorBox message={loadError} onRetry={loadSellers} />}
      {!sellers && !loadError && (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">Perfil de prestador</legend>
          {sellers?.map((s) => {
            const checked = selected === s.id;
            return (
              <label
                key={s.id}
                className={cn(
                  "flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl border-2 bg-white p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-brand-700",
                  checked ? "border-brand-700 bg-brand-50" : "border-slate-200",
                )}
              >
                <input
                  type="radio"
                  name="seller"
                  value={s.id}
                  checked={checked}
                  onChange={() => setSelected(s.id)}
                  className="size-5 accent-brand-700"
                />
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-800">
                  <UserRound className="size-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block font-bold">{s.displayName}</span>
                  <span className="block text-sm text-slate-700">{s.trade}</span>
                  <span className="block text-xs text-slate-600">
                    {s.account.alias} •••• {s.account.last4}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {selected && (
          <Field id="pin" label="PIN de la demo" error={error ?? undefined}>
            <Input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              invalid={!!error}
              aria-describedby={error ? "pin-msg" : undefined}
              required
            />
          </Field>
        )}
        <Button type="submit" size="lg" block loading={submitting} disabled={!selected || pin.length === 0}>
          Entrar
        </Button>
      </form>
      <NoCustodyNotice />
    </Page>
  );
}

type ListState =
  | { kind: "conversations"; items: ConversationSummary[] }
  | { kind: "agreements"; items: AgreementSummary[] };

function conversationChip(c: ConversationSummary): { label: string; tone: Tone } {
  if (c.nextAction) return chipFor({ nextAction: c.nextAction });
  if (c.hasOpenProposal) return { label: "Propuesta por confirmar", tone: "warn" };
  return { label: c.agreementId ? "En curso" : "Conversando", tone: "neutral" };
}

function AgreementList({ seller, onLogout }: { seller: SellerSummary; onLogout: () => void }) {
  const navigate = useNavigate();
  const [list, setList] = useState<ListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listConversations()
      .then((r) => setList({ kind: "conversations", items: r.conversations }))
      .catch((e: unknown) => {
        if (isApiError(e, "UNAUTHORIZED")) return onLogout();
        // Chat backend not deployed yet: show the v0.2 agreement list.
        if (isMissingEndpoint(e)) {
          return api
            .listAgreements()
            .then((r) => setList({ kind: "agreements", items: r.agreements }))
            .catch((e2: unknown) => {
              if (isApiError(e2, "UNAUTHORIZED")) onLogout();
              else setError(friendlyError(e2));
            });
        }
        setError(friendlyError(e));
      });
  }, [onLogout]);
  useEffect(load, [load]);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      /* the cookie may already be gone */
    }
    onLogout();
  }

  const empty = list !== null && list.items.length === 0;

  return (
    <Page
      actions={
        <Button variant="ghost" size="sm" onClick={() => void logout()} loading={loggingOut}>
          <LogOut className="size-4" aria-hidden /> Cambiar de perfil
        </Button>
      }
    >
      <div>
        <h1 className="text-2xl font-extrabold">Hola, {seller.displayName}</h1>
        <p className="text-sm text-slate-700">
          {seller.trade} · {seller.account.alias} •••• {seller.account.last4}
        </p>
      </div>

      <div className="space-y-1">
        <Button size="lg" block onClick={() => navigate(APP_ROUTES.newAgreement)}>
          <Plus className="size-5" aria-hidden /> Nuevo trato
        </Button>
        <p className="text-center text-sm">
          <Link to={APP_ROUTES.newAgreementForm} className="inline-flex min-h-11 items-center font-semibold text-brand-800 underline">
            Usar formulario
          </Link>
        </p>
      </div>

      {error && <ErrorBox message={error} onRetry={load} />}
      {!list && !error && (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}
      {empty && (
        <Card className="text-center text-slate-700">
          Aún no tienes tratos. Cuéntale a Trato el primero y compártelo por WhatsApp.
        </Card>
      )}
      <ul className="space-y-2">
        {list?.kind === "conversations" &&
          list.items.map((c) => {
            const chip = conversationChip(c);
            return (
              <li key={c.id}>
                <Link
                  to={APP_ROUTES.room(c.id)}
                  className="flex min-h-20 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm active:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      {c.agreementCode && <span className="text-xs font-bold text-slate-600">{c.agreementCode}</span>}
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                    </span>
                    <span className="mt-0.5 block truncate font-bold">{c.title ?? "Trato nuevo"}</span>
                    <span className="block truncate text-sm text-slate-700">
                      {[c.buyerName, c.totalCents !== null ? formatMxn(c.totalCents) : null].filter(Boolean).join(" · ") ||
                        c.lastMessagePreview ||
                        "Sin mensajes todavía"}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-slate-400" aria-hidden />
                </Link>
              </li>
            );
          })}
        {list?.kind === "agreements" &&
          list.items.map((a) => {
            const chip = chipFor(a);
            return (
              <li key={a.id}>
                <Link
                  to={APP_ROUTES.agreement(a.id)}
                  className="flex min-h-20 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm active:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-600">{a.code}</span>
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                    </span>
                    <span className="mt-0.5 block truncate font-bold">{a.title}</span>
                    <span className="block truncate text-sm text-slate-700">
                      {a.buyerName} · {formatMxn(a.totalCents)}
                      {a.dueDate ? ` · para ${formatDate(a.dueDate)}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-slate-400" aria-hidden />
                </Link>
              </li>
            );
          })}
      </ul>

      <Link
        to={AGENTS_ROUTE}
        className="flex min-h-14 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm shadow-sm"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-800">
          <Bot className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold">Conectar un agente (MCP)</span>
          <span className="block text-slate-700">Deja que tu asistente de IA gestione tus tratos con una llave.</span>
        </span>
        <ChevronRight className="size-5 shrink-0 text-slate-400" aria-hidden />
      </Link>
      <NoCustodyNotice />
    </Page>
  );
}
