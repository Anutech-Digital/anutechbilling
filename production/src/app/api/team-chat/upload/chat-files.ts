/**
 * R-2297 (G-TEAMCHAT TC-04): the rules for a team chat file — size, types, the bytes check, the
 * stored name and the download link. Used by POST /api/team-chat/upload and by the composer /
 * message list (TC-08) so both say the same thing.
 *
 * Where: the private `documents` bucket, {tenant}/chat/{channel}/{uuid}_{safe-name}. Who may
 * read / upload / delete there is decided in Postgres by public.storage_object_allowed (R-2297
 * chat branch): read = chat_can_read(channel), upload = a member as itself, delete = uploader or
 * owner. Downloads are 5-minute signed URLs — the bucket is never public.
 */
import { sniff, uploadProblem } from "@/server/postgrest/storage-safety";

export const CHAT_FILE_BUCKET = "documents";
/** Same cap as chat_attachments.size_bytes (R-2294). */
export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_FILE_SIGNED_URL_SECONDS = 5 * 60;

export const CHAT_FILE_TOO_LARGE =
  "This file is larger than 10 MB. Team chat takes files up to 10 MB — make it smaller or share a link to it instead.";
export const CHAT_FILE_TYPE_REFUSED =
  "This file type cannot be shared in team chat. Use PDF, JPG, PNG, WEBP, Word, Excel, TXT or ZIP.";

type Kind = { mime: string; label: string; bytesOk: (b: Uint8Array) => boolean };

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
/** Old Office (.doc / .xls): OLE compound file. */
const isOle = (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isText = (b: Uint8Array) => !b.includes(0) && uploadProblem("text/plain", b) === null && sniff(b) !== "markup";

/**
 * The Company Documents list (documents bucket allowed_mime_types; the vault dialog accepts the
 * same extensions). The extension picks the type; the browser's claimed type is not trusted.
 */
const KINDS: Record<string, Kind> = {
  pdf:  { mime: "application/pdf", label: "a PDF", bytesOk: (b) => sniff(b) === "pdf" },
  jpg:  { mime: "image/jpeg", label: "a JPG image", bytesOk: (b) => sniff(b) === "jpeg" },
  jpeg: { mime: "image/jpeg", label: "a JPG image", bytesOk: (b) => sniff(b) === "jpeg" },
  png:  { mime: "image/png", label: "a PNG image", bytesOk: (b) => sniff(b) === "png" },
  webp: { mime: "image/webp", label: "a WEBP image", bytesOk: (b) => sniff(b) === "webp" },
  doc:  { mime: "application/msword", label: "a Word file", bytesOk: isOle },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "a Word file", bytesOk: isZip },
  xls:  { mime: "application/vnd.ms-excel", label: "an Excel file", bytesOk: isOle },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "an Excel file", bytesOk: isZip },
  txt:  { mime: "text/plain", label: "a text file", bytesOk: isText },
  zip:  { mime: "application/zip", label: "a ZIP file", bytesOk: isZip },
};

/** Claimed types that never pass, whatever the extension says. */
const NEVER = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml",
  "application/x-shockwave-flash", "application/javascript", "text/javascript",
  "application/ecmascript", "text/ecmascript",
]);

export type ChatFileCheck = { ok: true; mime: string } | { ok: false; status: 413 | 415; error: string };

/** Size, type (by extension, never markup) and real bytes. */
export function checkChatFile(name: string, claimedType: string, bytes: Uint8Array): ChatFileCheck {
  if (bytes.length > CHAT_FILE_MAX_BYTES) return { ok: false, status: 413, error: CHAT_FILE_TOO_LARGE };
  const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const kind = KINDS[ext];
  if (!kind || NEVER.has(claimedType.split(";")[0].trim().toLowerCase())) return { ok: false, status: 415, error: CHAT_FILE_TYPE_REFUSED };
  if (bytes.length === 0 || !kind.bytesOk(bytes) || uploadProblem(kind.mime, bytes) !== null) {
    return {
      ok: false,
      status: 415,
      error: `This file is not really ${kind.label} — its contents do not match its type. Save it again as ${kind.label} and retry.`,
    };
  }
  return { ok: true, mime: kind.mime };
}

/**
 * The name part of the stored path: [A-Za-z0-9._-] only, no "..", at most 120 characters with
 * the extension kept (the storage rule allows 1–150; chat_attachments refuses ".." in a path).
 */
export function safeChatFileName(name: string): string {
  const base = name.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const ext = (base.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();
  let stem = (ext ? base.slice(0, -ext.length) : base)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/\.+$/, "");
  if (!stem.replace(/[_.-]/g, "")) stem = "file";
  return stem.slice(0, 120 - ext.length) + ext;
}

/** {tenant}/chat/{channel}/{uuid}_{safe-name} — the only shape the storage rule accepts. */
export function chatFilePath(tenantId: string, channelId: string, name: string): string {
  return `${tenantId}/chat/${channelId}/${crypto.randomUUID()}_${safeChatFileName(name)}`;
}

type SignsUrls = {
  storage: { from(bucket: string): { createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: unknown }> } };
};

/** A 5-minute link to open a chat file, made with the VIEWER's own client (the storage rule decides). */
export async function chatFileSignedUrl(client: SignsUrls, path: string): Promise<string | null> {
  const { data, error } = await client.storage.from(CHAT_FILE_BUCKET).createSignedUrl(path, CHAT_FILE_SIGNED_URL_SECONDS);
  return error || !data ? null : data.signedUrl;
}
