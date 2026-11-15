import { EVIDENCE_LIMITS } from "@trato/shared";

export const MAX_IMAGE_SIDE = 1600;
export const IMAGE_QUALITY = 0.8;

/** Scales (w, h) down so the longest side is at most `max`, preserving aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new RangeError("Dimensiones inválidas.");
  const longest = Math.max(width, height);
  if (longest <= max) return { width: Math.round(width), height: Math.round(height) };
  const ratio = max / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export interface CompressedImage {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF orientation before the metadata is dropped.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Re-encodes an image through a canvas: max 1600 px on the longest side,
 * WebP (JPEG fallback) at q≈0.8. The re-encode drops EXIF (incl. GPS).
 * Shrinks quality/size if the result still exceeds the server limit.
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  const decoded = await decode(file);
  try {
    let side = MAX_IMAGE_SIDE;
    let quality = IMAGE_QUALITY;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { width, height } = fitWithin(decoded.width, decoded.height, side);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No se pudo procesar la imagen.");
      ctx.drawImage(decoded.source, 0, 0, width, height);

      let blob = await toBlob(canvas, "image/webp", quality);
      if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
      if (!blob) throw new Error("No se pudo procesar la imagen.");
      if (blob.size <= EVIDENCE_LIMITS.maxBytes) {
        const ext = blob.type === "image/webp" ? "webp" : "jpg";
        return { blob, filename: `evidencia-${Date.now()}.${ext}`, width, height };
      }
      side = Math.round(side * 0.75);
      quality = Math.max(0.5, quality - 0.1);
    }
    throw new Error("La foto es demasiado grande. Prueba con otra.");
  } finally {
    decoded.close();
  }
}
