/**
 * Files without the VM: the storage-js calls the app makes, answered by
 * src/server/postgrest/storage.ts with bytes on local disk (STORAGE_BACKEND=local here; gcs in
 * production) and permission decided by the storage.objects RLS policies, as before.
 */
import pg from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { StorageClient } from "@supabase/storage-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ros-storage-"));
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = dir;

const { handleStorage } = await import("@/server/postgrest/storage");
const { identityFromHeaders } = await import("@/server/postgrest/identity");
const { disconnectGateway } = await import("@/server/db/gateway");

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
const T = { a: randomUUID(), b: randomUUID() };
const U = { a: randomUUID(), b: randomUUID() };
const BASE = "http://app.local/api/sb/storage/v1";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  return `${h}.${p}.${createHmac("sha256", process.env.SUPABASE_JWT_SECRET!).update(`${h}.${p}`).digest("base64url")}`;
}

const fetchVia = (allowService: boolean): typeof fetch => async (input, init) => {
  const req = new Request(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, { ...init, duplex: "half" } as RequestInit);
  const path = new URL(req.url).pathname.replace(/^\/api\/sb\/storage\/v1\//, "");
  return handleStorage(req, path, identityFromHeaders(req.headers, { allowService }));
};

const client = (token: string | null, allowService = false) =>
  new StorageClient(BASE, token ? { Authorization: `Bearer ${token}` } : {}, fetchVia(allowService));

let A: StorageClient, B: StorageClient, anon: StorageClient;
const pdf = () => new Blob([Buffer.from("%PDF-1.4 test " + randomUUID())], { type: "application/pdf" });
const get = (url: string) => fetchVia(false)(url.replace(/^https?:\/\/[^/]+/, "http://app.local"));

beforeAll(async () => {
  await admin.connect();
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  for (const k of ["a", "b"] as const) {
    await admin.query(`insert into public.tenants (id, name, email) values ($1, $2, $3)`, [T[k], `Files ${k}`, `f-${k}@example.test`]);
    await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [U[k], `files-${k}-${U[k].slice(0, 6)}@example.test`]);
    await admin.query(`insert into public.users (id, tenant_id, email, role) values ($1, $2, $3, 'owner')`, [U[k], T[k], `files-${k}-${U[k].slice(0, 6)}@example.test`]);
  }
  await admin.query("commit");
  A = client(jwt({ role: "authenticated", sub: U.a }));
  B = client(jwt({ role: "authenticated", sub: U.b }));
  anon = client(null);
});

afterAll(async () => {
  await admin.query(`delete from storage.objects where name like any($1::text[])`, [[`${T.a}/%`, `${T.b}/%`]]);
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`delete from public.users where id = any($1::uuid[])`, [[U.a, U.b]]);
  await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[U.a, U.b]]);
  await admin.query(`delete from public.tenants where id = any($1::uuid[])`, [[T.a, T.b]]);
  await admin.query("commit");
  await admin.end();
  await disconnectGateway();
  rmSync(dir, { recursive: true, force: true });
});

