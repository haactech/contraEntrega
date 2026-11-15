import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Check, Copy, KeyRound, Plug } from "lucide-react";
import { APP_ROUTES, CreateApiKeyInputSchema, type ApiKeyView, type CreateApiKeyResponse } from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { isMissingEndpoint } from "@/lib/endpoint";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/labels";
import { mcpConfigSnippet } from "@/lib/mcp-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, Page } from "@/components/layout";

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      {...(className ? { className } : {})}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2500);
        });
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? "Copiado" : label}
    </Button>
  );
}

/** Shown exactly once, right after creating a key. */
function NewSecret({ created, onDismiss }: { created: CreateApiKeyResponse; onDismiss: () => void }) {
  const snippet = mcpConfigSnippet(window.location.origin, created.secret);
  return (
    <Card className="space-y-3 border-2 border-brand-700 bg-brand-50" aria-labelledby="new-secret-title">
      <CardTitle id="new-secret-title">Llave «{created.key.label}» creada</CardTitle>
      <p role="alert" className="rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
        Cópiala ahora. Por seguridad no la volveremos a mostrar; si la pierdes, crea otra y revoca esta.
      </p>
      <div>
        <p className="mb-1 text-sm font-bold text-slate-700">Tu llave secreta</p>
        <p className="break-all rounded-xl bg-white p-3 font-mono text-sm" data-testid="api-secret">
          {created.secret}
        </p>
        <CopyButton text={created.secret} label="Copiar llave" className="mt-2" />
      </div>
      <div>
        <p className="mb-1 text-sm font-bold text-slate-700">Configuración para tu agente (cliente MCP)</p>
        <pre className="overflow-x-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
        <CopyButton text={snippet} label="Copiar configuración" className="mt-2" />
      </div>
      <Button size="lg" block onClick={onDismiss}>
        Ya la guardé
      </Button>
    </Card>
  );
}

function keyStatus(k: ApiKeyView): { label: string; tone: "success" | "neutral" } {
  return k.revokedAt ? { label: "Revocada", tone: "neutral" } : { label: "Activa", tone: "success" };
}

export default function AgentsRoute() {
  const navigate = useNavigate();
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listApiKeys()
      .then((r) => setKeys(r.keys))
      .catch((e: unknown) => {
        if (isApiError(e, "UNAUTHORIZED")) navigate(APP_ROUTES.home, { replace: true });
        else if (isMissingEndpoint(e)) setUnavailable(true);
        else setError(friendlyError(e));
      });
  }, [navigate]);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setLabelError(undefined);
    setError(null);
    const parsed = CreateApiKeyInputSchema.safeParse({ label });
    if (!parsed.success) {
      setLabelError(parsed.error.issues[0]?.message ?? "Ponle un nombre a la llave.");
      return;
    }
    setCreating(true);
    try {
      const r = await api.createApiKey(parsed.data);
      setCreated(r);
      setLabel("");
      setKeys((prev) => [r.key, ...(prev ?? [])]);
    } catch (err) {
      if (isMissingEndpoint(err)) setUnavailable(true);
      else setError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await api.revokeApiKey(revoking.id);
      setRevoking(null);
      load();
    } catch (err) {
      setError(friendlyError(err));
      setRevoking(null);
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <Page
      title="Conectar un agente"
      back={
        <Link to={APP_ROUTES.home} aria-label="Volver al inicio" className="grid size-11 place-items-center rounded-full hover:bg-slate-200">
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
      }
    >
      <p className="text-slate-800">
        Conecta un agente de IA (por ejemplo, tu asistente favorito con soporte MCP) para listar y crear tratos, subir
        evidencia y pedir revisión. El agente actúa con tu llave; nunca puede marcar un pago ni cambiar cuentas.
      </p>

      {unavailable ? (
        <Card className="space-y-2 text-center text-slate-700">
          <Plug className="mx-auto size-8 text-slate-500" aria-hidden />
          <p className="font-bold">Esta función todavía no está disponible</p>
          <p className="text-sm">Tu servidor aún no ofrece llaves para agentes. Vuelve pronto: tus tratos siguen funcionando igual.</p>
        </Card>
      ) : (
        <>
          {created && <NewSecret created={created} onDismiss={() => setCreated(null)} />}

          <Card>
            <form onSubmit={(e) => void create(e)} className="space-y-3" noValidate>
              <CardTitle>Nueva llave</CardTitle>
              <Field id="key-label" label="Nombre de la llave" hint="Por ejemplo: «Mi asistente» o «Claude en mi laptop»." error={labelError}>
                <Input
                  id="key-label"
                  value={label}
                  maxLength={60}
                  onChange={(e) => setLabel(e.target.value)}
                  invalid={!!labelError}
                  aria-describedby="key-label-msg"
                />
              </Field>
              <Button type="submit" size="lg" block loading={creating}>
                <KeyRound className="size-5" aria-hidden /> Crear llave
              </Button>
            </form>
          </Card>

          {error && <ErrorBox message={error} onRetry={load} />}
          {!keys && !error && <Skeleton className="h-20" />}
          {keys && keys.length === 0 && (
            <Card className="text-center text-slate-700">Aún no tienes llaves. Crea una para conectar tu primer agente.</Card>
          )}
          {keys && keys.length > 0 && (
            <ul className="space-y-2" aria-label="Llaves">
              {keys.map((k) => {
                const st = keyStatus(k);
                return (
                  <li key={k.id} className={"rounded-2xl border border-slate-200 bg-white p-4 shadow-sm " + (k.revokedAt ? "opacity-60" : "")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-bold">{k.label}</p>
                        <p className="font-mono text-sm text-slate-700">{k.prefix}</p>
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      Creada {formatDateTime(k.createdAt)} · {k.lastUsedAt ? `último uso ${formatDateTime(k.lastUsedAt)}` : "sin usar"}
                    </p>
                    {!k.revokedAt && (
                      <Button variant="ghost" size="sm" className="mt-1 text-red-700 hover:bg-red-50" onClick={() => setRevoking(k)}>
                        Revocar
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <Dialog open={revoking !== null} onClose={() => setRevoking(null)} title="¿Revocar esta llave?">
        <div className="space-y-3">
          <p>
            El agente que use «{revoking?.label}» dejará de funcionar de inmediato. Esto no se puede deshacer.
          </p>
          <Button size="lg" block variant="danger" loading={revokeBusy} onClick={() => void revoke()}>
            Sí, revocar
          </Button>
          <Button size="lg" block variant="ghost" onClick={() => setRevoking(null)}>
            Cancelar
          </Button>
        </div>
      </Dialog>
    </Page>
  );
}
