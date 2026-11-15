import type { FeedMessage } from "@trato/shared";
import type { DockKind } from "@/lib/conversation";
import type { CardCtx } from "./types";

/** Placeholder: the real cards land with the proposal/payment/delivery commits. */
export function Dock(_props: { ctx: CardCtx; collapsed: boolean; flash: DockKind | null }) {
  return null;
}

export function FeedProposal(_props: { ctx: CardCtx; item: FeedMessage }) {
  return null;
}
