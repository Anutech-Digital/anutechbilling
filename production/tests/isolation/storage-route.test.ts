/**
 * R-1404 — the gateway storage ROUTE (/api/sb/storage/v1/[...path]) refuses another tenant's
 * path for read, sign, upload (POST / PUT) and delete. storage.test.ts proves the same at the
 * handler, through storage-js; this file goes through the exported route handlers with real
 * session tokens, so the route's own wiring (identity from headers, service_role refused over
 * HTTP, segment encoding) is part of the proof. Two owners (R-724: the vault folder is
 * owner + manager), real Postgres (npm run db:local), bytes on local disk.
 */
import pg from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ros-storage-route-"));
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = dir;

const route = await import("@/app/api/sb/storage/v1/[...path]/route");
const { disconnectGateway } = await import("@/server/db/gateway");

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
const T = { a: randomUUID(), b: randomUUID() };
const U = { a: randomUUID(), b: randomUUID() };
const BASE = "http://app.local/api/sb/storage/v1/";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  return `${h}.${p}.${createHmac("sha256", process.env.SUPABASE_JWT_SECRET!).update(`${h}.${p}`).digest("base64url")}`;
}
const TOKEN = { a: "", b: "", service: "" };

type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
/** Exactly what the browser sends: one request to the route, path split into segments. */
async function call(method: Method, segments: string[], token: string | null, init: { body?: BodyInit; headers?: Record<string, string>; query?: string } = {}) {
  const url = BASE + segments.map(encodeURIComponent).join("/") + (init.query ?? "");
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new NextRequest(url, { method, headers, body: init.body });
  const ctx = { params: Promise.resolve({ path: segments }) };
  return route[method](req, ctx);
}
const pdf = () => Buffer.from("%PDF-1.4 R1404 " + randomUUID());
const asBody = (b: Buffer): Blob => new Blob([new Uint8Array(b)]);
const upload = (token: string, segments: string[], body = pdf(), method: "POST" | "PUT" = "POST") =>
  call(method, ["object", ...segments], token, { body: asBody(body), headers: { "content-type": "application/pdf" } });
const download = (token: string | null, segments: string[]) => call("GET", ["object", ...segments], token);
const sign = (token: string, segments: string[]) =>
  call("POST", ["object", "sign", ...segments], token, { body: JSON.stringify({ expiresIn: 60 }), headers: { "content-type": "application/json" } });
const remove = (token: string, bucket: string, names: string[]) =>
  call("DELETE", ["object", bucket], token, { body: JSON.stringify({ prefixes: names }), headers: { "content-type": "application/json" } });
