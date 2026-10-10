/**
 * The first route on the Prisma path, checked against a real database: a tenant sees its
 * own Gmail sender, and naming another tenant's sender user gets nothing back — where the
 * old code read both with the service-role key.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { disconnectDb } from "@/server/db";
import { emailSenderFor } from "@/server/settings/email-sender";

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
const t = { a: randomUUID(), b: randomUUID() };
const u = { a: randomUUID(), b: randomUUID() };

beforeAll(async () => {
  await admin.connect();
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  for (const k of ["a", "b"] as const) {
    await admin.query(`insert into public.tenants (id, name, email) values ($1, $2, $3)`, [t[k], `Sender ${k}`, `s-${k}@example.test`]);
    await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [u[k], `sender-${k}-${u[k].slice(0, 6)}@example.test`]);
    await admin.query(`insert into public.users (id, tenant_id, email, role) values ($1, $2, $3, 'owner')`, [u[k], t[k], `sender-${k}-${u[k].slice(0, 6)}@example.test`]);
  }
  // Tenant A is on Gmail with ITS sender; then point A at B's user to simulate a bad row.
  await admin.query(`update public.tenants set email_provider = 'gmail', gmail_sender_user_id = $1 where id = $2`, [u.a, t.a]);
  await admin.query(`update public.tenants set email_provider = 'gmail', gmail_sender_user_id = $1 where id = $2`, [u.b, t.b]);
  await admin.query("commit");
});

afterAll(async () => {
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`delete from public.users where id = any($1::uuid[])`, [[u.a, u.b]]);
  await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[u.a, u.b]]);
  await admin.query(`delete from public.tenants where id = any($1::uuid[])`, [[t.a, t.b]]);
  await admin.query("commit");
  await admin.end();
  await disconnectDb();
});

test("a tenant sees its own Gmail sender address", async () => {
  expect(await emailSenderFor({ userId: u.a, tenantId: t.a })).toEqual({
    provider: "gmail", address: `sender-a-${u.a.slice(0, 6)}@example.test`,
  });
});

test("a sender user from ANOTHER tenant is never revealed", async () => {
  await admin.query(`update public.tenants set gmail_sender_user_id = $1 where id = $2`, [u.b, t.a]);
  expect(await emailSenderFor({ userId: u.a, tenantId: t.a })).toEqual({ provider: "gmail", address: null });
});

test("a forged session (A's user, B's tenant) learns nothing about B", async () => {
  expect(await emailSenderFor({ userId: u.a, tenantId: t.b })).toEqual({ provider: null, address: null });
});
