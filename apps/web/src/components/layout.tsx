import type { ReactNode } from "react";
import { Link } from "react-router";
import { ShieldCheck } from "lucide-react";
import { APP_ROUTES } from "@trato/shared";
import { cn } from "@/lib/cn";

export const NO_CUSTODY_NOTICE =
  "El dinero llega directamente al prestador. Esta plataforma no retiene fondos ni garantiza devoluciones.";

export function Page({
  children,
  title,
  back,
  actions,
  className,
}: {
  children: ReactNode;
  title?: string;
  back?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-xl px-4 pb-24 pt-4">
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {back}
          <Link to={APP_ROUTES.home} className="flex items-center gap-1.5 font-extrabold text-brand-800" aria-label="Trato, inicio">
            <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-brand-700 text-white">
              <ShieldCheck className="size-5" />
            </span>
            {!title && <span className="text-lg">Trato</span>}
          </Link>
          {title && <h1 className="truncate text-xl font-extrabold">{title}</h1>}
        </div>
        {actions}
      </header>
      <main className={cn("space-y-4", className)}>{children}</main>
    </div>
  );
}

export function NoCustodyNotice({ className }: { className?: string }) {
  return (
    <p className={cn("rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700", className)}>{NO_CUSTODY_NOTICE}</p>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
      {message}
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 min-h-11 font-bold underline">
          Reintentar
        </button>
      )}
    </div>
  );
}
