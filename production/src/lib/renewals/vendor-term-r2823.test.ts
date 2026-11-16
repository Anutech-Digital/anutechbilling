/* R-2823 — the vendor's own renewal date + the hold in words (Renewals 12-question audit, 14 Nov 2026). */
import { describe, it, expect } from "vitest";
import { formatDate } from "@/lib/utils";
import { vendorName, vendorHoldWords, vendorTermWords, hasVendorTerm } from "./vendor-hold";
import { renewalStage } from "./stage";

describe("vendorName / vendorHoldWords", () => {
  it("Google, Microsoft, Zoho by name; everything else 'vendor'", () => {
    expect(vendorName("google")).toBe("Google");
    expect(vendorName("microsoft")).toBe("Microsoft");
    expect(vendorName("zoho")).toBe("Zoho");
    expect(vendorName("domain")).toBeNull();
    expect(vendorName(null)).toBeNull();
    expect(vendorHoldWords("google")).toBe("Hold at Google — unpaid");
    expect(vendorHoldWords("microsoft")).toBe("Hold at Microsoft — unpaid");
    expect(vendorHoldWords("hosting")).toBe("Hold at vendor — unpaid");
    expect(vendorHoldWords(undefined)).toBe("Hold at vendor — unpaid");
  });

  it("only vendors with their own term get the date field", () => {
    expect(hasVendorTerm("google")).toBe(true);
    expect(hasVendorTerm("microsoft")).toBe(true);
    expect(hasVendorTerm("zoho")).toBe(true);
    expect(hasVendorTerm("domain")).toBe(false);
    expect(hasVendorTerm("other")).toBe(false);
  });
});

describe("vendorTermWords — drawer Terms line", () => {
  const sub = { vendor: "google", renewal_date: "2027-03-29", vendor_term_end: "2027-01-12" };
  const today = "2026-11-15";

  it("known and different → 'Google renews <date>'", () => {
    expect(vendorTermWords(sub, today)).toBe(`Google renews ${formatDate("2027-01-12")}`);
  });
  it("not known → nothing", () => {
    expect(vendorTermWords({ ...sub, vendor_term_end: null }, today)).toBeNull();
    expect(vendorTermWords({ vendor: "google", renewal_date: "2027-03-29" }, today)).toBeNull();
  });
  it("same as our renewal date → nothing (one fact one place)", () => {
    expect(vendorTermWords({ ...sub, vendor_term_end: "2027-03-29" }, today)).toBeNull();
  });
  it("passed → says so and where to fix it", () => {
    expect(vendorTermWords({ ...sub, vendor_term_end: "2026-11-01" }, today))
      .toBe(`Google renewal date ${formatDate("2026-11-01")} has passed — update it in Subscriptions → Correct details`);
  });
  it("vendor without a name → 'Vendor renews'", () => {
    expect(vendorTermWords({ ...sub, vendor: "other" }, today)).toBe(`Vendor renews ${formatDate("2027-01-12")}`);
  });
});

describe("Renewals row flag — the hold in words", () => {
  const annual = { status: "active", renewal_date: "2026-11-01", term_months: 12, billing_cycle: "yearly", start_date: "2025-11-01" };
  it("hold → flag carries 'Hold at Google — unpaid'", () => {
    const s = renewalStage({ sub: annual, todayIst: "2026-11-15", flags: { vendorHold: "hold", vendor: "google" } });
    const f = s.flags.find((x) => x.key === "vendorHold");
    expect(f?.words).toBe("Hold at Google — unpaid");
    expect(f?.reason).toBe("Payment due — do not renew at the vendor yet");
  });
  it("overridden (Renew anyway) → no hold flag, no words", () => {
    const s = renewalStage({ sub: annual, todayIst: "2026-11-15", flags: { vendorHold: "overridden", vendor: "google" } });
    expect(s.flags.find((x) => x.key === "vendorHold")).toBeUndefined();
  });
  it("other flags stay icon-only (no words)", () => {
    const s = renewalStage({ sub: annual, todayIst: "2026-11-15", flags: { followUpDue: { nextFollowUpOn: null } } });
    expect(s.flags[0].words).toBeUndefined();
  });
});
