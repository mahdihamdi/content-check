export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_EDGE_PX = 8192;
export const MAX_PIXELS = 24_000_000;
export const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
]);

const EXTENSION = /\.(jpe?g|png|webp|gif|tiff?|avif)$/i;

export type ImageKind = "jpeg" | "png" | "webp" | "gif" | "tiff" | "avif";

const MIME_BY_KIND: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
  avif: "image/avif",
};

export function mimeForKind(kind: ImageKind): string {
  return MIME_BY_KIND[kind];
}

export type ImageHeader = {
  kind: ImageKind;
  width: number | null;
  height: number | null;
};

const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeDisplay(value: string, max = 240): string {
  const cleaned = value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

export function isAllowedImageFile(file: File): boolean {
  if (file.type === "image/svg+xml" || file.type.startsWith("text/")) return false;
  if (file.type && file.type !== "application/octet-stream") return ALLOWED_TYPES.has(file.type);
  return EXTENSION.test(file.name);
}

export function assertSafeDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("Could not read this image's dimensions.");
  }
  if (width > MAX_EDGE_PX || height > MAX_EDGE_PX || width * height > MAX_PIXELS) {
    throw new Error(`Images must be at most ${MAX_EDGE_PX} pixels on a side.`);
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc9 ||
      marker === 0xca
    ) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    if (marker === 0xda) return null;
    offset += segmentLength;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: 1 + u24(bytes, 24), height: 1 + u24(bytes, 27) };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return null;
}

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return { kind: "jpeg", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { kind: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const size = webpSize(bytes);
    return { kind: "webp", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (bytes.length >= 10 && ascii(bytes, 0, 4) === "GIF8") {
    return { kind: "gif", width: u16(bytes, 6), height: u16(bytes, 8) };
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return { kind: "tiff", width: null, height: null };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brands = ascii(bytes, 8, Math.min(64, bytes.length - 8));
    if (brands.includes("avif") || brands.includes("avis")) {
      return { kind: "avif", width: null, height: null };
    }
  }
  return null;
}

export async function validateImageFile(file: File): Promise<ImageKind> {
  if (file.size <= 0) throw new Error("This file is empty.");
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`Images must be ${MAX_FILE_MB} MB or smaller.`);
  }
  if (!isAllowedImageFile(file)) {
    throw new Error("Only JPEG, PNG, WebP, GIF, TIFF, and AVIF images are accepted.");
  }
  const bytes = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const header = readImageHeader(bytes);
  if (!header) throw new Error("The file contents are not a supported image.");
  if (header.width !== null && header.height !== null) {
    assertSafeDimensions(header.width, header.height);
  }
  return header.kind;
}
