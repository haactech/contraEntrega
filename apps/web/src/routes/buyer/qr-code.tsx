import { useEffect, useRef, useState } from "react";

/** Renders `value` as a QR on a canvas. The `qrcode` library is loaded on demand. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    import("qrcode")
      .then(async (mod) => {
        const canvas = ref.current;
        if (!canvas || cancelled) return;
        const size = Math.min(320, Math.floor(window.innerWidth - 80));
        await mod.toCanvas(canvas, value, {
          width: Math.max(220, size),
          margin: 2,
          errorCorrectionLevel: "M",
          color: { dark: "#000000", light: "#ffffff" },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return <p role="alert" className="text-sm text-red-700">No pudimos dibujar el código QR. Recarga la página.</p>;
  }
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className="mx-auto rounded-2xl border-4 border-white bg-white shadow ring-1 ring-slate-300"
      style={{ minWidth: 220, minHeight: 220 }}
    />
  );
}
