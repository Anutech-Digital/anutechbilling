/**
 * R-051 part 3 — the admin client tells the audit trigger who it is acting for.
 * The DB half (only service_role is believed, clients cannot spoof) is proven in
 * supabase/tests/audit_actor_admin_writes.test.sql.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ssr = vi.hoisted(() => ({ calls: [] as Array<{ url: string; key: string; opts: { global?: { headers?: Record<string, string> } } }> }));
vi.mock("@/lib/sentry", () => ({}));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ getAll: () => [], set: () => {} }) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, opts: { global?: { headers?: Record<string, string> } }) => {
    ssr.calls.push({ url, key, opts });
    return { marker: "client" };
  },
}));

import { actorHeaders, ACTOR_HEADER } from "./admin-actor";
import { createAdminClient, createAdminClientFor } from "./server";

const UID = "dddddddd-0000-0000-0000-000000051301";

beforeEach(() => {
  ssr.calls = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://db.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-test";
});

describe("actorHeaders", () => {
  it("names a valid user id in x-actor-id (lower-cased, trimmed)", () => {
    expect(ACTOR_HEADER).toBe("x-actor-id");
    expect(actorHeaders(UID)).toEqual({ "x-actor-id": UID });
    expect(actorHeaders(`  ${UID.toUpperCase()} `)).toEqual({ "x-actor-id": UID });
  });

  it("sends nothing for an empty or non-uuid id (the DB would ignore it anyway)", () => {
    for (const bad of [null, undefined, "", "U1", "1; drop table users", `${UID}x`, `${UID},${UID}`]) {
      expect(actorHeaders(bad)).toEqual({});
    }
  });
});

describe("createAdminClientFor", () => {
  it("is the service-role client plus the actor header", () => {
    createAdminClientFor(UID);
    expect(ssr.calls).toHaveLength(1);
    expect(ssr.calls[0].key).toBe("service-key-for-test");
    expect(ssr.calls[0].opts.global?.headers).toEqual({ "x-actor-id": UID });
  });

  it("plain createAdminClient sends no actor (cron / webhook writes stay unattributed)", () => {
    createAdminClient();
    expect(ssr.calls[0].opts.global?.headers).toEqual({});
  });

  it("an invalid id falls back to the plain admin client, it does not throw", () => {
    createAdminClientFor("not-a-uuid");
    expect(ssr.calls[0].opts.global?.headers).toEqual({});
  });

  it("still refuses without the service-role key", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => createAdminClientFor(UID)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("migration contract", () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, "../../../supabase/migrations/20261007240000_audit_actor_admin_writes.sql"),
    "utf8",
  );
  it("reads the same header name the client sends, and only for service_role", () => {
    expect(sql).toContain(`->> '${ACTOR_HEADER}'`);
    expect(sql).toMatch(/v_role <> 'service_role'/);
    expect(sql).toMatch(/revoke all on function public\.audit_service_actor\(\) from anon, authenticated/);
  });
  it("starts with the deploy-peek header gen-deploy-db needs", () => {
    expect(sql.split("\n")[0]).toMatch(/^-- deploy-peek: /);
  });
});
