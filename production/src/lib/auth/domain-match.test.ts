/**
 * Domain → tenant matching, for ANUTECH DIGITAL PVT LTD.
 *
 * ─── WHAT THESE TESTS CAN AND CANNOT PROVE ───────────────────────────────────
 * The mapping from a domain to a tenant is DATA (`tenant_domains` rows, migration
 * 0242), not code. So these tests prove the ALGORITHM: given a set of claims, who
 * gets routed where, and — more importantly — who does not.
 *
 * They do NOT prove which domains ANUTECH DIGITAL owns in production. As of
 * 14 Aug 2026 that is exactly one verified claim, `anutech.in`. The fixtures below
 * that give it `anutechbilling.in` and `example.test` are a scenario, not a
 * statement about the live database. Making them true in production is two INSERTs
 * plus verification, not a code change — which is the point of putting ownership in
 * a table.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDomainOwner,
  decideOnboarding,
  type TenantDomainRecord,
} from "./domain";

const ANUTECH_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";
const ANUTECH = "ANUTECH DIGITAL PVT LTD";
const VERIFIED = "2026-08-14T00:00:00Z";

/** Scenario: all three company domains verified to the one workspace. */
const CLAIMS: TenantDomainRecord[] = [
  { tenant_id: ANUTECH_ID, tenant_name: ANUTECH, domain: "anutech.in",           verified_at: VERIFIED },
  { tenant_id: ANUTECH_ID, tenant_name: ANUTECH, domain: "anutechbilling.in",    verified_at: VERIFIED },
  { tenant_id: ANUTECH_ID, tenant_name: ANUTECH, domain: "example.test", verified_at: VERIFIED },
];

describe("resolveDomainOwner — the three ANUTECH DIGITAL domains", () => {
  it.each([
    ["pardeep@anutech.in",            "anutech.in"],
    ["darshan@anutechbilling.in",     "anutechbilling.in"],
    ["staff@example.test", "example.test"],
  ])("routes %s to ANUTECH DIGITAL PVT LTD", (email) => {
    expect(resolveDomainOwner(email, CLAIMS)).toEqual({
      tenant_id: ANUTECH_ID,
      tenant_name: ANUTECH,
    });
  });

  it("one tenant owning several domains is normal, not a conflict", () => {
    const owners = new Set(
      ["a@anutech.in", "b@anutechbilling.in", "c@example.test"]
        .map((e) => resolveDomainOwner(e, CLAIMS)?.tenant_id),
    );
    expect(owners).toEqual(new Set([ANUTECH_ID]));
  });

  it("is case- and whitespace-insensitive on both sides", () => {
    const shouty: TenantDomainRecord[] = [
      { ...CLAIMS[0], domain: "  AnuTech.IN  " },
    ];
    expect(resolveDomainOwner("  Pardeep@ANUTECH.in ", shouty)?.tenant_id).toBe(ANUTECH_ID);
  });
});

describe("resolveDomainOwner — what must NOT match", () => {
  it("an UNVERIFIED claim routes nobody, even on an exact domain hit", () => {
    // This is the tenant-leak guard. example.test is claimed-but-unverified
    // in the live database precisely because its ownership is not settled.
    const unverified: TenantDomainRecord[] = [
      { ...CLAIMS[2], verified_at: null },
    ];
    expect(resolveDomainOwner("staff@example.test", unverified)).toBeNull();
  });

  it("ignores an unverified row and still finds a verified one for the same domain", () => {
    const mixed: TenantDomainRecord[] = [
      { tenant_id: "t-junk", tenant_name: "Junk", domain: "anutech.in", verified_at: null },
      { tenant_id: ANUTECH_ID, tenant_name: ANUTECH, domain: "anutech.in", verified_at: VERIFIED },
    ];
    expect(resolveDomainOwner("pardeep@anutech.in", mixed)?.tenant_id).toBe(ANUTECH_ID);
  });

  it("a consumer mailbox provider is never routed, even if someone claimed it", () => {
    // Guards the failure where one tenant claims gmail.com and every future
    // consumer signup on the platform is funnelled into that workspace.
    const bad: TenantDomainRecord[] = [
      { tenant_id: ANUTECH_ID, tenant_name: ANUTECH, domain: "gmail.com", verified_at: VERIFIED },
    ];
    expect(resolveDomainOwner("someone@gmail.com", bad)).toBeNull();
  });

  it("a domain nobody claimed routes nobody", () => {
    expect(resolveDomainOwner("hello@abccloud.in", CLAIMS)).toBeNull();
  });

  it("a near-miss domain does not match — no fuzzy, no suffix matching", () => {
    for (const email of [
      "x@anutech.co.in",        // different TLD
      "x@notanutech.in",        // suffix of a claim
      "x@anutech.in.evil.com",  // claim as a prefix of an attacker domain
      "x@sub.anutech.in",       // subdomain is a different domain
    ]) {
      expect(resolveDomainOwner(email, CLAIMS)).toBeNull();
    }
  });

  it("garbage input routes nobody instead of throwing", () => {
    for (const bad of ["", "not-an-email", "@anutech.in", "trailing@", null, undefined]) {
      expect(resolveDomainOwner(bad, CLAIMS)).toBeNull();
    }
  });

  it("an empty claims table routes nobody", () => {
    expect(resolveDomainOwner("pardeep@anutech.in", [])).toBeNull();
  });
});

describe("domain match feeds the onboarding decision — and can only ask", () => {
  it("a matched domain produces request_approval, never join", () => {
    const match = resolveDomainOwner("darshan@anutech.in", CLAIMS);
    const decision = decideOnboarding({ invite: null, domainMatch: match });
    expect(decision).toEqual({
      mode: "request_approval",
      tenantId: ANUTECH_ID,
      tenantName: ANUTECH,
    });
  });

  it("no match sends them to the onboarding fork, not to a new tenant", () => {
    const match = resolveDomainOwner("owner@abccloud.in", CLAIMS);
    expect(decideOnboarding({ invite: null, domainMatch: match })).toEqual({ mode: "choose" });
  });

  it("an explicit invite outranks the domain, and carries the invited role", () => {
    const match = resolveDomainOwner("darshan@anutech.in", CLAIMS);
    const decision = decideOnboarding({
      invite: { tenant_id: "t-somewhere-else", role: "billing" },
      domainMatch: match,
    });
    expect(decision).toEqual({ mode: "join", tenantId: "t-somewhere-else", role: "billing" });
  });

  it("no input to this module can ever produce a new tenant", () => {
    const inputs = [
      { invite: null, domainMatch: resolveDomainOwner("a@anutech.in", CLAIMS) },
      { invite: null, domainMatch: resolveDomainOwner("a@gmail.com", CLAIMS) },
      { invite: null, domainMatch: resolveDomainOwner("a@unknown.in", CLAIMS) },
      { invite: { tenant_id: "", role: "sales" as const }, domainMatch: null },
    ];
    for (const i of inputs) {
      expect(["join", "request_approval", "choose"]).toContain(decideOnboarding(i).mode);
    }
  });
});
