import { lazy, Suspense } from "react";
import { useParams } from "react-router";
import { isMissingEndpoint } from "@/lib/endpoint";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Page } from "@/components/layout";
import { Room } from "@/components/room/room";

// v0.2 view, kept as a graceful fallback while the conversation endpoint is not deployed.
const BuyerLegacyView = lazy(() => import("./buyer-view"));

/** Buyer's room: `/t/:token`. Falls back to the v0.2 view if the conversation endpoint is missing. */
export default function BuyerRoomRoute() {
  const { token = "" } = useParams();
  return (
    <Room
      source={{ role: "BUYER", token }}
      fallback={(e) =>
        isMissingEndpoint(e) ? (
          <Suspense
            fallback={
              <Page>
                <PageSkeleton />
              </Page>
            }
          >
            <BuyerLegacyView />
          </Suspense>
        ) : null
      }
    />
  );
}
