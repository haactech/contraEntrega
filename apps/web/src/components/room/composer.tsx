import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Camera, SendHorizontal } from "lucide-react";
import { POST_MESSAGE_MAX_CHARS, PostMessageInputSchema } from "@trato/shared";
import { cn } from "@/lib/cn";

export const SELLER_EMPTY_PLACEHOLDER = "Cuéntale a Trato qué vas a hacer, para quién y cuánto cobras";

export const SUGGESTIONS = [
  "Puerta de herrería para Mariana, 20 mil, 8 mil para empezar, la entrego el viernes",
  "Pintura de fachada para Don Luis, 15 mil, mitad de anticipo, termino en dos semanas",
  "Vestido de novia para Ana, 6 mil 500, 2 mil para empezar, lo entrego el 5 de diciembre",
] as const;

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  openFilePicker: () => void;
}

const MAX_HEIGHT_PX = 144;

export const Composer = forwardRef<
  ComposerHandle,
  {
    placeholder: string;
    disabled?: boolean;
    /** Show the camera button (seller with UPLOAD_EVIDENCE / REDELIVER). */
    canAttach: boolean;
    attachBusy?: boolean;
    onSend: (text: string) => void;
    onFiles: (files: File[]) => void;
  }
>(function Composer({ placeholder, disabled, canAttach, attachBusy, onSend, onFiles }, ref) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const resize = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, []);
  useLayoutEffect(resize, [text, resize]);
  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => area.current?.focus(),
      setText: (t: string) => {
        setText(t);
        window.setTimeout(() => area.current?.focus(), 0);
      },
      openFilePicker: () => file.current?.click(),
    }),
    [],
  );

  function send() {
    const parsed = PostMessageInputSchema.safeParse({ text });
    if (!parsed.success) {
      if (text.trim() !== "") setError(parsed.error.issues[0]?.message ?? "Revisa el mensaje.");
      return;
    }
    setError(null);
    onSend(parsed.data.text);
    setText("");
    // Keep the keyboard open and the caret in the box after sending.
    area.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="flex items-end gap-2 border-t border-slate-200 bg-white px-3 py-2"
      aria-label="Escribir mensaje"
    >
      {canAttach && (
        <>
          <button
            type="button"
            onClick={() => file.current?.click()}
            disabled={attachBusy}
            aria-label="Adjuntar foto de la entrega"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-slate-300 bg-white text-slate-800 disabled:opacity-50"
          >
            <Camera className="size-5" aria-hidden />
          </button>
          <input
            ref={file}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) onFiles(files);
            }}
          />
        </>
      )}
      <div className="min-w-0 flex-1">
        <label htmlFor="composer-text" className="sr-only">
          Mensaje
        </label>
        <textarea
          id="composer-text"
          ref={area}
          rows={1}
          value={text}
          maxLength={POST_MESSAGE_MAX_CHARS}
          placeholder={placeholder}
          enterKeyHint="send"
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "composer-error" : undefined}
          className={cn(
            "block max-h-36 min-h-11 w-full resize-none rounded-2xl border bg-slate-50 px-3.5 py-2.5 text-base leading-snug text-slate-900 placeholder:text-slate-500",
            error ? "border-red-600" : "border-slate-300",
          )}
        />
        {error && (
          <p id="composer-error" role="alert" className="mt-1 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Enviar mensaje"
        className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-700 text-white hover:bg-brand-800 disabled:bg-slate-300"
      >
        <SendHorizontal className="size-5" aria-hidden />
      </button>
    </form>
  );
});

export function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-slate-700">Por ejemplo, toca para usar:</p>
      <ul className="space-y-2">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="min-h-11 w-full rounded-2xl border border-brand-100 bg-brand-50 px-3.5 py-2.5 text-left text-[15px] text-brand-800 hover:bg-brand-100/60"
            >
              «{s}»
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
