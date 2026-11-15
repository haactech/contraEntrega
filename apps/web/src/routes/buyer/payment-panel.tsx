import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, QrCode as QrIcon, RefreshCw, Smartphone } from "lucide-react";
import {
  CreatePaymentRequestSchema,
  formatMxn,
  type MilestoneView,
  type PaymentMethod,
  type PaymentRequestView,
} from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { formatCountdown, secondsUntil } from "@/lib/polling";
import { uuid } from "@/lib/uuid";
import { MILESTONE_TITLE } from "@/lib/labels";
import { useNow } from "@/hooks/use-now";
import { useMode } from "@/hooks/use-mode";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { ErrorBox } from "@/components/layout";
import { QrCode } from "./qr-code";

const DEFINITIVE_ERRORS = new Set(["VALIDATION_ERROR", "INVALID_STATE", "NOT_FOUND", "FORBIDDEN", "TERMS_MISMATCH"]);

function isSamePhone(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export function PaymentPanel({
  token,
  milestone,
  activeRequest,
  viewVersion,
  onChanged,
}: {
  token: string;
  milestone: MilestoneView;
  activeRequest: PaymentRequestView | null;
  viewVersion: number;
  onChanged: () => void;
}) {
  const [localPr, setLocalPr] = useState<PaymentRequestView | null>(null);
  const [busy, setBusy] = useState<PaymentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const attempt = useRef<{ key: string; method: PaymentMethod } | null>(null);
  const coarse = isSamePhone();

  // A fresh view from the server supersedes whatever we created locally.
  useEffect(() => setLocalPr(null), [viewVersion]);

  const pr = activeRequest && activeRequest.milestoneId === milestone.id ? activeRequest : localPr;
  const title = MILESTONE_TITLE[milestone.kind];

  const start = useCallback(
    async (method: PaymentMethod) => {
      setError(null);
      setPhoneError(undefined);
      const body = method === "CODI_PN" ? { method, phoneNumber: phone } : { method };
      const parsed = CreatePaymentRequestSchema.safeParse(body);
      if (!parsed.success) {
        setPhoneError(parsed.error.issues[0]?.message ?? "Revisa el teléfono.");
        return;
      }
      // One idempotency key per attempt: reused on retries, renewed once the attempt resolves.
      if (!attempt.current || attempt.current.method !== method) attempt.current = { key: uuid(), method };
      setBusy(method);
      try {
        const created = await api.createPaymentRequest(token, milestone.id, parsed.data, attempt.current.key);
        attempt.current = null;
        setLocalPr(created);
        onChanged();
      } catch (e) {
        if (isApiError(e) && DEFINITIVE_ERRORS.has(e.code)) attempt.current = null;
        setError(friendlyError(e));
        if (isApiError(e, "INVALID_STATE")) onChanged();
      } finally {
        setBusy(null);
      }
    },
    [token, milestone.id, phone, onChanged],
  );

  if (pr && pr.status === "AWAITING_PAYMENT") {
    return (
      <Awaiting
        token={token}
        pr={pr}
        title={title}
        onChanged={onChanged}
        onLocal={setLocalPr}
        onRegenerate={() => void start(pr.method)}
        regenerating={busy !== null}
        error={error}
      />
    );
  }

  const qrFirst = !coarse;
  const qrBlock = (
    <Button
      key="qr"
      size="lg"
      block
      variant={qrFirst ? "primary" : "outline"}
      loading={busy === "CODI_QR"}
      disabled={busy !== null}
      onClick={() => void start("CODI_QR")}
    >
      <QrIcon className="size-5" aria-hidden />
      {qrFirst ? `Pagar ${title.toLowerCase()} con QR` : "Mostrar QR para escanear desde otro dispositivo"}
    </Button>
  );
  const pushBlock = (
    <div key="push" className={coarse ? "space-y-3 rounded-2xl border-2 border-brand-700 bg-brand-50 p-3" : "space-y-3"}>
      {coarse && (
        <p className="text-sm font-semibold text-brand-800">
          Estás en tu teléfono, así que no puedes escanear tu propia pantalla. Recibe la solicitud directo en la app de tu banco.
        </p>
      )}
      <Field
        id="pay-phone"
        label="Tu teléfono (10 dígitos)"
        error={phoneError}
        hint={coarse ? undefined : "Alternativa: te enviamos la solicitud de pago a tu banco."}
      >
        <Input
          id="pay-phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          invalid={!!phoneError}
          aria-describedby="pay-phone-msg"
        />
      </Field>
      <Button
        size="lg"
        block
        variant={coarse ? "primary" : "outline"}
        loading={busy === "CODI_PN"}
        disabled={busy !== null}
        onClick={() => void start("CODI_PN")}
      >
        <Smartphone className="size-5" aria-hidden /> Enviar solicitud a mi teléfono
      </Button>
    </div>
  );

  return (
    <Card className="space-y-4" aria-labelledby="pay-title">
      <div>
        <CardTitle id="pay-title">Pagar {title.toLowerCase()}</CardTitle>
        <p className="text-3xl font-extrabold text-brand-800">{formatMxn(milestone.amountCents)}</p>
      </div>
      {error && <ErrorBox message={error} />}
      {coarse ? [pushBlock, qrBlock] : [qrBlock, pushBlock]}
      <p className="text-xs text-slate-600">
        Pagas con CoDi desde la app de tu banco. El dinero llega directamente al prestador.
      </p>
    </Card>
  );
}

function Awaiting({
  token,
  pr,
  title,
  onChanged,
  onLocal,
  onRegenerate,
  regenerating,
  error: parentError,
}: {
  token: string;
  pr: PaymentRequestView;
  title: string;
  onChanged: () => void;
  onLocal: (p: PaymentRequestView) => void;
  onRegenerate: () => void;
  regenerating: boolean;
  error: string | null;
}) {
  const mode = useMode();
  const now = useNow();
  const remaining = secondsUntil(pr.expiresAt, now);
  const expired = remaining === 0;
  const [checking, setChecking] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isPush = pr.method === "CODI_PN";

  const verify = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setChecking(true);
        setError(null);
        setNotice(null);
      }
      try {
        const updated = await api.refreshPaymentRequest(token, pr.id);
        onLocal(updated);
        if (updated.status !== "AWAITING_PAYMENT") onChanged();
        else if (!silent) setNotice("Aún no vemos tu pago. Si ya pagaste, espera unos segundos y vuelve a verificar.");
      } catch (e) {
        if (!silent) setError(friendlyError(e));
      } finally {
        if (!silent) setChecking(false);
      }
    },
    [token, pr.id, onLocal, onChanged],
  );

  // Active reconciliation in case the webhook never arrives (server throttles to 1 query / 10 s).
  useEffect(() => {
    if (expired) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void verify(true);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [verify, expired]);

  async function simulate() {
    setSimulating(true);
    setError(null);
    try {
      await api.simulatePayment(pr.id);
      await verify(false);
      onChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSimulating(false);
    }
  }

  return (
    <Card className="space-y-4 text-center" aria-labelledby="await-title">
      <div>
        <CardTitle id="await-title">
          {isPush ? "Solicitud enviada" : `Paga ${title.toLowerCase()} con CoDi`}
        </CardTitle>
        <p className="text-4xl font-extrabold text-brand-800">{formatMxn(pr.amountCents)}</p>
        <p className="text-sm text-slate-700">
          Referencia <span className="font-mono font-bold">{pr.numRef}</span>
        </p>
      </div>

      {isPush ? (
        <div className="space-y-2 rounded-2xl bg-brand-50 p-4">
          <Smartphone className="mx-auto size-10 text-brand-700" aria-hidden />
          <p className="font-semibold">
            Enviamos la solicitud a tu teléfono{pr.phoneLast4 ? ` terminación ${pr.phoneLast4}` : ""}.
          </p>
          <p className="text-sm text-slate-700">
            Abre la notificación de tu banco y autoriza el pago. Cuando se confirme, aquí te lo mostraremos.
          </p>
        </div>
      ) : pr.qrString && !expired ? (
        <>
          <QrCode value={pr.qrString} label={`Código QR de CoDi por ${formatMxn(pr.amountCents)}`} />
          <ol className="mx-auto max-w-xs list-decimal space-y-0.5 pl-5 text-left text-sm text-slate-800">
            <li>Abre la app de tu banco</li>
            <li>Ve a CoDi</li>
            <li>Escanear</li>
            <li>Apunta a este código y confirma</li>
          </ol>
        </>
      ) : null}

      {expired ? (
        <div className="space-y-2 rounded-2xl bg-amber-50 p-4">
          <p className="font-semibold text-amber-900">
            {isPush ? "La solicitud venció." : "Este código venció."} Si ya pagaste, verifica abajo.
          </p>
          <Button variant="outline" block loading={regenerating} onClick={onRegenerate}>
            Generar nueva solicitud
          </Button>
        </div>
      ) : (
        remaining !== null && (
          <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-800">
            <Clock className="size-4" aria-hidden />
            {isPush ? "Autoriza en" : "Vence en"} <span className="font-mono">{formatCountdown(remaining)}</span>
          </p>
        )
      )}

      <div role="status" aria-live="polite" className="min-h-5 text-sm text-slate-700">
        {checking ? "Verificando…" : (notice ?? (expired ? "" : "Esperando tu pago…"))}
      </div>
      {(error || parentError) && <ErrorBox message={(error ?? parentError)!} />}

      <Button size="lg" block variant="secondary" loading={checking} onClick={() => void verify(false)}>
        <RefreshCw className="size-5" aria-hidden /> Ya pagué, verificar
      </Button>

      {mode === "mock" && (
        <button
          type="button"
          onClick={() => void simulate()}
          disabled={simulating}
          className="min-h-11 text-xs font-semibold text-slate-500 underline disabled:opacity-50"
        >
          {simulating ? "Simulando…" : "Simular pago (demo)"}
        </button>
      )}
    </Card>
  );
}
