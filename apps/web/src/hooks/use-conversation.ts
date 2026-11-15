import { useCallback, useRef } from "react";
import type { ConversationView } from "@trato/shared";
import { api } from "@/lib/api";
import { conversationPollState } from "@/lib/conversation";
import { usePolling, type PolledResource } from "@/hooks/use-polling";

export type RoomSource = { role: "SELLER"; conversationId: string } | { role: "BUYER"; token: string };

export const sourceKey = (s: RoomSource): string => (s.role === "SELLER" ? `s:${s.conversationId}` : `b:${s.token}`);

export interface ConversationResource extends PolledResource<ConversationView> {
  /** Use a server response (mutation) as the current view; the next poll fetches a full body. */
  applyView: (v: ConversationView) => void;
  /** Re-fetch ignoring the ETag (e.g. after a mutation made outside the room, or expired image URLs). */
  forceRefresh: () => Promise<void>;
  post: (text: string) => Promise<ConversationView>;
}

/**
 * Polls the conversation with ETag/304. Interval: 1.5 s while the assistant is busy, 3 s with a
 * pending payment, 15 s otherwise; paused while the tab is hidden (see `pollInterval`).
 */
export function useConversation(source: RoomSource): ConversationResource {
  const etag = useRef<string | null>(null);
  const key = sourceKey(source);

  const polled = usePolling<ConversationView>(
    async (prev, signal) => {
      if (!prev) etag.current = null;
      const r =
        source.role === "SELLER"
          ? await api.getConversation(source.conversationId, etag.current, signal)
          : await api.getPublicConversation(source.token, etag.current, signal);
      if (r.notModified) return null;
      etag.current = r.etag;
      return r.data;
    },
    conversationPollState,
    [key],
  );

  const { setData, refresh } = polled;
  const applyView = useCallback(
    (v: ConversationView) => {
      etag.current = null;
      setData(v);
    },
    [setData],
  );
  const forceRefresh = useCallback(async () => {
    etag.current = null;
    await refresh();
  }, [refresh]);

  const post = useCallback(
    (text: string) =>
      source.role === "SELLER" ? api.postMessage(source.conversationId, text) : api.postPublicMessage(source.token, text),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return { ...polled, applyView, forceRefresh, post };
}
