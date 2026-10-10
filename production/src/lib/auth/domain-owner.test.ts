/**
 * R-822 (10 Oct 2026): which workspace owns a company email domain when no
 * `tenant_domains` row is verified — decided from existing owners' VERIFIED emails.
 */
import { describe, it, expect } from "vitest";
import { resolveOwnerDomainTenant, type OwnerDomainRecord } from "./domain";

const REAL = "11111111-1111-4111-8111-111111111111";
const COPY = "22222222-2222-4222-8222-222222222222";

const owner = (o: Partial<OwnerDomainRecord>): OwnerDomainRecord => ({
  tenant_id: REAL,
  tenant_name: "ANUTECH DIGITAL PVT LTD",
  tenant_created_at: "2026-05-26T00:00:00Z",
  owner_email: "pardeep@anutech.in",
  owner_verified: true,
  ...o,
});

describe("resolveOwnerDomainTenant", () => {
  it("a verified owner at the same domain owns it", () => {
    expect(resolveOwnerDomainTenant("pawan@anutech.in", [owner({})])).toEqual({
      tenant_id: REAL,
      tenant_name: "ANUTECH DIGITAL PVT LTD",
    });
  });

  it("an UNVERIFIED owner email routes nobody", () => {
    expect(resolveOwnerDomainTenant("pawan@anutech.in", [owner({ owner_verified: false })])).toBeNull();
  });

  it("free-mail domains never match, even with a verified owner on them", () => {
    for (const d of ["gmail.com", "yahoo.co.in", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "rediffmail.com"]) {
      expect(resolveOwnerDomainTenant(`someone@${d}`, [owner({ owner_email: `boss@${d}` })])).toBeNull();
    }
  });

  it("a different domain does not match (no suffix tricks)", () => {
    expect(resolveOwnerDomainTenant("x@evil-anutech.in", [owner({})])).toBeNull();
    expect(resolveOwnerDomainTenant("x@mail.anutech.in", [owner({})])).toBeNull();
  });

  it("several workspaces on one domain → the oldest wins (the real company predates copies)", () => {
    const rows = [
      owner({ tenant_id: COPY, tenant_name: "Anutech", tenant_created_at: "2026-10-10T10:00:00Z", owner_email: "pawan@anutech.in" }),
      owner({}),
    ];
    expect(resolveOwnerDomainTenant("new@anutech.in", rows)?.tenant_id).toBe(REAL);
  });

  it("an unverified copy never beats a verified newer one", () => {
    const rows = [
      owner({ tenant_id: COPY, tenant_created_at: "2026-01-01T00:00:00Z", owner_verified: false }),
      owner({}),
    ];
    expect(resolveOwnerDomainTenant("new@anutech.in", rows)?.tenant_id).toBe(REAL);
  });

  it("garbage input is no signal", () => {
    expect(resolveOwnerDomainTenant("", [owner({})])).toBeNull();
    expect(resolveOwnerDomainTenant("not-an-email", [owner({})])).toBeNull();
    expect(resolveOwnerDomainTenant(null, [owner({})])).toBeNull();
  });
});
