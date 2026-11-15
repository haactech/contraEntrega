import { useState } from "react";
import { Check, Copy, MessageCircle, Share2 } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export interface ShareLinks {
  shareUrl: string;
  whatsappUrl: string;
}


export function ShareSheet({
  open,
  onClose,
  links,
  title,
}: {
  open: boolean;
  onClose: () => void;
  links: ShareLinks | null;
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  if (!links) return null;

  async function copy() {
    if (!links) return;
    if (await copyText(links.shareUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  }
  async function nativeShare() {
    if (!links) return;
    try {
      await navigator.share({ title: "Trato", text: title, url: links.shareUrl });
    } catch {
      /* cancelled */
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Comparte el trato con tu comprador">
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          Tu comprador abrirá este enlace para revisar las condiciones y aceptar. No necesita crear cuenta.
        </p>
        <p className="break-all rounded-xl bg-slate-100 p-3 text-sm font-mono">{links.shareUrl}</p>
        <a
          href={links.whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-14 items-center justify-center gap-2 rounded-xl bg-[#128c7e] px-5 text-lg font-semibold text-white hover:bg-[#0f766e]"
        >
          <MessageCircle className="size-5" aria-hidden /> Compartir por WhatsApp
        </a>
        <Button variant="outline" size="lg" block onClick={() => void copy()}>
          {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}
          {copied ? "Enlace copiado" : "Copiar enlace"}
        </Button>
        {canNativeShare && (
          <Button variant="outline" size="lg" block onClick={() => void nativeShare()}>
            <Share2 className="size-5" aria-hidden /> Más opciones…
          </Button>
        )}
        <p aria-live="polite" className="sr-only">
          {copied ? "Enlace copiado" : ""}
        </p>
      </div>
    </Dialog>
  );
}
