import { describe, it, expect } from "vitest";
import { quoteListTab, quoteTabCounts } from "./list-tab";
import { unifiedStatus } from "./status-badge";
import { PAY_BY_PASSED_LABEL } from "@/lib/billing/proforma";

/* R-2851: /quotes must say what the quote page says (R-2846) about a payment request past its pay-by date. */
const TODAY = "2026-11-15";
const part = (over: Record<string, unknown> = {}) => ({
  status: "sent", payment_status: "awaiting", expires_date: "2026-11-07",
  subscription_billing_id: "SB-1", amount: 3835, payment_amount: 0, ...over,
});
const normal = (over: Record<string, unknown> = {}) => ({
  status: "sent", payment_status: "none", expires_date: "2026-11-07", amount: 3835, payment_amount: 0, ...over,
});

describe("unpaid payment request past its pay-by date (R-2851)", () => {
  it("badge reads the same amber words as the quote page", () => {
    expect(unifiedStatus(part() as never, TODAY)).toEqual({ label: PAY_BY_PASSED_LABEL, kind: "warning" });
  });
  it("sits in Awaiting payment, not Expired", () => {
    expect(quoteListTab(part() as never, TODAY)).toBe("awaiting");
    expect(quoteListTab(part({ status: "expired" }) as never, TODAY)).toBe("awaiting");
  });
  it("Expired tab count excludes it; counts still add up to All", () => {
    const rows = [part(), normal()] as never[];
    const c = quoteTabCounts(rows);
    expect(c.expired).toBe(1);
    expect(c.awaiting + c.expired).toBe(2);
    expect(c.all).toBe(2);
  });
  it("a request still inside its validity is unchanged", () => {
    expect(unifiedStatus(part({ expires_date: "2026-12-01" }) as never, TODAY).label).not.toBe(PAY_BY_PASSED_LABEL);
  });
  it("a paid / invoiced request is not touched", () => {
    expect(unifiedStatus(part({ payment_status: "partial", payment_amount: 100 }) as never, TODAY).label).toBe("Partly paid");
    expect(quoteListTab(part({ invoice_id: "INV-1", payment_status: "invoiced" }) as never, TODAY)).toBe("awaiting");
  });
});

describe("a normal quote past its validity is unchanged (R-2851)", () => {
  it("still Expired in badge and tab", () => {
    expect(unifiedStatus(normal() as never, TODAY)).toEqual({ label: "Expired", kind: "danger" });
    expect(quoteListTab(normal() as never, TODAY)).toBe("expired");
  });
});
