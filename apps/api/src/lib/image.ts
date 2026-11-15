export type ImageKind = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** Detects JPEG/PNG/WebP from magic bytes. The client-declared mime type is never trusted. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}