describe("upload — the RLS policies decide", () => {
  test("into your own tenant's folder: accepted, and the bytes come back", async () => {
    const body = pdf();
    const up = await A.from("documents").upload(`${T.a}/invoice.pdf`, body);
    expect(up.error).toBeNull();
    const down = await A.from("documents").download(`${T.a}/invoice.pdf`);
    expect(down.error).toBeNull();
    expect(Buffer.from(await down.data!.arrayBuffer()).toString()).toBe(Buffer.from(await body.arrayBuffer()).toString());
  });

  test("into ANOTHER tenant's folder: refused, nothing stored", async () => {
    const up = await A.from("documents").upload(`${T.b}/planted.pdf`, pdf());
    expect(up.error).not.toBeNull();
    const rows = await admin.query(`select 1 from storage.objects where name = $1`, [`${T.b}/planted.pdf`]);
    expect(rows.rowCount).toBe(0);
  });

  test("signed out: refused", async () => {
    expect((await anon.from("documents").upload(`${T.a}/anon.pdf`, pdf())).error).not.toBeNull();
  });

  test("same name twice without upsert → duplicate; with upsert → replaced", async () => {
    await A.from("documents").upload(`${T.a}/twice.pdf`, pdf());
    expect((await A.from("documents").upload(`${T.a}/twice.pdf`, pdf())).error?.message).toMatch(/already exists/);
    expect((await A.from("documents").upload(`${T.a}/twice.pdf`, pdf(), { upsert: true })).error).toBeNull();
  });

  test("the bucket's size and type limits hold", async () => {
    const big = new Blob([Buffer.alloc(21 * 1024 * 1024)], { type: "application/pdf" });
    expect((await A.from("documents").upload(`${T.a}/big.pdf`, big)).error?.message).toMatch(/maximum allowed size/);
    const exe = new Blob([Buffer.from("MZ")], { type: "application/x-msdownload" });
    expect((await A.from("documents").upload(`${T.a}/x.exe`, exe)).error?.message).toMatch(/not supported/);
  });

  test("path tricks are refused", async () => {
    expect((await A.from("documents").upload(`${T.a}/../${T.b}/x.pdf`, pdf())).error).not.toBeNull();
  });
});

describe("read, sign, delete", () => {
  test("another tenant cannot download, sign or delete your file", async () => {
    await A.from("documents").upload(`${T.a}/private.pdf`, pdf());
    expect((await B.from("documents").download(`${T.a}/private.pdf`)).error).not.toBeNull();
    expect((await B.from("documents").createSignedUrl(`${T.a}/private.pdf`, 60)).error).not.toBeNull();
    const del = await B.from("documents").remove([`${T.a}/private.pdf`]);
    expect(del.data).toEqual([]);
    expect((await A.from("documents").download(`${T.a}/private.pdf`)).error).toBeNull();
  });

  test("a signed URL works without a session; a tampered or wrong-file token does not", async () => {
    await A.from("documents").upload(`${T.a}/signed.pdf`, pdf());
    const { data } = await A.from("documents").createSignedUrl(`${T.a}/signed.pdf`, 60);
    expect((await get(data!.signedUrl)).status).toBe(200);
    const other = data!.signedUrl.replace("signed.pdf", "private.pdf");
    expect((await get(other)).status).toBe(400);
    expect((await get(data!.signedUrl.slice(0, -3) + "abc")).status).toBe(400);
  });

  test("delete removes the row and the bytes", async () => {
    await A.from("documents").upload(`${T.a}/gone.pdf`, pdf());
    const del = await A.from("documents").remove([`${T.a}/gone.pdf`]);
    expect(del.data).toHaveLength(1);
    expect((await A.from("documents").download(`${T.a}/gone.pdf`)).error).not.toBeNull();
  });

  test("public bucket (logos): readable by anyone; a private bucket is not", async () => {
    const png = new Blob([Buffer.from("\x89PNG test")], { type: "image/png" });
    expect((await A.from("logos").upload(`${T.a}/logo.png`, png)).error).toBeNull();
    const pub = A.from("logos").getPublicUrl(`${T.a}/logo.png`).data.publicUrl;
    expect((await get(pub)).status).toBe(200);
    const notPublic = pub.replace("/logos/", "/documents/").replace("logo.png", "signed.pdf");
    expect((await get(notPublic)).status).not.toBe(200);
  });

  test("the service role (admin client, in-process) can work across tenants, as before", async () => {
    const svc = client(jwt({ role: "service_role" }), true);
    const up = await svc.from("expense-receipts").upload(`${T.b}/receipt.jpg`, new Blob([Buffer.from("jpg")], { type: "image/jpeg" }), { upsert: true });
    expect(up.error).toBeNull();
    expect((await svc.from("expense-receipts").createSignedUrl(`${T.b}/receipt.jpg`, 60)).error).toBeNull();
  });
});
