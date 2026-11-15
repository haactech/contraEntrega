import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { CardCtx } from "./types";

// Seller-only (photo upload + compression UI): keep it out of the buyer's initial bundle.
const DeliverCardImpl = lazy(() => import("./deliver-card").then((m) => ({ default: m.DeliverCard })));

export function DeliverCard({ ctx, redelivery = false }: { ctx: CardCtx; redelivery?: boolean }) {
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <DeliverCardImpl ctx={ctx} redelivery={redelivery} />
    </Suspense>
  );
}
