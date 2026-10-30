/**
 * R-2125 (GP-10) — the data gateway's deny-by-default list for personal sessions.
 *
 * Two halves:
 *   1. checkPersonalRequest (pure): what a personal caller may reach through /api/sb/rest/v1.
 *   2. The ratchet: every `function public.personal_*` in supabase/migrations, and every function
 *      tagged `-- personal-rpc`, is on PERSONAL_RPCS — so a card that adds a personal RPC cannot
 *      ship a page whose call the gateway refuses. And the list only grows (APPEND_ONLY_BASELINE).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  PERSONAL_RPCS, PERSONAL_TABLES, checkPersonalRequest, personalRpcsInMigrations,
} from "./personal-allowlist";

const q = (s: string) => new URLSearchParams(s);

describe("R-2125 personal caller — refused", () => {
  test("rpc/generate_invoice and rpc/record_payment are refused (403)", () => {
    for (const fn of ["generate_invoice", "record_payment"]) {
      const r = checkPersonalRequest("POST", `rpc/${fn}`, q(""));
      expect(r?.status).toBe(403);
      expect(r?.code).toBe("ROS_PERSONAL");
      expect(r?.reason).toBe("personal");
      expect(r?.message).toMatch(/personal account/i);
    }
  });
  test("a GET rpc call is refused the same way", () => {
    expect(checkPersonalRequest("GET", "rpc/nav_badges", q(""))?.status).toBe(403);
  });
  test("business tables are refused, every method", () => {
    for (const t of ["customers", "invoices", "quotes", "payments", "leads", "employees"]) {
      for (const m of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) {
        expect(checkPersonalRequest(m, t, q("select=id"))?.status).toBe(403);
      }
    }
  });
  test("tenants?select=*,customers(*) is refused — an allowed table cannot embed a business one", () => {
    const r = checkPersonalRequest("GET", "tenants", q("select=*,customers(*)"));
    expect(r?.status).toBe(403);
    expect(r?.message).toMatch(/customers/);
  });
  test("embeds are walked at every depth, aliases and hints do not hide the table", () => {
    expect(checkPersonalRequest("GET", "personal_transactions", q("select=id,personal_accounts(id,tenants(id,invoices(*)))"))?.status).toBe(403);
    expect(checkPersonalRequest("GET", "users", q("select=id,x:customers!inner(id)"))?.status).toBe(403);
    expect(checkPersonalRequest("GET", "personal_accounts", q("select=id,tenants!customers_tenant_id_fkey(id)"))).toBeNull();
  });
  test("an embed on an allowed RPC's result is walked too", () => {
    expect(checkPersonalRequest("POST", "rpc/personal_my_invoices", q("select=*,customers(*)"))?.status).toBe(403);
  });
  test("read-only tables refuse writes", () => {
    for (const t of ["users", "tenants"]) {
      for (const m of ["POST", "PATCH", "DELETE"]) expect(checkPersonalRequest(m, t, q(""))?.status).toBe(403);
    }
  });
  test("the PIN hash and the identity link are not on the list (served by server routes / RPCs)", () => {
    expect(checkPersonalRequest("GET", "personal_vault_pin", q("select=*"))?.status).toBe(403);
    expect(checkPersonalRequest("GET", "personal_identity_link", q("select=*"))?.status).toBe(403);
  });
  test("a select the parser cannot read is refused (no guessing which tables it names)", () => {
    expect(checkPersonalRequest("GET", "personal_accounts", q("select=id,customers(id"))?.status).toBe(403);
  });
});

describe("R-2125 personal caller — allowed", () => {
  test("personal_transactions: read, add, edit, delete", () => {
    for (const m of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) {
      expect(checkPersonalRequest(m, "personal_transactions", q("select=*"))).toBeNull();
    }
  });
  test("every personal money page table is reachable", () => {
    for (const t of ["personal_accounts", "personal_transactions", "personal_holdings", "personal_categories",
      "personal_category_rules", "personal_import_batches"]) {
      expect(checkPersonalRequest("GET", t, q("select=*"))).toBeNull();
    }
  });
  test("own user / workspace rows can be read (app shell, personal-vault requireIdentity)", () => {
    expect(checkPersonalRequest("GET", "users", q("select=tenant_id&id=eq.x"))).toBeNull();
    expect(checkPersonalRequest("GET", "tenants", q("select=id,name"))).toBeNull();
    expect(checkPersonalRequest("PATCH", "notifications", q("id=eq.1"))).toBeNull();
  });
  test("personal RPCs and the sidebar's workspace RPC", () => {
    for (const fn of ["personal_import_commit", "personal_my_invoices", "personal_my_quotes",
      "personal_my_payments", "personal_my_subscriptions", "get_my_tenant_with_parent"]) {
      expect(checkPersonalRequest("POST", `rpc/${fn}`, q(""))).toBeNull();
    }
  });
  test("an embed between allowed tables is fine", () => {
    expect(checkPersonalRequest("GET", "personal_transactions", q("select=id,personal_accounts(name)"))).toBeNull();
  });
});

/* ── the ratchet ─────────────────────────────────────────────────────────────────────────── */

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS, f), "utf8") }));

