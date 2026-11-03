import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NETWORK_SCOPES, cleanScopes, toggleScope, scopesSentence, normalizeGstinInput, looksLikeGstin, LIVE_SCOPES,
} from "./scopes";
import { toConnection } from "./client";

const MIGRATION = fs.readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20261103193313_r2433_tenant_connections.sql"), "utf8");

describe("network scopes (R-2433)", () => {
  it("match the database's list exactly", () => {
    const m = /network_scope_list\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(MIGRATION);
    expect(m, "network_scope_list body not found").toBeTruthy();
    const db = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(db).toEqual([...NETWORK_SCOPES]);
  });

  it("cleanScopes keeps known ones once, in order, and drops unknown words", () => {
    expect(cleanScopes(["payments", " Invoices", "payments", "everything"])).toEqual(["invoices", "payments"]);
    expect(cleanScopes(null)).toEqual([]);
  });

  it("toggleScope adds and removes one scope", () => {
    expect(toggleScope(["invoices"], "partner_metrics", true)).toEqual(["invoices", "partner_metrics"]);
    expect(toggleScope(["invoices", "partner_metrics"], "partner_metrics", false)).toEqual(["invoices"]);
  });

  it("scopesSentence reads plainly", () => {
    expect(scopesSentence(["pos", "invoices"])).toBe("Invoices, Purchase orders");
    expect(scopesSentence([])).toBe("Nothing yet");
  });

  it("GSTIN input is matched without spaces, upper case", () => {
    expect(normalizeGstinInput(" 07abcde1234f1z5 ")).toBe("07ABCDE1234F1Z5");
    expect(looksLikeGstin("07abcde 1234f1z5")).toBe(true);
    expect(looksLikeGstin("07ABCDE")).toBe(false);
  });

  it("only partner metrics is live today (the rest are later G-NETWORK cards)", () => {
    expect([...LIVE_SCOPES]).toEqual(["partner_metrics"]);
  });
});

describe("toConnection (R-2433)", () => {
  it("maps a network_my_connections row", () => {
    const c = toConnection({
      id: "x", other_tenant_id: "t", other_name: "B", other_gstin: "29ABCDE1234F1Z5", status: "accepted",
      direction: "received", my_scopes: ["partner_metrics", "bogus"], their_scopes: ["catalogue"], related_party: true,
      origin: "parent_link", requested_at: "2026-11-03T00:00:00Z", responded_at: null, revoked_at: null, revoked_by_me: false,
    });
    expect(c).toMatchObject({ direction: "received", myScopes: ["partner_metrics"], theirScopes: ["catalogue"], relatedParty: true, origin: "parent_link" });
  });
});

describe("cross-company access goes only through definer functions (R-2433)", () => {
  const files = [
    path.join(process.cwd(), "src", "lib", "network", "client.ts"),
    path.join(process.cwd(), "src", "app", "(app)", "settings", "network-tab.tsx"),
  ].map((f) => fs.readFileSync(f, "utf8"));

  it("the browser never reads the table directly", () => {
    for (const src of files) expect(src).not.toMatch(/from\(\s*["']tenant_connections["']\s*\)/);
  });

  it("every rpc the client calls is defined, security definer, and granted to authenticated only", () => {
    const called = [...files[0].matchAll(/call\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThanOrEqual(6);
    for (const fn of called) {
      const def = new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?security definer\\s*\\nset search_path to 'public'`).exec(MIGRATION);
      expect(def, `${fn}: no SECURITY DEFINER definition with search_path`).toBeTruthy();
      expect(MIGRATION).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon;`));
      expect(MIGRATION).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`));
    }
  });

  it("the internal check and the table have no grant to request roles", () => {
    expect(MIGRATION).toMatch(/revoke all on public\.tenant_connections from public, anon, authenticated;/);
    expect(MIGRATION).toMatch(/revoke all on function public\.network_has_scope\(uuid, uuid, text\) from public, anon, authenticated;/);
    expect(MIGRATION).not.toMatch(/grant [a-z, ]+ on (table )?public\.tenant_connections to (anon|authenticated)/);
    expect(MIGRATION).not.toMatch(/grant execute on function public\.network_has_scope/);
  });
});
