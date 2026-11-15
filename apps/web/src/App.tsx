import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { APP_ROUTES } from "@trato/shared";
import { DemoBanner, ModeProvider } from "@/hooks/use-mode";
import { ToastProvider } from "@/components/ui/toast";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Page } from "@/components/layout";
import { AGENTS_ROUTE } from "@/lib/routes";

// Route-level code splitting: the buyer route never imports seller code.
const HomeRoute = lazy(() => import("@/routes/seller/home"));
const NewConversationRoute = lazy(() => import("@/routes/seller/new-conversation"));
const NewAgreementRoute = lazy(() => import("@/routes/seller/new-agreement"));
const NewCleaningRoute = lazy(() => import("@/routes/seller/new-cleaning"));
const AgreementRoute = lazy(() => import("@/routes/seller/agreement"));
const SellerRoomRoute = lazy(() => import("@/routes/seller/room"));
const AgentsRoute = lazy(() => import("@/routes/seller/agents"));
const BuyerRoute = lazy(() => import("@/routes/buyer/buyer-room"));

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
              <Route path="/tratos/nuevo" element={<NewConversationRoute />} />
              <Route path="/tratos/nuevo/formulario" element={<NewAgreementRoute />} />
              <Route path="/tratos/nuevo/limpieza" element={<NewCleaningRoute />} />
              <Route path="/tratos/:id" element={<AgreementRoute />} />
              <Route path="/salas/:id" element={<SellerRoomRoute />} />
              <Route path={AGENTS_ROUTE} element={<AgentsRoute />} />
              <Route path="/t/:token" element={<BuyerRoute />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </ModeProvider>
    </BrowserRouter>
  );
}
