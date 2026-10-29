/**
 * R-2070 (decision D4, 29 Oct 2026) — a SUPPORT plan whose invoice is more than 7 days past
 * its due date is paused (DSP then stops chat and calls; tickets stay open). Pure half.
 */
import { describe, it, expect } from "vitest";
import {
  SUPPORT_GRACE_DAYS,
  decideSupportOverduePause,
  isSupportItem,
  oldestOverdueInvoice,
} from "./overdue-suspension";

const oldest = (due: string, today: string) =>
  oldestOverdueInvoice([{ id: "INV-1", status: "overdue", amount: 999, net_payable: null, paid_amount: 0, due_date: due }], today);

describe("isSupportItem", () => {
  it("catalogue support SKUs (SUP-…) are support", () => {
    expect(isSupportItem("SUP-STANDARD-MO-d0000000000040008000000000000001")).toBe(true);
    expect(isSupportItem("SUP-ENTERPRISE-YR-x")).toBe(true);
  });
  it("anything else is not — Workspace, null, lower-case look-alikes", () => {
    expect(isSupportItem("GWS-BUSINESS-STARTER")).toBe(false);
    expect(isSupportItem(null)).toBe(false);
    expect(isSupportItem(undefined)).toBe(false);
    expect(isSupportItem("sup-standard-monthly-1")).toBe(false);
  });
});

describe("decideSupportOverduePause", () => {
  it("grace is 7 days", () => expect(SUPPORT_GRACE_DAYS).toBe(7));

  it("day 7 past due → nothing yet", () => {
    const d = decideSupportOverduePause({ subscriptionStatus: "active", oldest: oldest("2026-09-01", "2026-09-08") });
    expect(d.action).toBe("none");
    expect(d.pauseOn).toBe("2026-09-09");
  });

  it("day 8 past due → suspend, reason names the invoice", () => {
    const d = decideSupportOverduePause({ subscriptionStatus: "active", oldest: oldest("2026-09-01", "2026-09-09") });
    expect(d.action).toBe("suspend");
    expect(d.daysOverdue).toBe(8);
    expect(d.reason).toContain("INV-1");
    expect(d.reason).toContain("7 days");
  });

  it("no overdue invoice → nothing", () => {
    expect(decideSupportOverduePause({ subscriptionStatus: "active", oldest: null }).action).toBe("none");
  });

  it("already paused / cancelled / expired → left alone", () => {
    for (const s of ["paused", "cancelled", "expired"]) {
      expect(decideSupportOverduePause({ subscriptionStatus: s, oldest: oldest("2026-09-01", "2026-09-30") }).action).toBe("none");
    }
  });
});
