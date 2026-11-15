import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { APP_ROUTES } from "@trato/shared";
import { api, isApiError } from "@/lib/api";
import { isMissingEndpoint } from "@/lib/endpoint";
import { friendlyError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, Page } from "@/components/layout";

/** `/tratos/nuevo`: creates an empty conversation and jumps to its room. */
export default function NewConversationRoute() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    try {
      const view = await api.createConversation();
      navigate(APP_ROUTES.room(view.conversation.id), { replace: true });
    } catch (e) {
      if (isApiError(e, "UNAUTHORIZED")) navigate(APP_ROUTES.home, { replace: true });
      // The chat backend is not deployed yet: degrade to the v0.2 form.
      else if (isMissingEndpoint(e)) navigate(APP_ROUTES.newAgreementForm, { replace: true });
      else setError(friendlyError(e));
    }
  }, [navigate]);

  useEffect(() => {
    // StrictMode runs effects twice in dev; never create two conversations.
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  return (
    <Page title="Nuevo trato">
      {error ? (
        <>
          <ErrorBox message={error} onRetry={() => void start()} />
          <Link to={APP_ROUTES.newAgreementForm} className="inline-flex min-h-11 items-center font-bold text-brand-800 underline">
            Usar el formulario
          </Link>
        </>
      ) : (
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="text-slate-700">Abriendo la sala…</p>
          <Skeleton className="h-16" />
        </div>
      )}
    </Page>
  );
}
