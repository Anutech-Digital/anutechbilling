/**
 * R-2445 — the "Prove you own this GSTIN" step shown in Settings → Network, and the migration
 * that makes ownership (not registration) the identity for every network function.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { toOwnership, ownershipStep, mayConnect } from "./ownership";

const base = {
  gstin: "29AAACR2445B1Z5", gstin_verified: true, owner_verified: false, held_by_other: false,
  claim_status: null as string | null,
};

describe("R-2445 ownershipStep", () => {
  it("registered is not owned: a verified GSTIN that was never proved asks to prove it", () => {
    expect(ownershipStep(toOwnership(base))).toBe("ask");
    expect(mayConnect(toOwnership(base))).toBe(false);
  });
  it("no GSTIN / not verified with GSTN → Settings → Company first", () => {
    expect(ownershipStep(toOwnership({ ...base, gstin: null }))).toBe("no_gstin");
    expect(ownershipStep(toOwnership({ ...base, gstin_verified: false }))).toBe("no_gstin");
    expect(ownershipStep(toOwnership(null))).toBe("no_gstin");
  });
  it("proved → can connect", () => {
    const o = toOwnership({ ...base, owner_verified: true, owner_verified_how: "platform_admin" });
    expect(ownershipStep(o)).toBe("owned");
    expect(mayConnect(o)).toBe(true);
  });
  it("another business proved this GSTIN → support step, even with an old pending claim", () => {
    expect(ownershipStep(toOwnership({ ...base, held_by_other: true, claim_status: "pending" }))).toBe("held_by_other");
  });
  it("pending → waiting; rejected / revoked → reason + ask again; withdrawn → ask", () => {
    expect(ownershipStep(toOwnership({ ...base, claim_status: "pending" }))).toBe("pending");
    expect(ownershipStep(toOwnership({ ...base, claim_status: "rejected" }))).toBe("ask_again");
    expect(ownershipStep(toOwnership({ ...base, claim_status: "revoked" }))).toBe("ask_again");
    expect(ownershipStep(toOwnership({ ...base, claim_status: "withdrawn" }))).toBe("ask");
  });
});

describe("R-2445 migration", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = fs.readdirSync(dir).find((f) => /_r2445_gstin_owner_verified\.sql$/.test(f));
  const sql = file ? fs.readFileSync(path.join(dir, file), "utf8") : "";

  it("exists, newer than R-2433, with a deploy-peek first line", () => {
    expect(file).toBeTruthy();
    expect(file! > "20261103195606_r2433_tenant_connections.sql").toBe(true);
    expect(sql.split("\n")[0]).toMatch(/^-- deploy-peek: /);
  });

  it("every network function that decides who connects uses the ownership check", () => {
    for (const fn of ["network_has_scope", "network_request_connection", "network_respond_connection", "network_suggestions", "network_my_connections"]) {
      const m = sql.match(new RegExp(`create (or replace )?function public\\.${fn}\\([\\s\\S]*?\\$function\\$;`));
      expect(m, fn).toBeTruthy();
      expect(m![0], fn).toMatch(/network_gstin_owned/);
    }
  });

  it("the platform functions and the ownership check are never granted to request roles", () => {
    for (const fn of ["platform_gstin_claims", "platform_decide_gstin_claim", "platform_revoke_gstin_owner", "network_gstin_owned"]) {
      expect(sql, fn).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to [^;]*\\b(authenticated|anon)\\b`));
    }
  });
});
