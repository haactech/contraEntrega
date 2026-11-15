import { Navigate, useParams } from "react-router";
import { APP_ROUTES } from "@trato/shared";
import { isApiError } from "@/lib/api";
import { Room } from "@/components/room/room";

/** Seller's room: `/salas/:id`. */
export default function SellerRoomRoute() {
  const { id = "" } = useParams();
  return (
    <Room
      source={{ role: "SELLER", conversationId: id }}
      fallback={(e) => (isApiError(e, "UNAUTHORIZED") ? <Navigate to={APP_ROUTES.home} replace /> : null)}
    />
  );
}
