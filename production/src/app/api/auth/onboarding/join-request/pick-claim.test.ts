import { describe, expect, it } from "vitest";
import { pickJoinClaim } from "./pick-claim";

const row = (tenant_id: string, verified_at: string | null) => ({ tenant_id, verified_at, tenants: { name: tenant_id } });

describe("pickJoinClaim (R-858: several unverified claims per domain)", () => {
  it("no claim → null", () => {
    expect(pickJoinClaim([])).toBeNull();
    expect(pickJoinClaim(null)).toBeNull();
  });

  it("one claim → that claim (unchanged behaviour)", () => {
    expect(pickJoinClaim([row("a", null)])?.tenant_id).toBe("a");
  });

  it("the verified company wins over any number of unverified claims, in any order", () => {
    expect(pickJoinClaim([row("squat", null), row("real", "2026-10-23T00:00:00Z"), row("other", null)])?.tenant_id).toBe("real");
  });

  it("several unverified claims and none verified → nobody (never guess between them)", () => {
    expect(pickJoinClaim([row("a", null), row("b", null)])).toBeNull();
  });
});
