import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renewalRisk } from "./risk";
import { openRenewalQuoteMap, withRenewalQuote } from "./open-renewal-quotes";

const base = { seats: 5, used: 0, outstanding_amount: 0, plan: "Business Starter", used_synced_at: null as string | null };

describe("R-453: seat usage counts only when it was checked", () => {
  it("unchecked seats (used 0, never synced) are NOT 'HIGH RISK · Low seat usage (0%)'", () => {
    /* Gupta Infotech, Scenario 9: Starter (15) + 0% usage (40) = 55 → HIGH RISK, on a
       number nobody measured. */
    const r = renewalRisk(base);
    expect(r.level).not.toBe("high");
    expect(r.reasons.join(" ")).not.toMatch(/Low seat usage/);
    expect(r.reasons).toContain("Seat usage not checked");
  });

  it("checked low usage still counts, exactly as before", () => {
    const r = renewalRisk({ ...base, used: 0, used_synced_at: "2026-10-01T00:00:00Z" });
    expect(r.reasons[0]).toBe("Low seat usage (0%)");
    expect(r.level).toBe("high");
  });

  it("an unpaid balance is still a real signal without usage", () => {
    const r = renewalRisk({ ...base, outstanding_amount: 956 });
    expect(r.reasons[0]).toMatch(/^Unpaid balance/);
    expect(r.level).toBe("medium");   // 35 unpaid + 15 Starter
  });

  it("the page uses this file, not its own copy", () => {
    const src = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    expect(src).toContain('from "./risk"');
    expect(src).not.toMatch(/function renewalRisk\(/);
  });
});

describe("R-453: an open renewal quote shows 'Open quote', not 'Generate quote'", () => {
  const SUB = "93302f12-22e9-4a80-89be-79f511290e19";
  const map = openRenewalQuoteMap([
    { id: "Q-DEMO-27-0009", notes: `Renewal quote (operator-generated) for subscription ${SUB}` },
    { id: "Q-OLD", notes: `Renewal quote for subscription ${SUB}` },
    { id: "Q-X", notes: "something else" },
  ]);

  it("finds the quote by the subscription id in its notes (newest first)", () => {
    expect(map.get(SUB)).toBe("Q-DEMO-27-0009");
    expect(map.size).toBe(1);
  });

  it("fills an empty renewal_quote_id and never overrides a set one", () => {
    expect(withRenewalQuote({ id: SUB, renewal_quote_id: null }, map).renewal_quote_id).toBe("Q-DEMO-27-0009");
    expect(withRenewalQuote({ id: SUB, renewal_quote_id: "Q-LINKED" }, map).renewal_quote_id).toBe("Q-LINKED");
    expect(withRenewalQuote({ id: "00000000-0000-4000-8000-000000000000", renewal_quote_id: null }, map).renewal_quote_id).toBeNull();
  });
});
