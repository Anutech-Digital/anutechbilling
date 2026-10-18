/**
 * R-1546: what the storage gateway may store and how it may hand a file back.
 *
 * Files are served from the app's OWN origin (/api/sb/storage/v1). A file that a browser
 * renders as a document there (SVG, HTML, XML) runs its script as the app — it can call
 * /api/auth/supabase-token and take the viewer's session. So:
 *   - every response is sandboxed (CSP `sandbox`, no scripts) and `nosniff`;
 *   - only raster images whose BYTES really are a raster image are shown inline;
 *     everything else (PDF, SVG, HTML, unknown) is an attachment;
 *   - markup is refused on upload in every bucket, whatever type the uploader claimed.
 * The uploader's Content-Type is never trusted on its own — the first bytes decide.
 */

/** Shown inline only when the stored type is one of these AND the bytes match a raster image. */
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Never stored, in any bucket: a browser runs script inside these. */
const MARKUP_TYPES = new Set([
  "image/svg+xml", "text/html", "application/xhtml+xml", "application/xml", "text/xml",
  "application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript",
  "application/x-shockwave-flash", "multipart/x-mixed-replace",
]);

/** Text types a bucket may hold whose bytes may begin with "<" (served as attachment only). */
const PLAIN_TEXT_TYPES = new Set(["text/plain", "text/csv"]);

export const STORAGE_RESPONSE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

export type SniffedKind = "png" | "jpeg" | "gif" | "webp" | "pdf" | "markup" | "other";

/** "Image/PNG; charset=x" → "image/png". */
export function baseType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

const MARKUP_START = /^(<\?xml|<!doctype|<!--|<svg|<html|<head|<body|<script|<iframe|<object|<embed|<meta|<x:|<[a-z][a-z0-9-]*:svg)/i;
const MARKUP_ANYWHERE = /<\s*(svg|script|html|iframe|object|embed)[\s>/]|<\?xml|<!doctype\s+html/i;

/** What the first bytes of a file really are. */
export function sniff(body: Uint8Array): SniffedKind {
  const b = body;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  const head = ascii(b, 0, Math.min(b.length, 1024));
  if (head.includes("%PDF-")) return "pdf";
  // UTF-16 text (a BOM or NUL-interleaved "<"): decode loosely and look again.
  const text = (b.length >= 2 && ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe))) || /^\0?<\0/.test(head)
    ? head.replace(/\0/g, "")
    : head;
  const trimmed = text.replace(/^(﻿|ï»¿|þÿ|ÿþ|[\s\0])+/, "");
  if (MARKUP_START.test(trimmed) || MARKUP_ANYWHERE.test(text)) return "markup";
  return "other";
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const RASTER: ReadonlySet<SniffedKind> = new Set(["png", "jpeg", "gif", "webp"]);

/** Why an upload must be refused (415), or null when it may be stored. */
export function uploadProblem(contentType: string, body: Uint8Array): string | null {
  const type = baseType(contentType);
  if (MARKUP_TYPES.has(type)) return `mime type ${type} is not supported`;
  /* Markup under any other claimed type is refused. Other mismatches (an iPhone HEIC photo
     sent as image/jpeg) are stored — they are never shown inline (safeServeHeaders). */
  if (sniff(body) === "markup" && !PLAIN_TEXT_TYPES.has(type)) return `file content does not match ${type || "its type"}`;
  return null;
}

/** Headers for handing a stored file back: inline only for a real raster image. */
export function safeServeHeaders(storedType: string, body: Uint8Array, download: string | null | undefined): Headers {
  const type = baseType(storedType);
  const kind = sniff(body);
  const inline = INLINE_IMAGE_TYPES.includes(type) && RASTER.has(kind) && (download === undefined || download === null);
  const markup = kind === "markup" || MARKUP_TYPES.has(type) || type.includes("html") || type.includes("xml") || type.includes("script");
  const headers = new Headers({
    "Content-Type": markup || !type ? "application/octet-stream" : storedType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": STORAGE_RESPONSE_CSP,
  });
  if (!inline) {
    const name = download ? download.replace(/["\\\r\n]/g, "") : "";
    headers.set("Content-Disposition", `attachment${name ? `; filename="${name}"` : ""}`);
  }
  return headers;
}
