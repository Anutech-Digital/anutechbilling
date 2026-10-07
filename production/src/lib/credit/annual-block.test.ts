import { describe, it, expect, vi } from "vitest";
import {
  ANNUAL_OVERRIDE_MIN_REASON, annualLineNames, annualCreditDecision, activateQuoteOnCredit,
} from "./activate-on-credit";

const monthly = { commitment: "monthly", name: "Workspace Starter (flex)" };
const annual = { commitment: "annual_yearly", name: "Workspace Business Standard" };
const legacyQuarterly = { commitment: "quarterly", name: "Old quarterly plan" };
const oneTime = { commitment: "one_time", name: "Setup fee" };
const noCommit = { name: "Domain" };

describe("annual plans are blocked from activate-on-credit (R-368)", () => {
  it("finds annual lines (annual_yearly, legacy terms); monthly, one-time and plain lines are not annual", () => {
    expect(annualLineNames([monthly, oneTime, noCommit])).toEqual([]);
    expect(annualLineNames([monthly, annual])).toEqual(["Workspace Business Standard"]);
    expect(annualLineNames([legacyQuarterly])).toEqual(["Old quarterly plan"]);
    expect(annualLineNames([{ commitment: "annual_monthly" }])).toEqual(["Annual plan"]);
    expect(annualLineNames(null)).toEqual([]);
  });

  it("monthly-only quote: allowed, no override needed", () => {
    expect(annualCreditDecision([monthly], "sales", "")).toEqual({ kind: "allowed" });
  });

  it("annual line + not owner: blocked, says why and who can", () => {
    const d = annualCreditDecision([monthly, annual], "billing", "");
    expect(d.kind).toBe("blocked");
    if (d.kind === "blocked") {
      expect(d.reason).toMatch(/Annual plans need payment first/);
      expect(d.reason).toMatch(/owner/i);
    }
  });

  it("annual line + owner without a reason: needs override", () => {
    expect(annualCreditDecision([annual], "owner", "").kind).toBe("needs-override");
    expect(annualCreditDecision([annual], "owner", "   ok   ").kind).toBe("needs-override");
  });

  it("annual line + owner with a reason: overridden, reason trimmed", () => {
    const d = annualCreditDecision([annual], "owner", "  Old customer, pays every year on time  ");
    expect(d).toEqual({ kind: "overridden", reason: "Old customer, pays every year on time" });
    expect(ANNUAL_OVERRIDE_MIN_REASON).toBeGreaterThanOrEqual(5);
  });
});

describe("the RPC call carries the override reason", () => {
  it("sends p_annual_override_reason only when there is one (a monthly quote still works before the migration)", async () => {
    const rpc = vi.fn(async () => ({ data: { already_active: false }, error: null }));
    await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false });
    expect(rpc).toHaveBeenLastCalledWith("activate_quote_on_credit", {
      p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: false,
    });
    await activateQuoteOnCredit({ rpc } as never, { quoteId: "Q1", days: 15, approveOverLimit: false, annualOverrideReason: "Known customer" });
    expect(rpc).toHaveBeenLastCalledWith("activate_quote_on_credit", {
      p_quote_id: "Q1", p_credit_days: 15, p_approve_over_limit: false, p_annual_override_reason: "Known customer",
    });
  });
});
