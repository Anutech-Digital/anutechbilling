/**
 * A Supabase-Storage-compatible handler: the existing `supabase.storage.from(bucket)...` calls
 * keep working when the VM's Storage API is switched off. Bytes go to Cloud Storage
 * (src/server/storage/backend.ts); WHO may touch a file is still decided exactly as before —
 * by a row in storage.objects and the 20 RLS policies on it ("first folder = your tenant"),
 * evaluated by Postgres as the calling user. A file is written only after its row is accepted,
 * in the same transaction, so a refused upload stores nothing.
 *
 * Endpoints (what storage-js v2 sends):
 *   POST|PUT  object/{bucket}/{path}         upload (x-upsert) / update
 *   GET       object/[authenticated/]{bucket}/{path}  download (RLS)
 *   DELETE    object/{bucket}  {prefixes}     remove (RLS)
 *   POST      object/sign/{bucket}/{path}     signed URL (RLS to create; the token to read)
 *   POST      object/sign/{bucket} {paths}    many signed URLs
 *   GET       object/sign/{bucket}/{path}?token=   read with a signed URL
 *   GET       object/public/{bucket}/{path}   read from a public bucket (logos)
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { withIdentity, type Identity } from "@/server/db/gateway";
import { objectBackend } from "@/server/storage/backend";
import { asPgrstError } from "./handler";
import { signJwt, verifyJwt } from "./identity";

interface Bucket {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status: number, error: string, message: string) => json({ statusCode: String(status), error, message }, status === 403 ? 400 : status);

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
function splitPath(rest: string[]): { bucket: string; name: string } | null {
  const [bucket, ...parts] = rest;
  if (!bucket || !BUCKET_NAME.test(bucket) || parts.length === 0) return null;
  const name = parts.map((p) => decodeURIComponent(p)).join("/");
  if (!name || name.includes("\0") || name.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return { bucket, name };
}

async function bucketInfo(id: string): Promise<Bucket | null> {
  const rows = await withIdentity({ mode: "service" }, (tx) => tx.$queryRawUnsafe<Bucket[]>(
    `select id, public, file_size_limit::int as file_size_limit, allowed_mime_types from storage.buckets where id = $1`, id));
  return rows[0] ?? null;
}

const ownerOf = (id: Identity) => (id.mode === "user" ? id.userId : null);

function mimeAllowed(b: Bucket, type: string): boolean {
  if (!b.allowed_mime_types?.length) return true;
  return b.allowed_mime_types.some((m) => m === type || (m.endsWith("/*") && type.startsWith(m.slice(0, -1))));
}

async function readUpload(req: Request): Promise<{ body: Buffer; contentType: string; cacheControl?: string }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    let file: File | null = null;
    for (const [, v] of form.entries()) if (typeof v !== "string") { file = v as File; break; }
    if (!file) throw new Error("no file in the upload");
    const cc = form.get("cacheControl");
    return { body: Buffer.from(await file.arrayBuffer()), contentType: file.type || "application/octet-stream", cacheControl: typeof cc === "string" ? `max-age=${cc}` : undefined };
  }
  return { body: Buffer.from(await req.arrayBuffer()), contentType: type || "application/octet-stream", cacheControl: req.headers.get("cache-control") ?? undefined };
}

function serve(obj: { body: Buffer; contentType: string }, opts: { download?: string | null; publicCache?: boolean }): Response {
  const headers = new Headers({
    "Content-Type": obj.contentType,
    "Content-Length": String(obj.body.length),
    "Cache-Control": opts.publicCache ? "public, max-age=3600" : "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (opts.download !== undefined && opts.download !== null) {
    headers.set("Content-Disposition", `attachment${opts.download ? `; filename="${opts.download.replace(/["\\\r\n]/g, "")}"` : ""}`);
  }
  return new Response(new Uint8Array(obj.body), { status: 200, headers });
}

function signedUrlFor(bucket: string, name: string, expiresIn: number): string {
  const secret = process.env.SUPABASE_JWT_SECRET!;
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ url: `${bucket}/${name}`, iat: now, exp: now + Math.max(1, Math.min(expiresIn, 7 * 24 * 3600)) }, secret);
  return `/object/sign/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}?token=${token}`;
}

async function visible(identity: Identity, bucket: string, names: string[]): Promise<Set<string>> {
  const rows = await withIdentity(identity, (tx) => tx.$queryRawUnsafe<{ name: string }[]>(
    `select name from storage.objects where bucket_id = $1 and name = any($2::text[])`, bucket, names));
  return new Set(rows.map((r) => r.name));
}

export async function handleStorage(req: Request, path: string, identity: Identity): Promise<Response> {
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "object") return fail(404, "not_found", "Unknown storage endpoint");
  const rest = parts.slice(1);

  try {
    // ── reads that need no session ───────────────────────────────────────────
    if (method === "GET" && rest[0] === "sign") {
      const target = splitPath(rest.slice(1));
      const token = url.searchParams.get("token");
      if (!target || !token) return fail(400, "InvalidRequest", "Missing token");
      let claims: Record<string, unknown>;
      try { claims = verifyJwt(token, process.env.SUPABASE_JWT_SECRET!); } catch { return fail(400, "InvalidJWT", "Invalid or expired signature"); }
      if (claims.url !== `${target.bucket}/${target.name}`) return fail(400, "InvalidSignature", "The signature does not match this file");
      const obj = await objectBackend().get(`${target.bucket}/${target.name}`);
      return obj ? serve(obj, { download: url.searchParams.get("download") }) : fail(404, "not_found", "Object not found");
    }
    if (method === "GET" && rest[0] === "public") {
      const target = splitPath(rest.slice(1));
      if (!target) return fail(400, "InvalidRequest", "Bad path");
      const b = await bucketInfo(target.bucket);
      if (!b?.public) return fail(400, "not_found", "Bucket not found or not public");
      const obj = await objectBackend().get(`${target.bucket}/${target.name}`);
      return obj ? serve(obj, { publicCache: true, download: url.searchParams.get("download") }) : fail(404, "not_found", "Object not found");
    }

    // ── signed URLs (creating one needs read access under RLS) ───────────────
    if (method === "POST" && rest[0] === "sign") {
      const body = (await req.json().catch(() => ({}))) as { expiresIn?: number; paths?: string[] };
      const expiresIn = Number(body.expiresIn ?? 60);
      if (rest.length === 2 && Array.isArray(body.paths)) {
        const bucket = rest[1];
        const ok = await visible(identity, bucket, body.paths);
        return json(body.paths.map((p) => ok.has(p)
          ? { path: p, signedURL: signedUrlFor(bucket, p, expiresIn), error: null }
          : { path: p, signedURL: null, error: "Either the object does not exist or you do not have access to it" }));
      }
      const target = splitPath(rest.slice(1));
      if (!target) return fail(400, "InvalidRequest", "Bad path");
      const ok = await visible(identity, target.bucket, [target.name]);
      if (!ok.has(target.name)) return fail(404, "not_found", "Object not found");
      return json({ signedURL: signedUrlFor(target.bucket, target.name, expiresIn) });
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (method === "DELETE" && rest.length === 1) {
      const bucket = rest[0];
      const body = (await req.json().catch(() => ({}))) as { prefixes?: unknown };
      const names = Array.isArray(body.prefixes) ? body.prefixes.filter((p): p is string => typeof p === "string") : [];
      const deleted = await withIdentity(identity, (tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `delete from storage.objects where bucket_id = $1 and name = any($2::text[])
         returning id::text as id, bucket_id, name, owner::text as owner, created_at, updated_at, metadata`, bucket, names));
      await objectBackend().remove(deleted.map((d) => `${bucket}/${d.name as string}`));
      return json(deleted);
    }

    const target = splitPath(rest[0] === "authenticated" ? rest.slice(1) : rest);
    if (!target) return fail(400, "InvalidRequest", "Bad path");

    // ── download ─────────────────────────────────────────────────────────────
    if (method === "GET" || method === "HEAD") {
      const ok = await visible(identity, target.bucket, [target.name]);
      if (!ok.has(target.name)) return fail(404, "not_found", "Object not found");
      const obj = await objectBackend().get(`${target.bucket}/${target.name}`);
      if (!obj) return fail(404, "not_found", "Object not found");
      return method === "HEAD" ? new Response(null, { status: 200, headers: { "Content-Type": obj.contentType } }) : serve(obj, { download: url.searchParams.get("download") });
    }

    // ── upload / update ──────────────────────────────────────────────────────
    if (method === "POST" || method === "PUT") {
      const b = await bucketInfo(target.bucket);
      if (!b) return fail(404, "not_found", "Bucket not found");
      const file = await readUpload(req);
      if (b.file_size_limit && file.body.length > b.file_size_limit) return fail(413, "Payload too large", "The object exceeded the maximum allowed size");
      if (!mimeAllowed(b, file.contentType)) return fail(415, "invalid_mime_type", `mime type ${file.contentType} is not supported`);
      const upsert = method === "POST" && req.headers.get("x-upsert") === "true";
      const meta = JSON.stringify({ size: file.body.length, mimetype: file.contentType, cacheControl: file.cacheControl ?? "max-age=3600", eTag: `"${randomUUID()}"` });
      const key = `${target.bucket}/${target.name}`;
      // No RETURNING: it would also demand a SELECT policy, and some buckets (logos) have
      // none on purpose — they are read through public URLs. Only the write policies apply.
      const id = randomUUID();
      await withIdentity(identity, async (tx) => {
        if (method === "PUT") {
          const n = await tx.$executeRawUnsafe(`update storage.objects set metadata = $3::jsonb, updated_at = now()
            where bucket_id = $1 and name = $2`, target.bucket, target.name, meta);
          if (Number(n) === 0) throw Object.assign(new Error("Object not found"), { storageStatus: 404 });
        } else {
          await tx.$executeRawUnsafe(`insert into storage.objects (id, bucket_id, name, owner, metadata)
            values ($1::uuid, $2, $3, $4::uuid, $5::jsonb)
            ${upsert ? "on conflict (bucket_id, name) do update set metadata = excluded.metadata, owner = excluded.owner, updated_at = now()" : ""}`,
            id, target.bucket, target.name, ownerOf(identity), meta);
        }
        // Bytes only after the row passed RLS — and inside the transaction, so a failed write rolls it back.
        await objectBackend().put(key, file.body, file.contentType, file.cacheControl);
      });
      return json({ Id: id, Key: key });
    }

    return fail(405, "MethodNotAllowed", `${method} is not supported here`);
  } catch (e) {
    const status = (e as { storageStatus?: number }).storageStatus;
    if (status) return fail(status, "not_found", (e as Error).message);
    const pg = asPgrstError(e, identity.mode === "anon");
    if (pg.code === "23505") return fail(409, "Duplicate", "The resource already exists");
    if (pg.code === "42501") return fail(403, "Unauthorized", pg.message);
    return fail(pg.status >= 500 ? 500 : 400, pg.code, pg.message);
  }
}