const rowExists = async (bucket: string, name: string) =>
  (await admin.query(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rowCount === 1;

let original: ReturnType<typeof pdf>;

beforeAll(async () => {
  await admin.connect();
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  for (const k of ["a", "b"] as const) {
    await admin.query(`insert into public.tenants (id, name, email) values ($1, $2, $3)`, [T[k], `Route ${k}`, `route-${k}-${T[k].slice(0, 6)}@example.test`]);
    await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [U[k], `route-${k}-${U[k].slice(0, 6)}@example.test`]);
    await admin.query(`insert into public.users (id, tenant_id, email, role) values ($1, $2, $3, 'owner')`, [U[k], T[k], `route-${k}-${U[k].slice(0, 6)}@example.test`]);
  }
  await admin.query("commit");
  TOKEN.a = jwt({ role: "authenticated", sub: U.a });
  TOKEN.b = jwt({ role: "authenticated", sub: U.b });
  TOKEN.service = jwt({ role: "service_role" });
  original = pdf();
  const up = await upload(TOKEN.a, ["documents", T.a, "private.pdf"], original);
  expect(up.status).toBe(200);
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

describe("the owner's own file (so a green run is not everything-404)", () => {
  test("A reads, signs and HEADs its own upload through the route", async () => {
    const res = await download(TOKEN.a, ["documents", T.a, "private.pdf"]);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
    expect((await call("HEAD", ["object", "documents", T.a, "private.pdf"], TOKEN.a)).status).toBe(200);
    expect((await sign(TOKEN.a, ["documents", T.a, "private.pdf"])).status).toBe(200);
  });
});

describe("another tenant's path through the route", () => {
  test("read: B cannot download or HEAD A's file (plain and /authenticated/ form)", async () => {
    expect((await download(TOKEN.b, ["documents", T.a, "private.pdf"])).status).toBe(404);
    expect((await download(TOKEN.b, ["authenticated", "documents", T.a, "private.pdf"])).status).toBe(404);
    expect((await call("HEAD", ["object", "documents", T.a, "private.pdf"], TOKEN.b)).status).toBe(404);
    expect((await download(null, ["documents", T.a, "private.pdf"])).status).toBe(404);
  });

  test("sign: B gets no signed URL for A's file, single or bulk", async () => {
    expect((await sign(TOKEN.b, ["documents", T.a, "private.pdf"])).status).toBe(404);
    const bulk = await call("POST", ["object", "sign", "documents"], TOKEN.b, {
      body: JSON.stringify({ expiresIn: 60, paths: [`${T.a}/private.pdf`] }), headers: { "content-type": "application/json" },
    });
    expect(bulk.status).toBe(200);
    const [entry] = (await bulk.json()) as { signedURL: string | null; error: string | null }[];
    expect(entry.signedURL).toBeNull();
    expect(entry.error).toMatch(/does not exist|access/);
  });

  test("upload: B cannot POST into A's folder, nor PUT over A's file; bytes and row untouched", async () => {
    const post = await upload(TOKEN.b, ["documents", T.a, "planted.pdf"]);
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(await rowExists("documents", `${T.a}/planted.pdf`)).toBe(false);

    const put = await upload(TOKEN.b, ["documents", T.a, "private.pdf"], pdf(), "PUT");
    expect(put.status).toBeGreaterThanOrEqual(400);
    const still = await download(TOKEN.a, ["documents", T.a, "private.pdf"]);
    expect(Buffer.from(await still.arrayBuffer()).equals(original)).toBe(true);

    /* x-upsert does not turn a refused insert into an update of A's row. */
    const upsert = await call("POST", ["object", "documents", T.a, "private.pdf"], TOKEN.b,
      { body: asBody(pdf()), headers: { "content-type": "application/pdf", "x-upsert": "true" } });
    expect(upsert.status).toBeGreaterThanOrEqual(400);
    const again = await download(TOKEN.a, ["documents", T.a, "private.pdf"]);
    expect(Buffer.from(await again.arrayBuffer()).equals(original)).toBe(true);
  });

  test("delete: B's remove of A's file deletes nothing", async () => {
    const del = await remove(TOKEN.b, "documents", [`${T.a}/private.pdf`]);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual([]);
    expect(await rowExists("documents", `${T.a}/private.pdf`)).toBe(true);
    expect((await download(TOKEN.a, ["documents", T.a, "private.pdf"])).status).toBe(200);
  });

  test("path tricks: a '..' segment never reaches A's folder from B's", async () => {
    const up = await upload(TOKEN.b, ["documents", T.b, "..", T.a, "sneaky.pdf"]);
    expect(up.status).toBeGreaterThanOrEqual(400);
    expect(await rowExists("documents", `${T.a}/sneaky.pdf`)).toBe(false);
    expect((await download(TOKEN.b, ["documents", T.b, "..", T.a, "private.pdf"])).status).toBeGreaterThanOrEqual(400);
  });

  test("service_role over HTTP is refused (401) — the cross-tenant key never works from a browser", async () => {
    expect((await download(TOKEN.service, ["documents", T.a, "private.pdf"])).status).toBe(401);
    expect((await upload(TOKEN.service, ["documents", T.a, "svc.pdf"])).status).toBe(401);
    expect((await remove(TOKEN.service, "documents", [`${T.a}/private.pdf`])).status).toBe(401);
    expect(await rowExists("documents", `${T.a}/private.pdf`)).toBe(true);
  });
});
