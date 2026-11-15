import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const NEAR_BOTTOM_PX = 80;

/**
 * Autoscroll for chat: when `contentKey` changes, scroll to the end only if the user was already at
 * the bottom; otherwise report `hasNew` so the UI can offer «Nuevos mensajes ↓».
 */
export function useStickToBottom(contentKey: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const first = useRef(true);
  const prevKey = useRef<string | null>(null);
  const [hasNew, setHasNew] = useState(false);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottom.current = true;
    setHasNew(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottom.current) setHasNew(false);
  }, []);

  useLayoutEffect(() => {
    if (contentKey === prevKey.current) return;
    prevKey.current = contentKey;
    if (first.current) {
      first.current = false;
      scrollToBottom(false);
    } else if (atBottom.current) {
      scrollToBottom(true);
    } else {
      setHasNew(true);
    }
  }, [contentKey, scrollToBottom]);

  // Keep stuck to the bottom when the layout above/below changes size (dock opens, keyboard).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, onScroll, hasNew, scrollToBottom };
}
