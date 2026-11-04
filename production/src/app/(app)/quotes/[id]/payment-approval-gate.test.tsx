// @vitest-environment jsdom
/**
 * R-2326 — a below-cost quote waiting for the owner's approval (localhost, 31 Oct, R2213 Approval
 * Test, Q-F588-27-0070): Record payment opened the form, filled the amount, enabled Confirm — and
 * only after Confirm did the server refuse ("This quote is below cost and waits for the owner's
 * approval…"). The header said "Sent" beside "Owner approval" while the Quotes list said
 * "Needs approval".
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recordPaymentBlock, quoteHeaderStatus, recordPaymentStep } from "./payment-approval-gate";
import { PaymentApprovalNotice } from "./payment-approval-notice";
import { belowCostRefusal } from "@/lib/quotes/payment-approval";

afterEach(cleanup);

const SENT = { kind: "warning" as const, label: "Sent" };
const base = {
  id: "Q-F588-27-0070",
  status: "sent" as const,
  payment_status: "awaiting" as const,
  amount: 1180,
  payment_amount: 0,
  expires_date: "2099-12-31",
  superseded_by: null,
  invoice_id: null,
};

describe("Record payment on a quote waiting for the owner (R-2326)", () => {
  it("below cost + pending → blocked with the server's own words", () => {
    const b = recordPaymentBlock({ ...base, below_cost: true, approval_status: "pending" });
    expect(b?.reason).toBe(belowCostRefusal("Q-F588-27-0070"));
    expect(b?.reason).toMatch(/below cost and waits for the owner's approval/);
  });

  it("clicking Record payment shows the notice instead of the form while blocked; the form once approved", () => {
    expect(recordPaymentStep(recordPaymentBlock({ ...base, below_cost: true, approval_status: "pending" }))).toBe("notice");
    expect(recordPaymentStep(recordPaymentBlock({ ...base, below_cost: true, approval_status: "approved" }))).toBe("form");
  });

  it("pending but NOT below cost → the form opens as today (the server takes that money)", () => {
    expect(recordPaymentBlock({ ...base, below_cost: false, approval_status: "pending" })).toBeNull();
  });

  it("header reads 'Needs approval' (the list's word), not 'Sent', while pending", () => {
    const s = quoteHeaderStatus({ ...base, below_cost: true, approval_status: "pending" }, SENT, "2026-11-01");
    expect(s.label).toBe("Needs approval");
    expect(s.kind).toBe("warning");
  });

  it("header keeps its own status once approved", () => {
    expect(quoteHeaderStatus({ ...base, below_cost: true, approval_status: "approved" }, SENT, "2026-11-01")).toEqual(SENT);
  });
});

describe("PaymentApprovalNotice", () => {
  it("names the reason and opens the approval", () => {
    const onOpen = vi.fn();
    render(<PaymentApprovalNotice reason={belowCostRefusal("Q-1")} onOpenApproval={onOpen} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Needs approval\..*below cost and waits for the owner's approval/);
    fireEvent.click(screen.getByRole("button", { name: "Open approval" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("quote page wiring (R-2326)", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");

  it("no Record payment button opens the form directly — each goes through the approval gate", () => {
    expect(page).not.toMatch(/onClick=\{\(\) => setPaymentOpen\(true\)\}/);
    expect((page.match(/onClick=\{onRecordPayment\}/g) ?? []).length).toBe(2);
  });

  it("?pay=1 also stops at the gate", () => {
    expect(page).toMatch(/if \(action === "open" && mayRecordMoney\) onRecordPayment\(\);/);
  });

  it("the header badge uses the list's rule", () => {
    expect(page).toMatch(/quoteHeaderStatus\(/);
    expect(page).toMatch(/<PaymentApprovalNotice/);
  });
});
