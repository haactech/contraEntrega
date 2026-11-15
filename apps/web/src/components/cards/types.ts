import type { ConversationView } from "@trato/shared";
import type { ShareLinks } from "@/routes/seller/share-sheet";
import type { RoomSource } from "@/hooks/use-conversation";

/** Shared context handed to every card in the room. */
export interface CardCtx {
  view: ConversationView;
  source: RoomSource;
  /** Re-fetch the conversation ignoring the ETag. */
  refresh: () => Promise<void>;
  /** Use a mutation response as the current view. */
  applyView: (v: ConversationView) => void;
  /** Seller: open the share sheet. */
  onShare: (links: ShareLinks) => void;
  /** Buyer: a chip asked to open a review dialog. */
  reviewRequest: { kind: "APPROVE" | "DISPUTE"; nonce: number } | null;
}
