/**
 * R-1411: a storage upload (the AI Help screenshot goes here: /api/sb/storage/v1/object/…)
 * used to read the WHOLE body — req.formData() / req.arrayBuffer() — and only then compare it
 * with the bucket's file_size_limit. Buckets with no limit (attendance-selfies, employee-docs,
 * expense-receipts) had no ceiling at all, so one big or lying upload could fill the heap of an
 * instance already near its limit and crash the container for everyone on it.
 *
 * Now: Content-Length is checked first, then bytes are counted while reading and the stream is
 * cancelled the moment the cap is passed. The cap is the bucket's own limit, never above
 * STORAGE_UPLOAD_MAX_BYTES (20 MB, the documents bucket's limit — the largest we have).
 */
import { BodyTooLargeError, readBytesCapped } from "./body-limit";

export const STORAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Room for the multipart boundaries and the cacheControl field around the file itself. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

/** The cap for one upload into a bucket: its own limit, but never more than the global cap. */
export function uploadLimit(bucketLimit: number | null): number {
  return bucketLimit && bucketLimit > 0 ? Math.min(bucketLimit, STORAGE_UPLOAD_MAX_BYTES) : STORAGE_UPLOAD_MAX_BYTES;
}

export interface UploadBody { body: Buffer; contentType: string; cacheControl?: string }

export async function readUploadCapped(req: Request, limit: number): Promise<UploadBody> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const raw = await readBytesCapped(req, limit + MULTIPART_SLACK_BYTES);
    const form = await new Response(raw, { headers: { "content-type": type } }).formData();
    let file: File | null = null;
    for (const [, v] of form.entries()) if (typeof v !== "string") { file = v; break; }
    if (!file) throw new Error("no file in the upload");
    if (file.size > limit) throw new BodyTooLargeError(limit);
    const cc = form.get("cacheControl");
    return { body: Buffer.from(await file.arrayBuffer()), contentType: file.type || "application/octet-stream", cacheControl: typeof cc === "string" ? `max-age=${cc}` : undefined };
  }
  const bytes = await readBytesCapped(req, limit);
  return { body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType: type || "application/octet-stream", cacheControl: req.headers.get("cache-control") ?? undefined };
}

/** §24: what happened and what to do next. */
export function uploadTooLargeMessage(limit: number): string {
  const mb = Math.round((limit / (1024 * 1024)) * 10) / 10;
  return `File is too large — the limit is ${mb} MB. Choose a smaller file, or compress the image or PDF and try again.`;
}
