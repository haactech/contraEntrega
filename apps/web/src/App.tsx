import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { APP_ROUTES } from "@trato/shared";
import { DemoBanner, ModeProvider } from "@/hooks/use-mode";
import { ToastProvider } from "@/components/ui/toast";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Page } from "@/components/layout";

// Route-level code splitting: the buyer route never imports seller code.
const HomeRoute = lazy(() => import("@/routes/seller/home"));
const NewAgreementRoute = lazy(() => import("@/routes/seller/new-agreement"));
const AgreementRoute = lazy(() => import("@/routes/seller/agreement"));
const BuyerRoute = lazy(() => import("@/routes/buyer/buyer-view"));

function Fallback() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-6">
      <PageSkeleton />
    </div>
  );
}

function NotFound() {
  return (
    <Page title="No encontrado">
      <p>Esta página no existe.</p>
      <Link to={APP_ROUTES.home} className="font-bold text-brand-800 underline">
        Ir al inicio
      </Link>
    </Page>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ModeProvider>
        <ToastProvider>
          <DemoBanner />
          <Suspense fallback={<Fallback />}>
            <Routes>
              <Route path="/" element={<HomeRoute />} />
              <Route path="/tratos/nuevo" element={<NewAgreementRoute />} />
              <Route path="/tratos/:id" element={<AgreementRoute />} />
              <Route path="/t/:token" element={<BuyerRoute />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </ModeProvider>
    </BrowserRouter>
  );
}
