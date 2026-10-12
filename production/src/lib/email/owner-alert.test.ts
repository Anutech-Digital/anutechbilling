import { describe, it, expect } from "vitest";
import { resolveOwnerAlert } from "./owner-alert";

const T = "fbb976f1-9090-4f10-9726-0901bd144e42";

describe("resolveOwnerAlert", () => {
  it("uses the tenant's own recorded address", () => {
    const r = resolveOwnerAlert(
      { name: "ANUTECH DIGITAL PVT LTD", email: "pardeep@anutech.in", contact_name: "Pardeep Sharma" },
      T,
    );
    expect(r).toEqual({ ok: true, to: "pardeep@anutech.in", ownerName: "Pardeep Sharma" });
  });

  it("does NOT block a tenant whose own address is on the historical domain", () => {
    /* Tenant <client-tenant-id> really does have pardeep@example.test on file. CLAUDE.md §1
       calls that brand historical, but the tenant's contact address is the operator's data.
       Banning the domain here would silence a real tenant's own mail — and would also miss
       the identical bug the day somebody hardcodes pardeep@anutech.in instead. */
    const r = resolveOwnerAlert(
      { name: "Demo Co", email: "pardeep@example.test", contact_name: "Pardeep Sharma" },
      "<client-tenant-id>",
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.to).toBe("pardeep@example.test");
  });

  it("reports a missing tenant row instead of substituting an address", () => {
    const r = resolveOwnerAlert(null, T);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(T);
  });

  it("reports a tenant with no email, and says where to set it", () => {
    const r = resolveOwnerAlert({ name: "New Reseller", email: null }, T);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no email on file/i);
    expect(r.ok === false && r.reason).toMatch(/Settings/);
  });

  it("treats a whitespace-only email as missing", () => {
    /* An empty-looking cell in Postgres is frequently "   ", not NULL. Handing that to the
       transport produces a provider error nobody connects back to the tenant profile. */
    const r = resolveOwnerAlert({ email: "   " }, T);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no email on file/i);
  });

  it("trims a padded address rather than sending it padded", () => {
    const r = resolveOwnerAlert({ email: "  owner@example.in \n" }, T);
    expect(r.ok && r.to).toBe("owner@example.in");
  });

  it("refuses something that is not an address at all, naming the value", () => {
    const r = resolveOwnerAlert({ email: "pardeep" }, T);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("pardeep");
  });

  it("falls back from contact person to company name for the greeting, never to a placeholder", () => {
    expect(resolveOwnerAlert({ name: "Acme Cloud", email: "a@b.in" }, T)).toEqual({
      ok: true, to: "a@b.in", ownerName: "Acme Cloud",
    });
    /* No name at all → empty, NOT "your reseller" / "Employee". L4: a display placeholder
       that reaches a rule belongs to everybody. Callers decide how to word an empty name. */
    expect(resolveOwnerAlert({ email: "a@b.in" }, T)).toEqual({
      ok: true, to: "a@b.in", ownerName: "",
    });
  });

  it("never returns an address the caller did not supply", () => {
    /* The whole point. There is no constant in this module to leak, and this test fails if
       one is ever reintroduced as a fallback. */
    for (const t of [null, undefined, {}, { email: "" }, { email: "nope" }, { name: "x" }]) {
      const r = resolveOwnerAlert(t, T);
      expect(r.ok, JSON.stringify(t)).toBe(false);
    }
  });
});
