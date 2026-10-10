/**
 * Where file BYTES live once Supabase Storage is gone. Who may touch a file is decided
 * elsewhere (storage.objects + its RLS policies, see src/server/postgrest/storage.ts); this
 * module only stores and fetches bytes.
 *
 *   STORAGE_BACKEND=gcs    → one Google Cloud Storage bucket (GCS_BUCKET), object key
 *                            "<supabase bucket>/<path>". Private; nothing is public on GCS —
 *                            public/signed reads are served through the app.
 *   STORAGE_BACKEND=local  → a folder on disk (STORAGE_LOCAL_DIR, default .storage) for local
 *                            development and tests.
 */
import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectBackend {
  put(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  remove(keys: string[]): Promise<void>;
}

function localBackend(): ObjectBackend {
  const root = resolve(process.env.STORAGE_LOCAL_DIR ?? ".storage");
  const pathFor = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(root + sep)) throw new Error("storage: key escapes the storage folder");
    return p;
  };
  return {
    async put(key, body, contentType) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
      await writeFile(`${p}.content-type`, contentType);
    },
    async get(key) {
      const p = pathFor(key);
      try {
        const [body, type] = await Promise.all([readFile(p), readFile(`${p}.content-type`, "utf8").catch(() => "application/octet-stream")]);
        return { body, contentType: type };
      } catch {
        return null;
      }
    },
    async remove(keys) {
      for (const k of keys) {
        const p = pathFor(k);
        await rm(p, { force: true });
        await rm(`${p}.content-type`, { force: true });
      }
    },
  };
}

function gcsBackend(): ObjectBackend {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) throw new Error("storage: GCS_BUCKET is not set");
  // Loaded lazily so local/dev and tests never need Google credentials.
  const bucket = (async () => {
    const { Storage } = await import("@google-cloud/storage");
    return new Storage().bucket(bucketName);
  })();
  return {
    async put(key, body, contentType, cacheControl) {
      await (await bucket).file(key).save(body, { contentType, resumable: false, metadata: cacheControl ? { cacheControl } : undefined });
    },
    async get(key) {
      const file = (await bucket).file(key);
      try {
        const [[body], [meta]] = await Promise.all([file.download(), file.getMetadata()]);
        return { body, contentType: meta.contentType ?? "application/octet-stream" };
      } catch (e) {
        if ((e as { code?: number }).code === 404) return null;
        throw e;
      }
    },
    async remove(keys) {
      const b = await bucket;
      await Promise.all(keys.map((k) => b.file(k).delete({ ignoreNotFound: true })));
    },
  };
}

let instance: ObjectBackend | undefined;
export function objectBackend(): ObjectBackend {
  instance ??= process.env.STORAGE_BACKEND === "gcs" ? gcsBackend() : localBackend();
  return instance;
}

export function storageGatewayEnabled(): boolean {
  return process.env.STORAGE_BACKEND === "gcs" || process.env.STORAGE_BACKEND === "local";
}