/** The list as it stood when each entry was added. Entries are never taken off (a page breaks). */
const APPEND_ONLY_BASELINE = {
  rpcs: ["personal_import_commit", "personal_my_invoices", "personal_my_quotes", "personal_my_payments",
    "personal_my_subscriptions", "get_my_tenant_with_parent"],
  tables: ["personal_accounts", "personal_transactions", "personal_holdings", "personal_categories",
    "personal_category_rules", "personal_import_batches", "users", "tenants", "notifications"],
};

describe("R-2125 ratchet — every personal RPC in the migrations is on the list", () => {
  test("the scan finds the known ones (it is not silently empty)", () => {
    const found = personalRpcsInMigrations(migrationFiles());
    for (const fn of ["personal_import_commit", "personal_my_invoices", "personal_my_quotes",
      "personal_my_payments", "personal_my_subscriptions"]) expect(found).toContain(fn);
  });
  test("no personal_* / -- personal-rpc function is missing from PERSONAL_RPCS", () => {
    const missing = personalRpcsInMigrations(migrationFiles()).filter((fn) => !PERSONAL_RPCS.includes(fn));
    expect(missing, `Add these to PERSONAL_RPCS in src/server/postgrest/personal-allowlist.ts: ${missing.join(", ")}`).toEqual([]);
  });
  test("the ratchet trips when a personal_* function exists but is not listed", () => {
    const extra = [{ name: "29990101000000_x.sql", sql: "create or replace function public.personal_new_thing(p jsonb)\nreturns void language sql as $$ select 1 $$;" }];
    const found = personalRpcsInMigrations([...migrationFiles(), ...extra]);
    expect(found).toContain("personal_new_thing");
    expect(found.filter((fn) => !PERSONAL_RPCS.includes(fn))).toEqual(["personal_new_thing"]);
  });
  test("a function tagged -- personal-rpc counts even without the personal_ prefix", () => {
    const tagged = [
      { name: "a.sql", sql: "-- personal-rpc\ncreate function public.my_money_summary() returns int language sql as $$ select 1 $$;" },
      { name: "b.sql", sql: "create or replace function public.money_totals() -- personal-rpc\nreturns int language sql as $$ select 1 $$;" },
      { name: "c.sql", sql: "-- personal-rpc: vault_overview, vault_net_worth\n" },
      { name: "d.sql", sql: "create function public.generate_invoice() returns int language sql as $$ select 1 $$;" },
    ];
    expect(personalRpcsInMigrations(tagged).sort()).toEqual(["money_totals", "my_money_summary", "vault_net_worth", "vault_overview"]);
  });
  test("append-only: nothing on the baseline has been taken off the list", () => {
    for (const fn of APPEND_ONLY_BASELINE.rpcs) expect(PERSONAL_RPCS).toContain(fn);
    for (const t of APPEND_ONLY_BASELINE.tables) expect(Object.keys(PERSONAL_TABLES)).toContain(t);
  });
  test("no business-power RPC or table is on the list", () => {
    for (const fn of ["generate_invoice", "record_payment", "nav_badges", "delete_customer"]) expect(PERSONAL_RPCS).not.toContain(fn);
    for (const t of ["customers", "invoices", "quotes", "payments", "personal_vault_pin", "personal_identity_link"]) {
      expect(Object.keys(PERSONAL_TABLES)).not.toContain(t);
    }
  });
});
