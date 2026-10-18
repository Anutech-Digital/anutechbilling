import { describe, it, expect } from "vitest";
import { deleteBlockAction } from "./delete-block";

describe("deleteBlockAction (R-1577)", () => {
  it("turns a known page hint into its button", () => {
    expect(deleteBlockAction({ message: "salary", hint: "/accounting/payroll" })).toEqual({ label: "Open Payroll", href: "/accounting/payroll" });
    expect(deleteBlockAction({ hint: "/accounting/payment-runs" })?.label).toBe("Open Payment Runs");
  });

  it("links straight to the bank account whose line must be un-reconciled", () => {
    const href = "/accounting/banking/15770000-0000-4000-8000-0000000000b1";
    expect(deleteBlockAction({ hint: href })).toEqual({ label: "Open bank account", href });
  });

  it("offers no button for anything else — the hint never becomes an arbitrary link", () => {
    expect(deleteBlockAction(new Error("boom"))).toBeNull();
    expect(deleteBlockAction({ hint: null })).toBeNull();
    expect(deleteBlockAction({ hint: "https://evil.example/accounting/payroll" })).toBeNull();
    expect(deleteBlockAction({ hint: "/accounting/banking/not-a-uuid" })).toBeNull();
    expect(deleteBlockAction({ hint: "//evil.example" })).toBeNull();
    expect(deleteBlockAction(null)).toBeNull();
  });
});
